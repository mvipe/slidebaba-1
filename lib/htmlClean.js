/**
 * Turn stray HTML in OCR text into clean text — so no view (slides, notes, preview, PPT,
 * PDF, Word) ever shows markup like "<b>", "<br>", "<li>" or "&nbsp;" as code.
 *
 * The vision models are asked for markdown, but they still emit HTML now and then.
 * Tables are the one structure worth keeping: they are left untouched and drawn as real
 * tables elsewhere (lib/tableText.js). Everything else becomes plain text:
 *
 *   <br>, <p>, <div>, <h1>…        -> new line
 *   <ul><li>a</li></ul>            -> "• a"          <ol><li>a</li></ol> -> "1. a"
 *   x<sup>2</sup>, H<sub>2</sub>O  -> x², H₂O        (x^(n+1) when no superscript glyph exists)
 *   <b>, <i>, <u>, <span>, **x**   -> tag removed, words kept
 *   &nbsp; &amp; &lt; &#8377; …    -> the real characters
 *   <script>, <style>, <iframe>…   -> removed together with their content (safety)
 *
 * Maths ($…$, $$…$$) is protected so "a<b" inside a formula is never mistaken for a tag.
 * No imports: used on the server (OCR structuring) and in the browser alike.
 */

const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ" };
const SUB = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎" };

const script = (text, map, mark) => {
  const t = String(text || "").trim();
  if (!t) return "";
  return [...t].every((c) => map[c]) ? [...t].map((c) => map[c]).join("") : `${mark}(${t})`;
};

const ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", hellip: "…",
  times: "×", divide: "÷", minus: "−", plusmn: "±", deg: "°", le: "≤", ge: "≥", ne: "≠", rarr: "→",
  larr: "←", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", rupee: "₹",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", pi: "π", theta: "θ", alpha: "α", beta: "β",
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d{1,7});/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return m; } })
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } })
    .replace(/&([a-z][a-z0-9]{1,8});/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const BLOCK_TAGS = "p|div|section|article|header|footer|blockquote|center|h[1-6]|ul|ol|dl|dt|dd|pre|figure|figcaption|address|nav|main|aside|tbody|thead";

export function cleanOcrHtml(raw) {
  let s = String(raw == null ? "" : raw);
  if (!/[<&]|\*\*/.test(s)) return s;              // nothing to do — the common case

  // Protect tables (kept as tables) and maths (may legitimately contain < and >).
  const store = [];
  const keep = (m) => `\u0003${store.push(m) - 1}\u0004`;
  s = s.replace(/<table\b[\s\S]*?<\/table>/gi, keep);
  s = s.replace(/\$\$[\s\S]*?\$\$/g, keep);
  s = s.replace(/\$[^$\n]*\$/g, keep);

  // Unsafe or invisible containers go entirely, content included.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|iframe|object|embed|svg|template|head|title|button|select|textarea)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<(script|style|iframe|object|embed|input|meta|link|base)\b[^>]*>/gi, "");

  // Superscript / subscript -> real glyphs (x², H₂O), else x^(…) / x_(…).
  s = s.replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, (_, t) => script(t.replace(/<[^>]*>/g, ""), SUP, "^"));
  s = s.replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, (_, t) => script(t.replace(/<[^>]*>/g, ""), SUB, "_"));

  // Lists: numbered lists keep their numbers, others become bullets.
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let n = 0;
    return `\n${inner.replace(/<li\b[^>]*>/gi, () => `\n${++n}. `)}\n`;
  });
  s = s.replace(/<li\b[^>]*>/gi, "\n• ");
  s = s.replace(/<\/li\s*>/gi, "");

  // Line and block breaks.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\b[^>]*>/gi, "\n");
  s = s.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n");

  // Every other tag (b, strong, i, em, u, span, font, a, mark, small, …): drop the tag, keep the words.
  s = s.replace(/<\/?[a-z][a-z0-9-]*\b[^<>]*>/gi, "");

  // Markdown bold the renderer would otherwise print literally.
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "$1");

  s = decodeEntities(s);
  s = s.replace(/\u0003(\d+)\u0004/g, (_, i) => store[Number(i)] ?? "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+(?=\S)/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
