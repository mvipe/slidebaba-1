/**
 * HTML-table text <-> table element.
 *
 * WHY THIS EXISTS
 *   PaddleOCR's PP-StructureV3 recognises tables and emits them as real `<table>` markup,
 *   and lib/ocrStructure.js deliberately preserves that markup through every regex pass
 *   (see `maskProtected`). But the markup then landed in a TEXT element's `content`, and
 *   components/Katex.js escapes every tag it does not whitelist — so a recognised table
 *   was displayed as literal "&lt;table&gt;&lt;tr&gt;&lt;td&gt;…" on the slide, in the
 *   preview, in the PDF and in the PPTX.
 *
 *   The structure was there the whole time; it just had nowhere to land. This module is
 *   the landing place: it splits OCR text into prose and tables, and parses the markup
 *   into the rows a `type: "table"` element holds.
 *
 * The parser is deliberately regex-based rather than DOMParser-based: it runs during
 * slide building, which happens on the server as well as in the browser.
 */

const TABLE_RE = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_RE = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/gi;

/** Decode the handful of entities OCR output actually contains. */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

/** One cell's inner HTML -> the plain text (plus $math$) a cell stores. */
function cellText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")       // strip any remaining inline markup
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const spanOf = (attrs, name) => {
  const m = new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i").exec(attrs || "");
  const n = m ? parseInt(m[1], 10) : 1;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30) : 1;
};

/**
 * Parse one `<table>…</table>` into a rectangular grid.
 *
 * colspan/rowspan are EXPANDED by repeating the cell's text rather than preserved.
 * A slide table is a display surface, not a spreadsheet, and a ragged grid breaks both
 * the fixed-layout CSS and pptxgenjs's addTable. Repeating keeps every word on the slide,
 * which is the property that matters for an exam paper.
 *
 * @returns {{rows: string[][], header: boolean} | null}
 */
export function parseHtmlTable(html) {
  const inner = String(html || "").replace(/^[\s\S]*?<table\b[^>]*>/i, "").replace(/<\/table>[\s\S]*$/i, "");
  const rows = [];
  const pending = new Map();   // column index -> { text, rowsLeft } from a rowspan above

  ROW_RE.lastIndex = 0;
  let rowMatch;
  let sawHeaderTag = false;

  while ((rowMatch = ROW_RE.exec(inner))) {
    const cells = [];
    let col = 0;

    // Re-place any cell still spanning down from an earlier row.
    const placePending = () => {
      while (pending.has(col)) {
        const p = pending.get(col);
        cells[col] = p.text;
        p.rowsLeft -= 1;
        if (p.rowsLeft <= 0) pending.delete(col);
        col += 1;
      }
    };

    CELL_RE.lastIndex = 0;
    let cellMatch;
    while ((cellMatch = CELL_RE.exec(rowMatch[1]))) {
      const [, tag, attrs, body] = cellMatch;
      if (tag.toLowerCase() === "th") sawHeaderTag = true;
      placePending();

      const text = cellText(body);
      const cs = spanOf(attrs, "colspan");
      const rs = spanOf(attrs, "rowspan");
      for (let k = 0; k < cs; k++) {
        cells[col] = text;
        if (rs > 1) pending.set(col, { text, rowsLeft: rs - 1 });
        col += 1;
      }
    }
    placePending();

    if (cells.length) rows.push(Array.from(cells, (c) => c ?? ""));
  }

  if (!rows.length) return null;

  const cols = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => (r.length === cols ? r : [...r, ...Array(cols - r.length).fill("")]));

  // Drop rows that are entirely empty — OCR often emits a trailing blank row.
  const trimmed = grid.filter((r) => r.some((c) => c.trim()));
  if (!trimmed.length) return null;

  // Treat row 1 as a header when the markup says so, or when it looks like one:
  // every cell filled, all short, and no digits-only cells (those are data).
  const first = trimmed[0];
  const looksLikeHeader =
    trimmed.length > 1 &&
    first.every((c) => c.trim()) &&
    first.every((c) => c.length <= 40) &&
    !first.every((c) => /^[\d.,\s%₹$-]+$/.test(c));

  return { rows: trimmed, header: sawHeaderTag || looksLikeHeader };
}

/** True when this text contains at least one table. */
export function hasHtmlTable(text) {
  return /<table\b/i.test(String(text || ""));
}

/**
 * Split OCR text into an ordered list of prose and table pieces.
 *
 * @returns {Array<{kind:"text", text:string} | {kind:"table", rows:string[][], header:boolean}>}
 */
export function splitTextAndTables(text) {
  const src = String(text || "");
  if (!hasHtmlTable(src)) return src.trim() ? [{ kind: "text", text: src }] : [];

  const parts = [];
  let last = 0;
  TABLE_RE.lastIndex = 0;
  let m;

  const pushText = (raw) => {
    const t = String(raw || "").replace(/\n{3,}/g, "\n\n").trim();
    if (t) parts.push({ kind: "text", text: t });
  };

  while ((m = TABLE_RE.exec(src))) {
    pushText(src.slice(last, m.index));
    const parsed = parseHtmlTable(m[0]);
    if (parsed) parts.push({ kind: "table", ...parsed });
    else pushText(cellText(m[1]));   // unparseable — keep the words rather than the markup
    last = m.index + m[0].length;
  }
  pushText(src.slice(last));

  return parts;
}

/** Plain-text rendering of a table, for places that cannot show one (DOCX, alt text). */
export function tableToPlainText(rows) {
  return (rows || []).map((r) => r.join("\t")).join("\n");
}
