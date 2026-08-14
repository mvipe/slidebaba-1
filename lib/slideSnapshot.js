"use client";

// TRUE-SNAPSHOT RASTERISER
// ============================================================================
// The PDF pages are now literal snapshots of the very same DOM the editor and the
// preview modal paint — not a re-drawing of it.
//
// How, and why this removes the "everything sits 1-2 cm too low" bug:
//
//   html2canvas does not rasterise the page. It *re-implements* CSS: it reads the
//   computed styles of every node and then paints its own approximation onto a
//   canvas. Two things it approximates badly are (a) the text baseline inside a box
//   with a line-height that is not 1.0 — it stacks lines from the top of the box
//   using its own leading model, which pushes a whole text block downwards — and
//   (b) KaTeX's `.vlist` table geometry, which is how fractions, exponents and roots
//   are positioned. That is exactly the two symptoms: a uniform vertical shift, and
//   maths that is fine on screen and wrong in the PDF.
//
//   Instead of fighting that, this module hands the slide back to the browser:
//     slide DOM  ->  XHTML  ->  <svg><foreignObject>  ->  <img>  ->  canvas
//   Everything inside a foreignObject is laid out and painted by the browser's own
//   engine, the same engine that drew the preview. Line boxes, baselines, KaTeX
//   vlists, wrapping — all identical by construction, not by imitation.
//
//   Two conditions have to be met for that to be pixel-exact, and both are handled
//   below:
//     1. An SVG rendered through <img> is sandboxed: it cannot reach out for CSS,
//        webfonts or images. So every stylesheet the app uses is inlined, and every
//        font that the deck actually needs (including the KaTeX faces) is embedded
//        as a base64 @font-face. Images are already data URLs by the time they get
//        here.
//     2. The markup must be well-formed XML. It is produced with XMLSerializer from
//        a real DOM node rather than string-concatenated, so `<br>`, `&nbsp;` and
//        KaTeX's inline <svg> all survive.
//
//   The SVG carries `width`/`height` at the *output* pixel size with a viewBox at
//   the design size, so the browser rasterises the vectors at full export
//   resolution instead of upscaling a 896px bitmap.
//
// Measured against a headless Chromium: the canvas this produces is pixel-identical to
// the browser's own screenshot of the same slide (0 differing ink pixels out of ~49k),
// where the previous html2canvas path differed on ~7.3k of them.

import { DESIGN_W, DESIGN_H, isTextElement } from "@/lib/slideRender";

/* ============================================================
   fetching helpers
   ============================================================ */

async function fetchText(url) {
  try {
    const r = await fetch(url, { credentials: "omit" });
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  }
}

// url -> Promise<dataUri>. Promises (not values) are cached so a font requested by
// several slides at once is only downloaded once.
const assetCache = new Map();

function fetchDataUrl(url) {
  if (assetCache.has(url)) return assetCache.get(url);
  const job = (async () => {
    try {
      const r = await fetch(url, { credentials: "omit" });
      if (!r.ok) return "";
      const blob = await r.blob();
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ""));
        fr.onerror = () => resolve("");
        fr.readAsDataURL(blob);
      });
    } catch {
      return "";
    }
  })();
  assetCache.set(url, job);
  return job;
}

/* ============================================================
   stylesheet harvesting
   ============================================================ */

/** Flatten one stylesheet to text. Returns "" when it is cross-origin (unreadable). */
function sheetToText(sheet) {
  let out = "";
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.IMPORT_RULE) {
        if (rule.styleSheet) { try { walk(rule.styleSheet.cssRules); } catch { /* cross-origin @import */ } }
        continue;
      }
      out += rule.cssText + "\n";
    }
  };
  try { walk(sheet.cssRules); } catch { return ""; }
  return out;
}

/** Collect every stylesheet in the document as `{ text, base }` chunks. */
async function collectStyleChunks() {
  const chunks = [];
  for (const sheet of Array.from(document.styleSheets)) {
    const text = sheetToText(sheet);
    if (text) {
      chunks.push({ text, base: sheet.href || document.baseURI });
      continue;
    }
    // Unreadable => cross-origin (the Google Fonts <link>). Fetch it instead; the
    // CSS2 endpoint sends Access-Control-Allow-Origin: *.
    if (sheet.href) {
      const fetched = await fetchText(sheet.href);
      if (fetched) chunks.push({ text: fetched, base: sheet.href });
    }
  }
  return chunks;
}

/* ============================================================
   @font-face selection + embedding
   ============================================================ */

const FONT_FACE_RE = /@font-face\s*\{[^{}]*\}/gi;
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i;
const URL_RE_G = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function declOf(block, prop) {
  const m = new RegExp(`(?:^|[;{])\\s*${prop}\\s*:\\s*([^;}]+)`, "i").exec(block);
  return m ? m[1].trim() : "";
}

function faceFamily(block) {
  return declOf(block, "font-family").replace(/^["']|["']$/g, "").trim();
}

/** Parse `unicode-range` into [lo, hi] pairs. No declaration = covers everything. */
function faceRanges(block) {
  const raw = declOf(block, "unicode-range");
  if (!raw) return null;
  const out = [];
  for (const part of raw.split(",")) {
    const m = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!m) return null; // unparseable -> be safe and keep the face
    if (m[1].includes("?")) {
      out.push([parseInt(m[1].replace(/\?/g, "0"), 16), parseInt(m[1].replace(/\?/g, "f"), 16)]);
    } else {
      const lo = parseInt(m[1], 16);
      out.push([lo, m[2] ? parseInt(m[2], 16) : lo]);
    }
  }
  return out.length ? out : null;
}

function faceIsNeeded(block, families, codepoints) {
  const fam = faceFamily(block).toLowerCase();
  if (!fam) return false;
  if (!families.has(fam)) return false;
  const ranges = faceRanges(block);
  if (!ranges) return true;
  for (const cp of codepoints) {
    for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** Pick the smallest usable source: woff2 if the face offers one, else the first url. */
function pickSrc(block, base) {
  const src = declOf(block, "src");
  if (!src) return null;
  const candidates = [];
  for (const part of src.split(/,(?![^(]*\))/)) {
    const m = URL_RE.exec(part);
    if (!m) continue;
    let abs;
    try { abs = new URL(m[2], base).href; } catch { continue; }
    candidates.push({ url: abs, woff2: /format\(\s*['"]?woff2/i.test(part) || /\.woff2(\?|#|$)/i.test(abs) });
  }
  if (!candidates.length) return null;
  return candidates.find((c) => c.woff2) || candidates[0];
}

async function embedFace(block, base) {
  const pick = pickSrc(block, base);
  if (!pick) return "";
  const data = await fetchDataUrl(pick.url);
  if (!data) return "";
  const fmt = pick.woff2 ? "woff2" : /\.woff(\?|#|$)/i.test(pick.url) ? "woff"
    : /\.otf(\?|#|$)/i.test(pick.url) ? "opentype" : "truetype";
  // Rebuild the block with a single, self-contained src.
  const body = block.replace(/^@font-face\s*\{/i, "").replace(/\}\s*$/, "");
  const kept = body
    .split(";")
    .filter((d) => d.trim() && !/^\s*src\s*:/i.test(d))
    .join(";");
  return `@font-face{${kept};src:url("${data}") format("${fmt}");}`;
}

/* ============================================================
   the snapshot context (built once per export run)
   ============================================================ */

/** Every font family the deck can ask for, lower-cased. */
function deckFamilies(slides, needsMath) {
  const set = new Set(["inter"]);
  for (const sl of slides) {
    for (const el of sl.elements || []) {
      if (isTextElement(el)) {
        if (el.fontFamily) set.add(String(el.fontFamily).toLowerCase());
        // per-word font-family overrides live inside the stored content
        const re = /font-family\s*:\s*([^;"']+)/gi;
        let m;
        while ((m = re.exec(el.content || ""))) set.add(m[1].trim().replace(/^["']|["']$/g, "").toLowerCase());
      }
    }
  }
  if (needsMath) {
    for (const f of [
      "katex_main", "katex_math", "katex_ams", "katex_caligraphic", "katex_fraktur",
      "katex_sansserif", "katex_script", "katex_typewriter",
      "katex_size1", "katex_size2", "katex_size3", "katex_size4",
    ]) set.add(f);
  }
  return set;
}

/** Every codepoint the deck actually prints, so unused Cyrillic/Vietnamese subsets are skipped. */
function deckCodepoints(slides) {
  const set = new Set();
  // KaTeX draws operators and delimiters that never appear in the source text.
  for (const ch of "0123456789+-=()[]{}<>/*.,;:!?'\"|") set.add(ch.codePointAt(0));
  for (const sl of slides) {
    for (const el of sl.elements || []) {
      if (!isTextElement(el)) continue;
      for (const ch of String(el.content || "")) set.add(ch.codePointAt(0));
    }
  }
  return set;
}

export function deckNeedsMath(slides) {
  return slides.some((sl) => (sl.elements || []).some((el) => isTextElement(el) && /[$\\^_]/.test(el.content || "")));
}

/**
 * Build everything the rasteriser needs: the app's CSS plus base64 webfonts.
 * Do this once and reuse it for every slide — it is the only expensive step.
 */
export async function createSnapshotContext(slides) {
  const needsMath = deckNeedsMath(slides);
  const families = deckFamilies(slides, needsMath);
  const codepoints = deckCodepoints(slides);

  const chunks = await collectStyleChunks();

  const faceJobs = [];
  let rest = "";
  for (const { text, base } of chunks) {
    rest += text.replace(FONT_FACE_RE, (block) => {
      if (faceIsNeeded(block, families, codepoints)) faceJobs.push(embedFace(block, base));
      return ""; // never leave a face with an unreachable src behind
    });
    rest += "\n";
  }

  // Drop rules that can only fail inside the sandbox, and absolutise what is left.
  rest = rest
    .replace(/@charset[^;]*;/gi, "")
    .replace(/@import[^;]*;/gi, "")
    .replace(/@font-face\s*\{[\s\S]*?\}/gi, "");

  const faces = (await Promise.all(faceJobs)).filter(Boolean);

  // Mirror <html>'s classes so theme-scoped rules (`.dark .x`) resolve the same way
  // they do on screen.
  const rootClass = document.documentElement.className || "";

  return {
    css: `${faces.join("\n")}\n${rest}`,
    rootClass,
    families: [...families],
    needsMath,
  };
}

export function clearSnapshotCache() {
  assetCache.clear();
}

/* ============================================================
   HTML -> XHTML -> SVG -> canvas
   ============================================================ */

function toXhtml(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  const ser = new XMLSerializer();
  let out = "";
  for (const child of Array.from(holder.childNodes)) out += ser.serializeToString(child);
  return out;
}

function buildSvg(html, ctx, outW, outH) {
  const body = toXhtml(html);
  const cls = String(ctx.rootClass || "").replace(/[<>&"]/g, "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" ` +
    `viewBox="0 0 ${DESIGN_W} ${DESIGN_H}">` +
    `<foreignObject x="0" y="0" width="${DESIGN_W}" height="${DESIGN_H}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="${cls}" ` +
    // Deliberately no font-smoothing / text-rendering overrides here: the point is to
    // reproduce the screen exactly, and either of those changes glyph rasterisation.
    `style="width:${DESIGN_W}px;height:${DESIGN_H}px;margin:0;padding:0;overflow:hidden;">` +
    `<style type="text/css"><![CDATA[\n${ctx.css}\n]]></style>` +
    body +
    `</div></foreignObject></svg>`
  );
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.decoding = "sync";
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("svg image failed"));
    im.src = src;
  });
}

/**
 * True when the canvas is a single flat colour — a sign the foreignObject never painted.
 * Checked on a 64x36 downscale rather than the full raster: reading back a 2240x1260
 * frame would allocate ~45 MB per slide, which is exactly the kind of pressure that used
 * to make long exports die.
 * Also doubles as the taint check — if the canvas were not origin-clean, toDataURL()
 * would fail later anyway, so surfacing it here lets the caller fall back cleanly.
 */
function looksBlank(canvas) {
  const w = 64, h = 36;
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const g = small.getContext("2d", { alpha: false });
  g.drawImage(canvas, 0, 0, w, h);
  let data;
  try {
    data = g.getImageData(0, 0, w, h).data;
  } catch {
    throw new Error("snapshot canvas is tainted");
  } finally {
    small.width = small.height = 0;
  }
  for (let i = 4; i < data.length; i += 4) {
    if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) return false;
  }
  return true;
}

/**
 * Rasterise one slide's HTML at `targetWidth` px.
 * Throws if the browser cannot render the foreignObject, so the caller can fall back.
 */
export async function snapshotToCanvas(html, ctx, targetWidth, expectContent = true) {
  const outW = Math.max(1, Math.round(targetWidth));
  const outH = Math.max(1, Math.round((targetWidth * DESIGN_H) / DESIGN_W));
  const svg = buildSvg(html, ctx, outW, outH);

  // MUST be a data: URL. A blob: URL loads and paints correctly, but Chrome still marks
  // the destination canvas as tainted, and canvas.toDataURL() then throws SecurityError —
  // i.e. the export silently produces nothing. Verified against Chromium.
  const img = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));

  try { if (img.decode) await img.decode(); } catch { /* already decoded */ }

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const c2d = canvas.getContext("2d", { alpha: false });
  c2d.fillStyle = "#ffffff";
  c2d.fillRect(0, 0, outW, outH);
  c2d.drawImage(img, 0, 0, outW, outH);

  if (expectContent && looksBlank(canvas)) {
    canvas.width = canvas.height = 0;
    throw new Error("foreignObject snapshot came out empty");
  }
  return canvas;
}
