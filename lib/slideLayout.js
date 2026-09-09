"use client";

// Turns OCR "items" (one per question) into slides whose text is SIZED TO FIT the slide.
//
// Why this exists: the naive builder dropped every question into a fixed box at a fixed font
// size, so long questions overflowed the slide. On screen the editor box grows and shows it,
// but the PDF/PPTX exporter clips at the slide edge — so text got "cut" on download.
//
// Here we MEASURE the rendered text (same KaTeX renderer + fonts the editor/exporter use) and:
//   1. shrink the body font until the whole question fits the slide, else
//   2. split it across "(cont.)" slides at a readable font.
// The chosen size is baked into the element, so the editor preview and the export match exactly.

import { renderMixed } from "@/components/Katex";
import { uid, newText, newTable, slidesFromItems, DEFAULT_THEME } from "@/lib/slideStore";
import { splitTextAndTables, hasHtmlTable } from "@/lib/tableText";

// Design space = the editor's canvas (896px wide, 16:9). All boxes are in %, so measuring here
// at the design width gives the same line-wrapping the exporter produces at its larger width.
const DESIGN_W = 896;
const DESIGN_H = (DESIGN_W * 9) / 16; // 504

// Body box: x:6 y:24 w:88, growing down. Keep a bottom safety margin so nothing kisses the edge.
const BODY_W_PX = (88 / 100) * DESIGN_W;
const BODY_TOP = 24;
const BODY_BOTTOM = 92;
const BODY_AVAIL_PX = ((BODY_BOTTOM - BODY_TOP) / 100) * DESIGN_H;

// Title box: x:6 y:7 w:88 h:12.
const TITLE_AVAIL_PX = (12 / 100) * DESIGN_H;

const BODY_MAX = 22, BODY_MIN_SINGLE = 15, SPLIT_FONT = 15, BODY_FLOOR = 10;
const TITLE_MAX = 28, TITLE_MIN = 17;

async function fontsReady() {
  try { if (typeof document !== "undefined" && document.fonts?.ready) await document.fonts.ready; } catch {}
}

// Rendered height (px) of `text` in a box `widthPx` wide at `fontSize`, mirroring the editor/export CSS.
function measureHeight(text, widthPx, fontSize, { bold = false, fontFamily = "Inter" } = {}) {
  const d = document.createElement("div");
  d.className = "kx";
  d.style.cssText =
    `position:absolute;left:-99999px;top:0;visibility:hidden;width:${widthPx}px;` +
    `font-size:${fontSize}px;font-family:${fontFamily},sans-serif;font-weight:${bold ? 700 : 400};` +
    `line-height:1.35;white-space:pre-wrap;padding:2px 6px;box-sizing:border-box;`;
  d.innerHTML = renderMixed(text || "");
  document.body.appendChild(d);
  const h = d.scrollHeight;
  document.body.removeChild(d);
  return h;
}

// Largest font in [min..max] whose text fits `availPx`; falls back to min.
function fitFont(text, widthPx, availPx, max, min, opts) {
  for (let f = max; f > min; f--) if (measureHeight(text, widthPx, f, opts) <= availPx) return f;
  return min;
}

function makeSlide(title, body, bodyFont, titleFont, theme) {
  return {
    id: uid("slide"),
    theme,
    elements: [
      newText({ content: title, x: 6, y: 7, w: 88, h: 12, fontSize: titleFont, fontFamily: "Sora", bold: true }),
      newText({ content: body, x: 6, y: 24, w: 88, h: 66, fontSize: bodyFont }),
    ],
  };
}

/**
 * Measure a table the same way text is measured — by rendering it and reading its height.
 * Without this a table would be sized by guesswork and either clip or leave a huge gap.
 */
function measureTableHeight(rows, widthPx, fontSize) {
  const d = document.createElement("div");
  d.style.cssText = `position:absolute;left:-99999px;top:0;visibility:hidden;width:${widthPx}px;`;
  const cells = (r) => r.map((c) => `<td style="border:1px solid #94a3b8;padding:5px 8px;word-break:break-word;">${renderMixed(String(c || ""))}</td>`).join("");
  d.innerHTML = `<table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:${fontSize}px;line-height:1.35;font-family:Inter,sans-serif;">` +
    rows.map((r) => `<tr>${cells(r)}</tr>`).join("") + "</table>";
  document.body.appendChild(d);
  const h = d.scrollHeight;
  document.body.removeChild(d);
  return h;
}

/**
 * A question that contains a table becomes ONE slide holding stacked elements, each
 * measured and given exactly the vertical share it needs.
 *
 * Splitting a table across "(cont.)" slides is deliberately not attempted: half a table is
 * worse than a small one, so if the whole thing cannot fit, the font shrinks instead.
 */
function tableItemToSlides(item, idx, theme) {
  const title = item.title || `Q${idx + 1}`;
  const titleFont = fitFont(title, BODY_W_PX, TITLE_AVAIL_PX, TITLE_MAX, TITLE_MIN, { bold: true, fontFamily: "Sora" });
  const parts = splitTextAndTables(String(item.text || ""));

  // Shrink both fonts together until every piece fits the body band.
  let textFont = BODY_MAX;
  let tableFont = 16;
  let heights = [];
  for (; textFont >= BODY_FLOOR; textFont--, tableFont = Math.max(9, Math.min(tableFont, textFont - 2))) {
    heights = parts.map((p) =>
      p.kind === "table"
        ? measureTableHeight(p.rows, BODY_W_PX, tableFont)
        : measureHeight(p.text, BODY_W_PX, textFont));
    if (heights.reduce((a, b) => a + b, 0) <= BODY_AVAIL_PX) break;
  }

  const totalPx = Math.max(1, heights.reduce((a, b) => a + b, 0));
  const scale = Math.min(1, BODY_AVAIL_PX / totalPx);
  let cursor = BODY_TOP;
  const elements = [
    newText({ content: title, x: 6, y: 7, w: 88, h: 12, fontSize: titleFont, fontFamily: "Sora", bold: true }),
  ];

  parts.forEach((p, i) => {
    const hPct = ((heights[i] * scale) / DESIGN_H) * 100;
    if (p.kind === "table") {
      elements.push(newTable({ rows: p.rows, header: p.header, x: 6, y: cursor, w: 88, h: Math.max(6, hPct), fontSize: Math.max(9, tableFont) }));
    } else {
      elements.push(newText({ content: p.text, x: 6, y: cursor, w: 88, h: Math.max(5, hPct), fontSize: Math.max(BODY_FLOOR, textFont) }));
    }
    cursor += hPct;
  });

  return [{ id: uid("slide"), theme, elements }];
}

// One item -> one or more slides, each fitted so nothing overflows.
function itemToSlides(item, idx, theme) {
  // A question containing a recognised table takes the stacked-element path.
  if (hasHtmlTable(item?.text)) {
    try { return tableItemToSlides(item, idx, theme); }
    catch { /* fall through to plain text below rather than losing the question */ }
  }

  const title = item.title || `Q${idx + 1}`;
  const text = String(item.text || "");
  const titleFont = fitFont(title, BODY_W_PX, TITLE_AVAIL_PX, TITLE_MAX, TITLE_MIN, { bold: true, fontFamily: "Sora" });

  // 1) Try to keep the whole question on ONE slide, shrinking the font a little if needed.
  for (let f = BODY_MAX; f >= BODY_MIN_SINGLE; f--) {
    if (measureHeight(text, BODY_W_PX, f) <= BODY_AVAIL_PX) return [makeSlide(title, text, f, titleFont, theme)];
  }

  // 2) Too long even at the smallest single-slide size — split across slides at a readable font.
  const lines = text.split("\n");
  const chunks = [];
  let cur = [];
  for (const line of lines) {
    if (cur.length && measureHeight([...cur, line].join("\n"), BODY_W_PX, SPLIT_FONT) > BODY_AVAIL_PX) {
      chunks.push(cur.join("\n"));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) chunks.push(cur.join("\n"));

  return chunks.map((chunk, k) => {
    // Safety net for a single line so long it alone overflows: shrink just that slide's font.
    let f = SPLIT_FONT;
    while (f > BODY_FLOOR && measureHeight(chunk, BODY_W_PX, f) > BODY_AVAIL_PX) f--;
    return makeSlide(k ? `${title} (cont.)` : title, chunk, f, titleFont, theme);
  });
}

// Public: build fitted slides. Async because it waits for web fonts so measurements are accurate.
export async function buildFittedSlides(items, theme = DEFAULT_THEME) {
  const list = Array.isArray(items) ? items : [];
  // slidesFromItems() is table-aware too, so the no-DOM path never emits raw <table> markup.
  if (typeof document === "undefined") return slidesFromItems(list, theme); // SSR / no DOM
  await fontsReady();
  try {
    const slides = [];
    list.forEach((it, i) => { for (const s of itemToSlides(it, i, theme)) slides.push(s); });
    return slides.length ? slides : slidesFromItems(list, theme);
  } catch {
    return slidesFromItems(list, theme); // never block export on a measurement hiccup
  }
}
