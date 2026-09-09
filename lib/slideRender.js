// SINGLE SOURCE OF TRUTH for slide geometry and element styling.
//
// Why this file exists:
//   The editor canvas, the preview modal and the PDF/PPTX exporter each used to build
//   their own CSS. The editor canvas was a fluid `min(100%, 56rem)` box, the preview
//   modal was a 1024px box and the exporter rendered at 896px — with ABSOLUTE px font
//   sizes. Identical text therefore wrapped at three different places, which is exactly
//   why "it looks right in the preview but is misaligned in the PDF".
//
//   Now everything lays out on ONE fixed 896x504 design surface and is only ever scaled
//   with a CSS transform. A transform cannot change line-breaking, so the editor, the
//   preview and the exported PDF are guaranteed to be identical, on every screen size
//   and at every zoom level.

export const DESIGN_W = 896;
export const DESIGN_H = 504; // 16:9

// Typography constants live here too, because the PPTX exporter has to reproduce them
// in PowerPoint's own units. Changing a number here moves the editor, the preview, the
// PDF and the PPTX together — which is the only way they can stay in agreement.
export const TEXT_PAD_X = 6;          // px, left/right padding inside a text box
export const TEXT_PAD_Y = 2;          // px, top/bottom padding inside a text box
export const TEXT_LINE_HEIGHT = 1.35; // css line-height

/* ---------------- css helpers ---------------- */

// Props that are legitimately unitless.
const UNITLESS = new Set(["lineHeight", "fontWeight", "opacity", "zIndex", "flex", "flexGrow", "flexShrink", "order"]);

function kebab(k) {
  return k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** Turn a React-style object into a CSS declaration string (for the export DOM). */
export function styleToCss(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === "") continue;
    const val = typeof v === "number" && !UNITLESS.has(k) ? `${v}px` : v;
    out.push(`${kebab(k)}:${val}`);
  }
  return out.join(";") + ";";
}

/**
 * Quote a font family safely.
 * "Source Sans 3" is NOT a valid unquoted CSS identifier (a component starts with a digit),
 * so unquoted it silently fell back to sans-serif. Single quotes are used so the string can
 * also live inside a double-quoted HTML style attribute.
 */
export function fontStack(family) {
  const f = String(family || "Inter").replace(/['"\\]/g, "").trim() || "Inter";
  const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(f);
  return generic ? f : `'${f}', sans-serif`;
}

/* ---------------- background ---------------- */

export function slideBgStyle(sl, theme) {
  if (sl?.bgImage) {
    return {
      backgroundImage: `url("${sl.bgImage}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
    };
  }
  return { background: sl?.bgColor || theme?.bg || "#ffffff" };
}

/* ---------------- elements ---------------- */

export function isTextElement(el) {
  return !el?.type || el.type === "text";
}

/**
 * Outer positioning frame. Identical in the editor, the preview and the exporter.
 * Text boxes grow downwards (min-height); every other element has a fixed height.
 */
export function frameStyle(el) {
  // Text AND tables grow downwards; everything else is a fixed box. See elementGrowsDown().
  const grows = !el?.type || el.type === "text" || el.type === "table";
  return {
    position: "absolute",
    left: `${el.x}%`,
    top: `${el.y}%`,
    width: `${el.w}%`,
    height: grows ? undefined : `${el.h}%`,
    minHeight: grows ? `${el.h}%` : undefined,
    boxSizing: "border-box",
  };
}

/**
 * Inner typography box for a text element.
 * NOTE: word-break / overflow-wrap are set here for BOTH paths. Previously only the
 * exporter had them, so a long unbroken word wrapped in the PDF but overflowed on screen.
 */
export function textStyle(el, theme) {
  const deco = `${el.underline ? "underline " : ""}${el.strike ? "line-through" : ""}`.trim() || "none";
  return {
    display: "block",
    width: "100%",
    fontSize: `${el.fontSize || 20}px`,
    fontFamily: fontStack(el.fontFamily),
    fontWeight: el.bold ? 700 : 400,
    fontStyle: el.italic ? "italic" : "normal",
    textDecoration: deco,
    textAlign: el.align || "left",
    color: el.color || theme?.text || "#0b0a18",
    background: el.highlight || "transparent",
    lineHeight: TEXT_LINE_HEIGHT,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowWrap: "break-word",
    padding: `${TEXT_PAD_Y}px ${TEXT_PAD_X}px`,
    boxSizing: "border-box",
  };
}

export function shapeInnerStyle(el) {
  const type = el.type;
  const border = el.strokeWidth ? `${el.strokeWidth}px solid ${el.stroke || "#000000"}` : "none";
  if (type === "rect") {
    return {
      width: "100%", height: "100%",
      background: el.fill || "#6d3aed",
      border,
      borderRadius: `${el.radius || 0}px`,
      boxSizing: "border-box",
    };
  }
  if (type === "ellipse") {
    return {
      width: "100%", height: "100%",
      background: el.fill || "#ec4899",
      border,
      borderRadius: "50%",
      boxSizing: "border-box",
    };
  }
  // line wrapper
  return { width: "100%", height: "100%", display: "flex", alignItems: "center" };
}

export function lineBarStyle(el) {
  return { width: "100%", height: `${el.strokeWidth || 2}px`, background: el.stroke || "#000000" };
}

export function imageStyle(el) {
  return {
    width: "100%",
    height: "100%",
    objectFit: "fill",
    borderRadius: `${el.radius || 0}px`,
    display: "block",
  };
}

/**
 * Scale factor that fits the 896x504 design surface into an available box.
 * Layout always happens at design size; only the transform changes.
 */
export function fitScale(availW, availH) {
  if (!availW || !availH) return 1;
  return Math.min(availW / DESIGN_W, availH / DESIGN_H);
}

/* ---------------- tables ---------------- */
//
// A table is a first-class element type, not text that happens to contain markup.
//
// This matters because the OCR pipeline ALREADY emits real <table> markup for tabular
// questions (lib/ocrStructure.js deliberately preserves it), but it was landing in a
// text element's `content`, where components/Katex.js HTML-escapes everything it does
// not recognise. The result was a slide showing literal "&lt;table&gt;&lt;tr&gt;…" —
// in the editor, the preview, the PDF and the PPTX alike.
//
// Everything below is shared by the editor canvas, the preview modal and the exporter,
// for the same reason the rest of this file is: three copies of layout logic is how
// "it looks right on screen but wrong in the PDF" happens.

export const TABLE_DEFAULTS = {
  fontSize: 15,
  fontFamily: "Inter",
  borderColor: "#94a3b8",
  borderWidth: 1,
  headerFill: "#eef2f7",
  headerBold: true,
  cellFill: "",
  cellPadX: 8,
  cellPadY: 5,
  align: "left",
  header: true,
};

const tv = (el, key) => (el?.[key] ?? TABLE_DEFAULTS[key]);

/** Rows as a rectangular array of strings, whatever shape the element arrived in. */
export function tableRows(el) {
  const rows = Array.isArray(el?.rows) ? el.rows : [];
  const clean = rows
    .map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? "" : String(c))) : []))
    .filter((r) => r.length);
  if (!clean.length) return [[""]];
  const cols = Math.max(...clean.map((r) => r.length));
  return clean.map((r) => (r.length === cols ? r : [...r, ...Array(cols - r.length).fill("")]));
}

/** Column widths as percentages that always sum to 100. */
export function tableColWidths(el) {
  const cols = tableRows(el)[0].length;
  const raw = Array.isArray(el?.colW) && el.colW.length === cols ? el.colW.map(Number) : null;
  if (!raw || raw.some((n) => !Number.isFinite(n) || n <= 0)) {
    return Array(cols).fill(100 / cols);
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((n) => (n / sum) * 100);
}

export function tableStyle(el) {
  return {
    width: "100%",
    height: "100%",
    borderCollapse: "collapse",
    tableLayout: "fixed",
    fontFamily: fontStack(tv(el, "fontFamily")),
    fontSize: `${tv(el, "fontSize")}px`,
    lineHeight: TEXT_LINE_HEIGHT,
    boxSizing: "border-box",
  };
}

export function tableCellStyle(el, theme, isHeader) {
  const bw = Number(tv(el, "borderWidth")) || 0;
  return {
    border: bw ? `${bw}px solid ${tv(el, "borderColor")}` : "none",
    padding: `${tv(el, "cellPadY")}px ${tv(el, "cellPadX")}px`,
    textAlign: tv(el, "align"),
    verticalAlign: "top",
    color: el?.color || theme?.text || "#0b0a18",
    background: (isHeader ? tv(el, "headerFill") : tv(el, "cellFill")) || "transparent",
    fontWeight: isHeader && tv(el, "headerBold") ? 700 : 400,
    wordBreak: "break-word",
    overflowWrap: "break-word",
    boxSizing: "border-box",
  };
}

/**
 * Build a table's HTML.
 *
 * @param renderCell  how to turn one cell's stored text into HTML. The editor and the
 *                    PDF exporter pass renderMixed (so $math$ becomes KaTeX); a plain
 *                    escaper is used where KaTeX is unavailable.
 */
export function tableHTML(el, theme, renderCell) {
  const rows = tableRows(el);
  const widths = tableColWidths(el);
  const useHeader = Boolean(tv(el, "header")) && rows.length > 1;
  const cols = `<colgroup>${widths.map((w) => `<col style="width:${w}%" />`).join("")}</colgroup>`;

  const body = rows
    .map((row, r) => {
      const isHeader = useHeader && r === 0;
      const tag = isHeader ? "th" : "td";
      const css = styleToCss(tableCellStyle(el, theme, isHeader));
      const cells = row
        .map((cell) => `<${tag} style="${css}">${renderCell(cell)}</${tag}>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<table style="${styleToCss(tableStyle(el))}">${cols}<tbody>${body}</tbody></table>`;
}

export function isTableElement(el) {
  return el?.type === "table";
}

/**
 * Elements that must not be clipped to their box.
 * Text has always grown downwards; tables have to as well, or an OCR'd table with more
 * rows than the initial box height would silently lose its last rows.
 */
export function elementGrowsDown(el) {
  return isTextElement(el) || isTableElement(el);
}
