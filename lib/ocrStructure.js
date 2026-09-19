/**
 * SlideBaba — document structuring engine (pure JS, no network, no AI).
 * ---------------------------------------------------------------------------
 * Turns raw PaddleOCR output into the shapes the app already speaks:
 *
 *   buildDocument(paddleResult, fallbackTitle) -> { title, sections:[{heading, body}] }
 *   splitSectionsIntoItems(title, sections)    -> [{ title, text }]   (one per slide)
 *
 * Strategy — layout first, rules as fallback (both always run):
 *   1. LAYOUT  PaddleOCR-VL / PP-StructureV3 return `parsing_res_list` blocks with
 *              semantic labels (doc_title, paragraph_title, text, formula, table,
 *              header, footer, page number...). Titles force a section boundary and
 *              running heads / page numbers are dropped. When no blocks exist we fall
 *              back to the markdown the model produced, then to raw recognised lines.
 *   2. RULES   A script-aware pass then splits the linear text into ONE section per
 *              question / sub-question, keeping every answer option attached to its
 *              own stem.
 *
 * Everything is verbatim: nothing is translated, summarised, reworded or capped.
 * Devanagari stays Devanagari, LaTeX stays LaTeX, and no item limit is applied.
 */

/* -------------------------------------------------------------------------- */
/* unicode ranges                                                              */
/* -------------------------------------------------------------------------- */

const DEV_VOWEL = "\u0905-\u0914";      // अ – औ
const DEV_CONS = "\u0915-\u0939";       // क – ह
const DEV_DIGIT = "\u0966-\u096F";      // ० – ९

/* -------------------------------------------------------------------------- */
/* text normalisation                                                          */
/* -------------------------------------------------------------------------- */

const DOLLAR = () => "$";
const DOLLAR2 = () => "$$";

/** Clean OCR markdown into plain text that still carries LaTeX and tables. */
export function normalizeText(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/!\[[^\]]*\]\([^)\s]*\s*[^)]*\)/g, "");   // markdown images
  s = s.replace(/<img\b[^>]*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(?:p|div|span|font)\b[^>]*>/gi, "");
  s = s.replace(/\\\(/g, DOLLAR).replace(/\\\)/g, DOLLAR);
  s = s.replace(/\\\[/g, DOLLAR2).replace(/\\\]/g, DOLLAR2);
  s = s.replace(/\u00a0/g, " ");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/[ \t]+$/gm, "");
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, "");                // horizontal rules
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/* --- math / table masking ------------------------------------------------- */
// Option and question markers use round brackets, and so does maths ( f(x), (1) ).
// Every regex pass below therefore runs on text whose maths and HTML tables have
// been swapped for opaque placeholders, then restored untouched.

const MASK_OPEN = "\u0001";
const MASK_CLOSE = "\u0002";

export function maskProtected(text) {
  const store = [];
  const keep = (m) => `${MASK_OPEN}${store.push(m) - 1}${MASK_CLOSE}`;
  let s = String(text == null ? "" : text);
  s = s.replace(/<table\b[\s\S]*?<\/table>/gi, keep);
  s = s.replace(/\$\$[\s\S]*?\$\$/g, keep);
  s = s.replace(/\$[^$\n]*\$/g, keep);
  s = s.replace(/`[^`\n]*`/g, keep);
  return { masked: s, store };
}

export function unmaskProtected(text, store) {
  return String(text == null ? "" : text).replace(
    new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "g"),
    (_, i) => store[Number(i)] ?? ""
  );
}

const stripMasks = (text) =>
  String(text == null ? "" : text).replace(new RegExp(`${MASK_OPEN}\\d+${MASK_CLOSE}`, "g"), " ");

/* -------------------------------------------------------------------------- */
/* marker families                                                             */
/* -------------------------------------------------------------------------- */

const FAMILIES = [
  { id: "upper", symbols: ["A", "B", "C", "D", "E", "F", "G", "H"] },
  { id: "lower", symbols: ["a", "b", "c", "d", "e", "f", "g", "h"] },
  { id: "roman", symbols: ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"] },
  { id: "romanU", symbols: ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"] },
  { id: "devCons", symbols: ["\u0915", "\u0916", "\u0917", "\u0918", "\u0919", "\u091A"] },   // क ख ग घ ङ च
  { id: "devVowel", symbols: ["\u0905", "\u0906", "\u0907", "\u0908", "\u0909", "\u090A"] },  // अ आ इ ई उ ऊ
  { id: "devABCD", symbols: ["\u0905", "\u092C", "\u0938", "\u0926"] },                        // अ ब स द
  { id: "digit", symbols: ["1", "2", "3", "4", "5", "6", "7", "8"] },
  { id: "devDigit", symbols: ["\u0967", "\u0968", "\u0969", "\u096A", "\u096B", "\u096C"] },   // १ २ ३ ४ ५ ६
  { id: "bengali", symbols: ["\u0995", "\u0996", "\u0997", "\u0998"] },                        // ক খ গ ঘ
  { id: "gujarati", symbols: ["\u0A95", "\u0A96", "\u0A97", "\u0A98"] },
  { id: "telugu", symbols: ["\u0C05", "\u0C06", "\u0C07", "\u0C08"] },
  { id: "tamil", symbols: ["\u0B85", "\u0B86", "\u0B87", "\u0B88"] },
  { id: "arabic", symbols: ["\u0623", "\u0628", "\u062C", "\u062F"] },
];

const FAMILY_INDEX = new Map();
for (const f of FAMILIES) {
  f.symbols.forEach((sym, i) => {
    if (!FAMILY_INDEX.has(sym)) FAMILY_INDEX.set(sym, []);
    FAMILY_INDEX.get(sym).push({ family: f.id, index: i });
  });
}

/** All (family, index) readings of a marker symbol. Empty = not a known marker. */
export function symbolFamilies(sym) {
  return FAMILY_INDEX.get(sym) || [];
}

/* -------------------------------------------------------------------------- */
/* line markers                                                                */
/* -------------------------------------------------------------------------- */

// "प्रश्न 12", "प्र० 3", "प्रश्न सं. 4", "सवाल 2", "Question 7", "Q.15", "Qn 2"
const RE_QUESTION_WORD = new RegExp(
  "^[\\s>*_#]*" +
    "(?:(?:\u092A\u094D\u0930\u0936\u094D\u0928|\u092A\u094D\u0930\u0936\u094D\u200D\u0928|\u0938\u0935\u093E\u0932|" +
    "\u0633\u0648\u0627\u0644|\u09AA\u09CD\u09B0\u09B6\u09CD\u09A8|\u0AAA\u0ACD\u0AB0\u0AB6\u0ACD\u0AA8|\u0BB5\u0BBF\u0BA9\u0BBE|" +
    "\u092A\u094D\u0930[\u0966\u0966o0\u0970.\u00b0]?)" +
    "\\s*(?:\u0938\u0902\u0916\u094D\u092F\u093E|\u0938\u0902\\.?|No\\.?)?" +
    "|(?:Question|Ques|Qn|Q))" +
    "\\s*[-\u2013\u2014.:\u0964)]*\\s*" +
    "([0-9" + DEV_DIGIT + "]{1,3})" +
    "\\s*[.)\\]\u0964\u06D4\u3002:\u2013\u2014-]?\\s*",
  "u"
);

// "12." / "12)" / "(12)" / "१२." at the start of a line
const RE_NUMBERED = new RegExp(
  "^[\\s>*_#]*\\(?\\s*([0-9" + DEV_DIGIT + "]{1,3})\\s*[).\\]\u0964:]\\s+",
  "u"
);

// "(A)" / "[क]" / "A." / "iii)" / "अ -" at the start of a line
const RE_LABEL = new RegExp(
  "^[\\s>*_#]*" +
    "(?:(\\()|(\\[)|(\u3010))?" +
    "\\s*([A-Za-z]{1,4}|[" + DEV_VOWEL + DEV_CONS + "]|[0-9" + DEV_DIGIT + "]{1,2}|" +
    "[\u0995-\u09B9]|[\u0A95-\u0AB9]|[\u0C05-\u0C39]|[\u0B85-\u0BB9]|[\u0623-\u064A])\\s*" +
    "(?:\\)|\\]|\u3011|\\.|:|,|\u0964|\u06D4|-|\u2013|\u2014)\\s*",
  "u"
);

// A top-level numbered QUESTION: an UN-bracketed number ("3." / "12)" / "१२.") followed
// by real stem text on the same line. This must be told apart from an answer-option marker
// like "(A)" or a numbered option value, because RE_LABEL above also matches a bare "3." —
// and when it wins, the question's number is treated as an option label and its stem gets
// separated from it. That is exactly what left slides showing only "(A)(B)(C)(D)" with the
// question text missing. The stem guard (looksLikeStem) keeps genuine numbered-list options
// ("1. 25  2. 50 ...") classified as options, not questions.
const RE_NUM_QUESTION = new RegExp(
  "^[\\s>*_#]*([0-9" + DEV_DIGIT + "]{1,3})\\s*[).।]\\s+(\\S[\\s\\S]*)$",
  "u"
);

/** The text after a leading number looks like a question stem, not a short option value. */
function looksLikeStem(rest) {
  const t = String(rest || "").trim();
  if (!t) return false;
  if (/[?？]/.test(t)) return true;               // a question mark anywhere = a stem
  return t.replace(/\s+/g, "").length >= 14;          // longer than a typical option value
}

const RE_MD_HEADING = /^\s*(#{1,6})\s+(.*)$/;

// Section-level headings that must never be glued onto the previous question.
// (\b is ASCII-only, so the Devanagari alternatives use an explicit delimiter instead.)
const RE_SECTION_WORD = new RegExp(
  "^[\\s>*_#]*(?:" +
    "\u0916\u0923\u094D\u0921|\u0916\u0902\u0921|\u092D\u093E\u0917|\u0905\u0928\u0941\u092D\u093E\u0917|" +
    "\u0928\u093F\u0930\u094D\u0926\u0947\u0936|\u0938\u0942\u091A\u0928\u093E|\u0905\u0928\u0941\u091A\u094D\u091B\u0947\u0926|\u0928\u094B\u091F|" +
    "Sections?|Parts?|Group|Unit|Chapter|Instructions?|Note|Passage|Paragraphs?|Directions?" +
  ")(?:[\\s:.\u0964\\-\u2013\u2014(\\[]|$)",
  "iu"
);

// Answer options are short. A long labelled block is a sub-question with its own stem.
const OPTION_MAX_CHARS = 160;   // runs of 3+ markers
const OPTION_MAX_CHARS_PAIR = 80; // a run of only 2 markers needs stronger evidence

// Answer options come in small sets. A LONG ascending run is a numbered list of
// sub-questions (e.g. "integrate functions 1 to 23", each its own slide), NOT one
// question's options — merging them was what put 20+ questions on a single slide.
const OPTION_MAX_RUN = 6;          // (A)–(F) / (1)–(6): the most an option set realistically has
const OPTION_MAX_RUN_PLAIN_NUM = 4; // un-bracketed "1. 2. 3. ..." past 4 is almost always a question list

/**
 * Classify one line.
 * kind: "question" | "label" | "heading" | "body"
 */
export function detectMarker(rawLine) {
  const line = String(rawLine == null ? "" : rawLine);
  const trimmed = line.trim();
  if (!trimmed) return { kind: "body", rest: "" };

  const md = trimmed.match(RE_MD_HEADING);
  if (md) {
    const inner = md[2].trim();
    const sub = detectMarker(inner);
    if (sub.kind === "question") return { ...sub, headingLevel: md[1].length };
    return { kind: "heading", rest: inner, headingLevel: md[1].length };
  }

  const q = trimmed.match(RE_QUESTION_WORD);
  if (q) {
    return { kind: "question", number: q[1], label: trimmed.slice(0, q[0].length).trim().replace(/[\s.:\u0964)-]+$/u, ""), rest: trimmed.slice(q[0].length) };
  }

  // Numbered question WITH a stem ("3. \u092e\u0902\u0917\u092e\u094d\u092e\u093e \u0915\u093f\u0938 \u092d\u093e\u0937\u093e \u0915\u0940 \u0915\u0939\u093e\u0928\u0940 \u0939\u0948?") \u2014 checked before
  // RE_LABEL so the number is not mistaken for an "(A)"-style option marker, which would
  // strip the stem off the question and leave a slide of bare options.
  const nq = trimmed.match(RE_NUM_QUESTION);
  if (nq && looksLikeStem(nq[2])) {
    const number = nq[1];
    return { kind: "question", number, numeric: true, label: String(number), rest: nq[2], families: symbolFamilies(number) };
  }

  const lab = trimmed.match(RE_LABEL);
  if (lab) {
    const bracketed = Boolean(lab[1] || lab[2] || lab[3]);
    const sym = lab[4];
    const fams = symbolFamilies(sym);
    const rest = trimmed.slice(lab[0].length);
    // An unknown symbol in brackets is still a marker (covers scripts we do not enumerate).
    if (fams.length || (bracketed && sym.length <= 3)) {
      return { kind: "label", symbol: sym, bracketed, families: fams, rest, raw: lab[0].trim() };
    }
  }

  const num = trimmed.match(RE_NUMBERED);
  if (num) {
    const sym = num[1];
    return { kind: "question", number: sym, numeric: true, label: trimmed.slice(0, num[0].length).trim().replace(/[\s.:\u0964)-]+$/u, ""), rest: trimmed.slice(num[0].length), families: symbolFamilies(sym) };
  }

  if (RE_SECTION_WORD.test(trimmed) && trimmed.length <= 120) {
    return { kind: "heading", rest: trimmed };
  }

  return { kind: "body", rest: trimmed };
}

/* -------------------------------------------------------------------------- */
/* inline option splitting                                                     */
/* -------------------------------------------------------------------------- */

const INLINE_MARKER_RE = new RegExp(
  "\\(\\s*([A-Za-z]{1,4}|[" + DEV_VOWEL + DEV_CONS + "]|[0-9" + DEV_DIGIT + "]{1,2})\\s*\\)",
  "gu"
);

/**
 * "(A) 12 (B) 14 (C) 16 (D) 18" -> one option per line.
 * Runs on masked text, so maths like $f(x)$ can never be touched.
 */
export function splitInlineOptions(maskedLine) {
  const line = String(maskedLine == null ? "" : maskedLine);
  INLINE_MARKER_RE.lastIndex = 0;
  const hits = [];
  let m;
  while ((m = INLINE_MARKER_RE.exec(line))) hits.push({ sym: m[1], start: m.index, end: m.index + m[0].length });
  if (hits.length < 3) return [line];

  const best = bestFamilyForRun(hits.map((h) => h.sym));
  if (!best || best.matched < 3) return [line];

  const out = [];
  const head = line.slice(0, hits[0].start).trim();
  if (head) out.push(head);
  hits.forEach((h, i) => {
    const tail = line.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : line.length).trim();
    out.push(`(${h.sym}) ${tail}`.trim());
  });
  return out;
}

/**
 * Which family explains a sequence of symbols best?
 * Options run in order from the family's first (or occasionally second) symbol.
 */
export function bestFamilyForRun(symbols) {
  let best = null;
  for (const f of FAMILIES) {
    const idx = symbols.map((s) => f.symbols.indexOf(s));
    if (idx[0] > 1 || idx[0] < 0) continue;
    let matched = 1;
    for (let i = 1; i < idx.length; i++) {
      if (idx[i] === idx[i - 1] + 1) matched++;
      else break;
    }
    if (!best || matched > best.matched) best = { family: f.id, matched, start: idx[0] };
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* linearisation: PaddleOCR result -> annotated lines                          */
/* -------------------------------------------------------------------------- */

const TITLE_LABELS = new Set(["doc_title", "title", "document_title"]);
const HEADING_LABELS = new Set([
  "paragraph_title", "section_title", "chapter_title", "sub_title", "subtitle",
  "figure_title", "table_title", "chart_title", "abstract_title", "heading",
]);
const FORMULA_LABELS = new Set(["formula", "equation", "formula_number", "display_formula"]);
const TABLE_LABELS = new Set(["table", "table_body"]);
const SKIP_LABELS = new Set([
  "image", "figure", "chart", "picture", "img", "seal", "stamp",
  "header", "footer", "page_number", "number", "aside_text", "vision_footnote",
]);

/** Sort blocks top-to-bottom, then left-to-right (column aware). */
function sortBlocks(blocks) {
  const withBox = blocks.filter((b) => Array.isArray(b.bbox) && b.bbox.length >= 4);
  if (withBox.length < blocks.length * 0.6) return blocks;  // boxes unreliable — keep API order

  const xs = withBox.map((b) => Number(b.bbox[0]) || 0);
  const maxX = Math.max(...xs, 1);
  const twoColumn = xs.some((x) => x > maxX * 0.45);
  const keyed = blocks.map((b, i) => {
    const bbox = Array.isArray(b.bbox) && b.bbox.length >= 4 ? b.bbox.map(Number) : null;
    const x = bbox ? bbox[0] : 0;
    const y = bbox ? bbox[1] : i;
    const col = twoColumn && x > maxX * 0.45 ? 1 : 0;
    return { b, i, col, y };
  });
  keyed.sort((p, q) => (p.col - q.col) || (p.y - q.y) || (p.i - q.i));
  return keyed.map((k) => k.b);
}

/**
 * Layout-first linearisation. Returns { title, units } where each unit is
 * { type: "heading" | "text", text }.
 */
function unitsFromBlocks(blocks) {
  const units = [];
  let title = "";
  for (const b of sortBlocks(blocks)) {
    const label = String(b.label || "text").toLowerCase();
    if (SKIP_LABELS.has(label)) continue;
    let text = normalizeText(b.content);
    if (!text) continue;

    if (TITLE_LABELS.has(label)) {
      if (!title) { title = text.replace(/^#+\s*/, "").trim(); continue; }
      units.push({ type: "heading", text });
      continue;
    }
    if (HEADING_LABELS.has(label)) { units.push({ type: "heading", text: text.replace(/^#+\s*/, "").trim() }); continue; }
    if (FORMULA_LABELS.has(label)) {
      if (!text.includes("$")) text = `$$${text}$$`;
      units.push({ type: "text", text });
      continue;
    }
    if (TABLE_LABELS.has(label)) { units.push({ type: "text", text }); continue; }
    units.push({ type: "text", text });
  }
  return { title, units };
}

/** Markdown fallback — headings become boundaries just like layout titles. */
function unitsFromMarkdown(markdown) {
  const units = [];
  let title = "";
  const lines = normalizeText(markdown).split("\n");
  let buf = [];
  const flush = () => { const t = buf.join("\n").trim(); if (t) units.push({ type: "text", text: t }); buf = []; };

  // Is the next non-blank line an answer option? Then the current heading is a question
  // stem, not a heading — the single most reliable signal, and script-independent.
  const nextIsOption = (from) => {
    for (let k = from + 1; k < lines.length; k++) {
      const t = lines[k].trim();
      if (!t) continue;
      const m2 = t.match(RE_MD_HEADING);
      return detectMarker((m2 ? m2[2] : t).trim()).kind === "label";
    }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const md = line.match(RE_MD_HEADING);
    if (md) {
      const inner = md[2].trim();
      // A heading that is really a QUESTION STEM must stay with its question rather than
      // become a document title or section heading — otherwise the stem is split off from
      // the options printed under it and the slide shows only "(A)(B)(C)(D)". It is a stem
      // when it parses as a question ("# प्रश्न 3", "## 7. ..."), OR it ends with a question
      // mark, OR the next content line is an answer option.
      const isQuestionStem =
        detectMarker(inner).kind === "question" ||
        /[?？]\s*$/.test(inner) ||
        nextIsOption(i);
      if (isQuestionStem) { buf.push(inner); continue; }
      flush();
      if (!title && !units.length) title = inner;   // first heading on the page = document title
      else units.push({ type: "heading", text: inner });
      continue;
    }
    buf.push(line);
  }
  flush();
  return { title, units };
}

function unitsFromLines(lines) {
  const text = normalizeText((lines || []).map((l) => l.text).join("\n"));
  return { title: "", units: text ? [{ type: "text", text }] : [] };
}

/* -------------------------------------------------------------------------- */
/* rules pass: annotated lines -> sections                                     */
/* -------------------------------------------------------------------------- */

/**
 * Expand units into masked lines carrying a boundary hint from the layout.
 * @returns {{lines: Array<{text:string, forceHeading:boolean}>, store: Array}}
 */
function unitsToLines(units) {
  const joined = units
    .map((u) => (u.type === "heading" ? `${MASK_OPEN}H${MASK_CLOSE}${u.text}` : u.text))
    .join("\n\n");
  const { masked, store } = maskProtected(joined);

  const out = [];
  for (const rawLine of masked.split("\n")) {
    const isHeadingHint = rawLine.startsWith(`${MASK_OPEN}H${MASK_CLOSE}`);
    const line = isHeadingHint ? rawLine.slice(3) : rawLine;
    if (!line.trim()) { out.push({ text: "", forceHeading: false }); continue; }
    const pieces = splitInlineOptions(line);
    pieces.forEach((p, i) => out.push({ text: p, forceHeading: isHeadingHint && i === 0 }));
  }
  return { lines: out, store };
}

/**
 * Mark the lines that are answer options — they must stay glued to their stem.
 *
 * Runs of labelled lines are scanned for the longest *ascending streak* within one
 * marker family that starts at the family's first (or second) symbol and keeps a
 * consistent bracket style. That is what separates a numbered question ("1.") from
 * the "(A)(B)(C)(D)" that follows it, and what lets "1) 2) 3) 4)" be options while
 * "1)" one line earlier is the question.
 */
function markOptionLines(lines) {
  const info = lines.map((l) => (l.text.trim() ? detectMarker(l.text) : { kind: "blank" }));
  const n = lines.length;
  const isOption = new Array(n).fill(false);

  const restLen = (k) => stripMasks(info[k].rest).trim().length;
  const isQuestionish = (k) => /[?？]\s*$/.test(stripMasks(info[k].rest).trim());

  let i = 0;
  while (i < n) {
    if (info[i].kind !== "label") { i++; continue; }

    // Maximal run of labelled lines (blank lines and short wrapped continuations allowed).
    const run = [];
    let j = i;
    let blanks = 0;
    while (j < n) {
      const k = info[j].kind;
      if (k === "blank") { blanks++; if (blanks > 1) break; j++; continue; }
      if (k === "label") { run.push(j); blanks = 0; j++; continue; }
      if (run.length && k === "body" && stripMasks(info[j].rest).trim().length <= 60) { j++; continue; }
      break;
    }

    // Walk the run, marking each option streak we can prove.
    let p = 0;
    while (p < run.length) {
      let best = null;
      for (const f of FAMILIES) {
        const first = f.symbols.indexOf(info[run[p]].symbol);
        if (first < 0 || first > 1) continue;
        let len = 1;
        while (p + len < run.length) {
          const a = info[run[p + len - 1]];
          const b = info[run[p + len]];
          if (Boolean(a.bracketed) !== Boolean(b.bracketed)) break;
          const ia = f.symbols.indexOf(a.symbol);
          const ib = f.symbols.indexOf(b.symbol);
          if (ia < 0 || ib !== ia + 1) break;
          len++;
        }
        if (!best || len > best.len) best = { family: f.id, len };
      }

      if (best && best.len >= 2) {
        const slice = run.slice(p, p + best.len);
        const longest = Math.max(...slice.map(restLen));
        const shortEnough = best.len >= 3 ? longest <= OPTION_MAX_CHARS : longest <= OPTION_MAX_CHARS_PAIR;
        // A run of things that are themselves questions is a question list, not options.
        const questionish = slice.filter(isQuestionish).length * 2 >= slice.length;
        const bracketedAll = slice.every((k) => info[k].bracketed);
        const hasStem = slice[0] > 0 && info.slice(0, slice[0]).some((x) => x.kind === "body" || x.kind === "question" || x.kind === "heading" || x.kind === "label");

        // A run too long to be a real option set is a numbered list of sub-questions —
        // each must become its own slide, so it is NOT marked as options. Un-bracketed
        // numeric runs ("1. 2. 3. ...") reach that verdict sooner, since past four they
        // are nearly always a question list rather than options.
        const isPlainNumeric =
          (best.family === "digit" || best.family === "devDigit") && !bracketedAll;
        const maxRun = isPlainNumeric ? OPTION_MAX_RUN_PLAIN_NUM : OPTION_MAX_RUN;
        const tooLong = best.len > maxRun;

        if (!tooLong && shortEnough && !questionish && (hasStem || best.len >= 3 || bracketedAll)) {
          for (const k of slice) isOption[k] = true;
          p += best.len;
          continue;
        }
        if (tooLong) { p += best.len; continue; }  // skip the whole list; leave items as sub-questions
      }
      p += 1;
    }

    i = Math.max(j, i + 1);
  }
  return { info, isOption };
}

const cleanHeading = (s) => String(s || "").replace(new RegExp(`${MASK_OPEN}|${MASK_CLOSE}`, "g"), "").replace(/\s+/g, " ").trim();

/**
 * True when a body carries at least two option-marker lines — i.e. it is a question, not a
 * standalone title paragraph. Uses detectMarker so it catches every option style: "(A)",
 * "[क]", "A)", "A.", "1." — not only bracketed ones.
 */
function bodyHasOptions(body) {
  let n = 0;
  for (const l of String(body || "").split("\n")) {
    const t = l.trim();
    if (!t) continue;
    if (detectMarker(t).kind === "label") { if (++n >= 2) return true; }
  }
  return false;
}

/**
 * Split annotated lines into sections — one per question / sub-question.
 * @param {Array<{text:string, forceHeading:boolean}>} lines masked lines
 */
function linesToSections(lines) {
  const { info, isOption } = markOptionLines(lines);
  const sections = [];
  let current = null;
  let lastQuestionLabel = "";
  let lastPushedWasOption = false;

  const open = (heading) => {
    if (current && (current.body.join("\n").trim() || current.heading)) sections.push(current);
    current = { heading: cleanHeading(heading), body: [] };
    lastPushedWasOption = false;
  };
  const ensure = () => { if (!current) current = { heading: "", body: [] }; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const meta = info[i];

    if (!line.text.trim()) { if (current) current.body.push(""); continue; }

    if (line.forceHeading && !isOption[i] && meta.kind !== "label") {
      open(line.text);
      lastQuestionLabel = "";
      continue;
    }

    if (isOption[i]) {
      ensure();
      // Options belong TIGHT under each other. A transcription usually writes a blank line
      // between them, and keeping those turns one question into a column of widely spaced
      // fragments that overflows the slide. One blank line is kept between the stem and
      // the first option, because that one reads well; the rest go.
      if (lastPushedWasOption && current.body.length && current.body[current.body.length - 1] === "") current.body.pop();
      current.body.push(line.text);
      lastPushedWasOption = true;
      continue;
    }

    if (meta.kind === "question") {
      const label = meta.label || `${meta.number}`;
      open(label);
      lastQuestionLabel = label;
      if (meta.rest.trim()) current.body.push(meta.rest);
      continue;
    }

    if (meta.kind === "label") {
      // Not an option -> a sub-question in its own right.
      const sym = String(meta.symbol || "").trim();
      const label = meta.bracketed ? `(${sym})` : sym;
      // A bracketed sub-part keeps its parent for context ("प्रश्न 3 (क)"). A plain numbered
      // list item ("1." "2." ...) stands on its own — prefixing it produced titles like
      // "प्रश्न 1 1" that then disagreed with items 9+ (which read just "9"). Keep them uniform.
      const numericPlain = !meta.bracketed && /^[0-9०-९]+$/u.test(sym);
      open(lastQuestionLabel && !numericPlain ? `${lastQuestionLabel} ${label}` : label);
      if (meta.rest.trim()) current.body.push(meta.rest);
      continue;
    }

    if (meta.kind === "heading") { open(line.text); lastQuestionLabel = ""; continue; }

    ensure();
    current.body.push(line.text);
  }
  if (current) sections.push(current);

  return sections
    .map((s) => ({ heading: s.heading, body: s.body.join("\n").replace(/\n{3,}/g, "\n\n").trim() }))
    .filter((s) => s.heading || s.body);
}

/* -------------------------------------------------------------------------- */
/* slide-counter junk                                                          */
/* -------------------------------------------------------------------------- */

// "Slide 4", "स्लाइड 4", "Page 4", "पृष्ठ 4" — a counter, not content.
const RE_COUNTER_HEADING = new RegExp(
  "^(?:slide|page|स्लाइड|पृष्ठ|पेज)\\s*[.:#-]?\\s*[0-9" + DEV_DIGIT + "]{1,4}$",
  "iu"
);

/**
 * True when a section is just a slide/page counter rather than content.
 *
 * A PowerPoint deck prints "4/50" in the corner of every slide, and a transcription of a
 * slide image faithfully copies it — sometimes as "$\\frac{4}{50}$" once the model decides
 * a stacked counter is maths. Each one became a slide of its own reading "? / 50", which
 * is how the deck ended up with an item between every real question.
 *
 * Deliberately narrow: the body must contain NO letters in any script, so a real answer is
 * never mistaken for a counter.
 */
function isSlideCounter(section) {
  const heading = String(section?.heading || "").trim();
  const bodyRaw = String(section?.body || "").trim();

  // Strip LaTeX wrappers and fraction syntax so "$\frac{4}{50}$" reads as "4 50".
  const bare = bodyRaw
    .replace(/\$+/g, " ")
    .replace(/\\(?:d?frac|over|text|mathrm)\s*/g, " ")
    .replace(/[{}\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const hasLetters = /\p{L}/u.test(bare);
  // "4/50", "4 50", "? / 50", "4 of 50" — digits, separators and a lone "?" only.
  const counterBody = !hasLetters && bare.length <= 12 && /^[0-9०-९?]+\s*[/|of\-–—]*\s*[0-9०-९]*$/iu.test(bare);

  if (RE_COUNTER_HEADING.test(heading) && (!bodyRaw || counterBody)) return true;
  if (!heading && counterBody && bare.length > 0) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* public: PaddleOCR result -> { title, sections }                             */
/* -------------------------------------------------------------------------- */

/**
 * @param {{markdown?:string, blocks?:Array, lines?:Array}} paddle normalized PaddleOCR output
 * @param {string} fallbackTitle
 */
export function buildDocument(paddle, fallbackTitle = "Untitled Document") {
  const blocks = Array.isArray(paddle?.blocks) ? paddle.blocks : [];
  const markdown = String(paddle?.markdown || "");
  const rawLines = Array.isArray(paddle?.lines) ? paddle.lines : [];

  // LAYOUT first; markdown next; raw recognised lines last.
  let picked = { title: "", units: [] };
  if (blocks.length) picked = unitsFromBlocks(blocks);
  if (!picked.units.length && markdown.trim()) picked = unitsFromMarkdown(markdown);
  if (!picked.units.length && rawLines.length) picked = unitsFromLines(rawLines);

  // If layout blocks produced far less text than the markdown, the block list was
  // partial (some servers prune it) — prefer the richer markdown.
  if (blocks.length && markdown.trim()) {
    const blockChars = picked.units.reduce((n, u) => n + u.text.length, 0);
    if (blockChars < markdown.replace(/\s+/g, "").length * 0.6) {
      const alt = unitsFromMarkdown(markdown);
      const altChars = alt.units.reduce((n, u) => n + u.text.length, 0);
      if (altChars > blockChars) picked = { title: picked.title || alt.title, units: alt.units };
    }
  }

  if (!picked.units.length) return { title: fallbackTitle, sections: [] };

  const { lines, store } = unitsToLines(picked.units);
  let sections = linesToSections(lines).map((s) => ({
    heading: unmaskProtected(s.heading, store),
    body: unmaskProtected(s.body, store),
  }));

  // Rules fallback: a page that produced NO structure at all is kept as paragraphs
  // rather than one giant blob.
  //
  // THE GUARD BELOW IS LOAD-BEARING. Read before touching it.
  //
  // This fallback used to run whenever `sections.length <= 1`, and that condition is
  // wrong, because ONE section is the normal, CORRECT result for a page carrying a single
  // question. Every quiz slide in a PowerPoint deck is exactly that. The fallback then
  // split the body on blank lines — and a transcription writes a blank line between a
  // question stem and each of its options — so
  //
  //     5. वास्कोडिगामा किस देश का निवासी था?
  //     (A) स्पेन   (B) पुर्तगाल   (C) फ्रांस   (D) इंग्लैंड
  //
  // came apart into FIVE sections: the stem, then one per option. Downstream each became
  // its own slide, titled "(A)", "(B)"… That is the "questions are clear but every slide
  // is wrong" bug, and it was worst on exactly the papers that matter most — a question
  // whose options are words rather than numbers is likelier to be written out with blank
  // lines between them, which is why Q4 survived and Q5 did not.
  //
  // A section is STRUCTURED when it has a question label as its heading, or when its body
  // carries answer options. Structured means the splitter already did its job, so leave
  // it alone: question plus options stays one section, and one slide.
  if (sections.length <= 1) {
    const only = sections[0];
    const structured = Boolean(only && (String(only.heading || "").trim() || bodyHasOptions(only.body)));
    if (!structured) {
      const whole = only?.body || unmaskProtected(lines.map((l) => l.text).join("\n"), store);
      const paras = whole.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      if (paras.length > 1) sections = paras.map((p, i) => ({ heading: only?.heading && i === 0 ? only.heading : "", body: p }));
    }
  }

  let title = cleanHeading(unmaskProtected(picked.title || "", store));
  if (!title) {
    const idx = sections.findIndex((s) => s.body);
    const src = sections[idx];
    const firstLine = (src?.body || "").split("\n").find((l) => l.trim());
    const candidate = (firstLine || "").trim();
    // NEVER steal a question's stem to use as the deck title. If the section is a question
    // — it has a question label as its heading, or its body carries answer options — then
    // its first body line is the QUESTION STEM, not a spare document title. Promoting it
    // (and deleting it from the body) is exactly what left slides showing only the options
    // with the question text gone. Only an unstructured title paragraph is fair game.
    const sectionIsQuestion = !!(src && (src.heading || bodyHasOptions(src.body)));
    const usable =
      candidate &&
      candidate.length <= 90 &&
      !/^<|<table|^\|/i.test(candidate) &&
      !/^\$\$?/.test(candidate) &&
      detectMarker(candidate).kind === "body" &&
      !sectionIsQuestion;
    if (usable) {
      title = candidate;
      // Promoted to the title — do not leave a duplicate copy in the body.
      const rest = sections[idx].body.split("\n");
      rest.splice(rest.indexOf(firstLine), 1);
      sections[idx] = { ...sections[idx], body: rest.join("\n").trim() };
    }
  }
  if (!title) title = fallbackTitle;

  sections = sections
    .map((s) => ({ heading: s.heading || "", body: s.body || "" }))
    .filter((s) => (s.heading + s.body).trim())
    .filter((s) => !isSlideCounter(s));

  return { title, sections };
}

/* -------------------------------------------------------------------------- */
/* public: sections -> slide items                                             */
/* -------------------------------------------------------------------------- */

const shortLabel = (s, max = 52) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trim()}…`;
};

/** True when a block of text is nothing but answer options (no stem of its own). */
function isOnlyOptions(text) {
  const { masked, store } = maskProtected(String(text || ""));
  const rows = masked.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!rows.length) return false;
  const { isOption } = markOptionLines(rows.map((t) => ({ text: t, forceHeading: false })));
  void store;
  return isOption.every(Boolean);
}

/**
 * One item per question / sub-question, options kept inside their question,
 * original order, original wording, no cap on the number of items.
 *
 * @param {string} title document title
 * @param {Array<{heading:string, body:string}>} sections
 * @returns {Array<{title:string, text:string}>}
 */
export function splitSectionsIntoItems(title, sections) {
  const items = [];

  const push = (heading, text) => {
    const body = String(text || "").replace(/\n{3,}/g, "\n\n").trim();
    const head = String(heading || "").trim();
    if (!body && !head) return;
    if (!body) { items.push({ title: shortLabel(head), text: head }); return; }
    // An options-only fragment belongs to the question just before it.
    if (items.length && body && isOnlyOptions(body) && !head) {
      items[items.length - 1].text = `${items[items.length - 1].text}\n${body}`.trim();
      return;
    }
    const firstReadable = body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !/^<|^\||^\$\$?/.test(l));
    items.push({ title: shortLabel(head || firstReadable || `Slide ${items.length + 1}`), text: body });
  };

  for (const sec of Array.isArray(sections) ? sections : []) {
    const heading = String(sec?.heading || "").trim();
    const body = normalizeText(sec?.body || "");
    if (!heading && !body) continue;

    const source = heading && body ? `${heading}\n${body}` : heading || body;
    const { lines, store } = unitsToLines([{ type: "text", text: source }]);
    const parts = linesToSections(lines).map((s) => ({
      heading: unmaskProtected(s.heading, store),
      body: unmaskProtected(s.body, store),
    }));

    if (parts.length <= 1) {
      push(heading || parts[0]?.heading || "", body || parts[0]?.body || "");
      continue;
    }
    for (const p of parts) {
      const h = p.heading && heading && !p.heading.startsWith(heading) && parts.length > 1 && /^[([]/u.test(p.heading)
        ? `${heading} ${p.heading}`
        : p.heading || heading;
      push(h, p.body);
    }
  }

  if (!items.length && String(title || "").trim()) items.push({ title: shortLabel(title), text: String(title).trim() });
  return items;
}

/** Convenience: PaddleOCR result straight to slide items. */
export function buildItems(paddle, fallbackTitle) {
  const doc = buildDocument(paddle, fallbackTitle);
  return { title: doc.title, items: splitSectionsIntoItems(doc.title, doc.sections) };
}
