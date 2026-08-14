// Export helpers.
//
//  - PDF : one page per slide, and each page is a TRUE SNAPSHOT of the slide as the
//          browser itself draws it (see lib/slideSnapshot.js). What you see in the
//          editor / preview is byte-for-byte the layout engine that produces the page,
//          so nothing can drift vertically and KaTeX lands exactly where it does on
//          screen.
//  - PPTX: 100% NATIVE + editable. Every text box, shape and image is a real
//          PowerPoint object and maths becomes crisp Unicode text (no images), but the
//          geometry — padding, line spacing, font size, per-word colours — is now
//          derived from the same numbers the editor uses instead of PowerPoint's
//          defaults.
//
// THREE BUGS FIXED HERE
//
// 1) "After working for a while I can't download any more."
//    html2canvas clones the ENTIRE document into a temporary iframe on every single
//    call, so a long editing session made every export slower until the tab ran out of
//    memory. The snapshot path never clones the document at all, and the html2canvas
//    fallback still renders into a dedicated, permanently empty sandbox iframe.
//
// 2) "The preview looks right but the PDF sits 1-2 cm lower, and the maths is off."
//    Root cause: html2canvas does not rasterise the page, it re-implements CSS. Its
//    line-box model puts text lower inside a box whose line-height is not 1.0, and it
//    cannot reproduce KaTeX's `.vlist` table geometry at all. Both are gone now that
//    the page is produced by the browser's own renderer. html2canvas is kept only as a
//    last-resort fallback for engines that refuse <foreignObject>.
//
// 3) "The PPTX comes out formatted differently."
//    The editor draws text with 2px/6px padding and a 1.35 line-height; the old export
//    used PowerPoint's zero margin and single spacing, and dropped per-word colour and
//    weight spans (they were emitted as literal `<span ...>` text). All of that is
//    mapped across faithfully below.

import { renderMixed } from "@/components/Katex";
import { mixedToUnicode } from "@/lib/mathText";
import {
  DESIGN_W, DESIGN_H, styleToCss, frameStyle, textStyle, shapeInnerStyle,
  lineBarStyle, imageStyle, isTextElement, fontStack,
  TEXT_PAD_X, TEXT_PAD_Y, TEXT_LINE_HEIGHT,
} from "@/lib/slideRender";
import {
  createSnapshotContext, snapshotToCanvas, clearSnapshotCache, deckNeedsMath,
} from "@/lib/slideSnapshot";
import html2canvas from "html2canvas";
import pptxgen from "pptxgenjs";
import { jsPDF } from "jspdf";

// The PPTX slide is 10in x 5.625in = 720pt x 405pt. The PDF page is created at the very
// same physical size, so a deck exported both ways prints identically.
const SLIDE_W_PT = 720;
const SLIDE_H_PT = 405;
const PT = SLIDE_W_PT / DESIGN_W; // editor px -> points

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

/* ---------------- colour ---------------- */

let colourProbe = null;
/** Normalise any CSS colour (hex / rgb() / named) to a bare RRGGBB for pptxgenjs. */
function pptColor(c, fallback = "000000") {
  const raw = String(c ?? "").trim();
  if (!raw) return fallback;
  let m = /^#([0-9a-f]{3})$/i.exec(raw);
  if (m) return m[1].split("").map((h) => h + h).join("").toUpperCase();
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(raw);
  if (m) return m[1].toUpperCase();
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(raw);
  if (m) {
    return [m[1], m[2], m[3]]
      .map((v) => Math.max(0, Math.min(255, Math.round(parseFloat(v)))).toString(16).padStart(2, "0"))
      .join("").toUpperCase();
  }
  if (/^[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase();
  // named colour: let the browser resolve it
  try {
    if (!colourProbe) {
      colourProbe = document.createElement("span");
      colourProbe.style.display = "none";
      document.body.appendChild(colourProbe);
    }
    colourProbe.style.color = "";
    colourProbe.style.color = raw;
    if (colourProbe.style.color) {
      const resolved = getComputedStyle(colourProbe).color;
      const rm = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(resolved);
      if (rm) {
        return [rm[1], rm[2], rm[3]]
          .map((v) => Math.max(0, Math.min(255, Math.round(parseFloat(v)))).toString(16).padStart(2, "0"))
          .join("").toUpperCase();
      }
    }
  } catch { /* SSR or detached document */ }
  return fallback;
}

const isTransparent = (c) => !c || c === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(String(c));

/* ---------------- image helpers ---------------- */

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

function waitImages(node) {
  const imgs = Array.from(node.querySelectorAll("img"));
  return Promise.all(imgs.map((img) => (img.complete && img.naturalWidth
    ? Promise.resolve()
    : new Promise((r) => {
        const done = () => { img.onload = null; img.onerror = null; r(); };
        img.onload = done; img.onerror = done;
        setTimeout(done, 12000); // never hang the whole export on one broken image
      }))));
}

const dataUrlMemo = new Map();
async function toDataUrl(url) {
  if (!url || typeof url !== "string" || url.startsWith("data:")) return url;
  if (dataUrlMemo.has(url)) return dataUrlMemo.get(url);
  const job = (async () => {
    try {
      const img = await loadImg(url);
      const c = document.createElement("canvas");
      c.width = img.naturalWidth || img.width || 1600;
      c.height = img.naturalHeight || img.height || 900;
      c.getContext("2d").drawImage(img, 0, 0);
      const data = c.toDataURL("image/jpeg", 0.9);
      c.width = c.height = 0;
      return data;
    } catch {
      return url;
    }
  })();
  dataUrlMemo.set(url, job);
  return job;
}

/* ================================================================
   Slide -> HTML  (identical styling to the editor & the preview)
   ================================================================ */

async function elementHTML(el, theme) {
  const type = el.type || "text";
  const frame = styleToCss({ ...frameStyle(el), zIndex: 1 });

  if (type === "rect" || type === "ellipse") {
    return `<div style="${frame}"><div style="${styleToCss(shapeInnerStyle(el))}"></div></div>`;
  }
  if (type === "line") {
    return `<div style="${frame}"><div style="${styleToCss(shapeInnerStyle(el))}">` +
           `<div style="${styleToCss(lineBarStyle(el))}"></div></div></div>`;
  }
  if (type === "image") {
    const src = await toDataUrl(el.src);
    return `<div style="${frame}"><img src="${esc(src)}" style="${styleToCss(imageStyle(el))}" /></div>`;
  }
  return `<div style="${frame}"><div class="kx" style="${styleToCss(textStyle(el, theme))}">` +
         `${renderMixed(el.content || "")}</div></div>`;
}

async function slideHTML(sl, theme) {
  const parts = await Promise.all((sl.elements || []).map((el) => elementHTML(el, theme)));

  let bg;
  if (sl?.bgImage) {
    const bgData = await toDataUrl(sl.bgImage);
    bg = `<img src="${esc(bgData)}" style="position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;z-index:0;margin:0;padding:0;" />`;
  } else {
    bg = `<div style="position:absolute;left:0;top:0;width:100%;height:100%;background:${sl?.bgColor || theme.bg};z-index:0;margin:0;padding:0;"></div>`;
  }

  return `<div style="position:relative;width:${DESIGN_W}px;height:${DESIGN_H}px;color:${theme.text};` +
         `overflow:hidden;box-sizing:border-box;margin:0;padding:0;">${bg}${parts.join("")}</div>`;
}

/* ================================================================
   FALLBACK PATH ONLY — html2canvas sandbox + KaTeX flattening
   ----------------------------------------------------------------
   Everything from here to "Rasteriser" is dead code on any browser that supports
   <foreignObject> (all current ones). It stays as a safety net.
   ================================================================ */

let sandbox = null;
const KATEX_FONTS = ["KaTeX_Main", "KaTeX_Math", "KaTeX_Size1", "KaTeX_AMS"];

async function createSandbox() {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("tabindex", "-1");
  iframe.style.cssText =
    `position:fixed;left:-100000px;top:0;width:${DESIGN_W}px;height:${DESIGN_H}px;` +
    "border:0;opacity:0;pointer-events:none;";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) throw new Error("sandbox unavailable");
  doc.open();
  doc.write(
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<base href="${esc(window.location.href)}">` +
    '</head><body style="margin:0;padding:0;background:#fff;"></body></html>',
  );
  doc.close();

  const pending = [];
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    const clone = node.cloneNode(true);
    doc.head.appendChild(clone);
    if (clone.tagName === "LINK") {
      pending.push(new Promise((r) => {
        if (clone.sheet) return r();
        clone.addEventListener("load", r, { once: true });
        clone.addEventListener("error", r, { once: true });
        setTimeout(r, 8000);
      }));
    }
  }
  await Promise.all(pending);
  try { await doc.fonts.ready; } catch {}

  return { iframe, doc, win: iframe.contentWindow };
}

async function getSandbox() {
  if (sandbox && sandbox.iframe.isConnected && sandbox.doc?.body) return sandbox;
  sandbox = await createSandbox();
  return sandbox;
}

export function disposeSandbox() {
  try { sandbox?.iframe?.remove(); } catch {}
  sandbox = null;
}

async function ensureFonts(doc, families, needsMath) {
  const wanted = new Set(families);
  if (needsMath) KATEX_FONTS.forEach((f) => wanted.add(f));
  const jobs = [];
  for (const f of wanted) {
    for (const spec of [`400 16px ${fontStack(f)}`, `700 16px ${fontStack(f)}`]) {
      try { jobs.push(doc.fonts.load(spec)); } catch {}
    }
  }
  try { await Promise.all(jobs); } catch {}
  try { await doc.fonts.ready; } catch {}
  if (needsMath) {
    const ok = KATEX_FONTS.every((f) => { try { return doc.fonts.check(`16px ${f}`); } catch { return false; } });
    if (!ok) throw new Error("math fonts unavailable in sandbox");
  }
}

function classNameOf(el) {
  const c = el.className;
  return typeof c === "string" ? c : (c && c.baseVal) || "";
}

function isKatexRule(el, cs) {
  if (/frac-line|overline-line|underline-line|\brule\b|hline|sout/.test(classNameOf(el))) return true;
  return parseFloat(cs.borderBottomWidth) > 0.2 && el.childElementCount === 0 && !(el.textContent || "").trim();
}

function lineSegments(textNode) {
  const doc = textNode.ownerDocument;
  const text = textNode.nodeValue || "";
  const probe = doc.createRange();
  probe.selectNodeContents(textNode);
  if (probe.getClientRects().length <= 1) {
    const r = probe.getBoundingClientRect();
    return (r.width || r.height) ? [{ text, rect: r }] : [];
  }
  const rectFor = (a, b) => { const r = doc.createRange(); r.setStart(textNode, a); r.setEnd(textNode, b); return r.getBoundingClientRect(); };
  const out = [];
  let start = 0;
  let top = null;
  for (let i = 0; i < text.length; i++) {
    const r = rectFor(i, i + 1);
    if (top === null) top = r.top;
    else if (Math.abs(r.top - top) > 0.5) {
      out.push({ text: text.slice(start, i), rect: rectFor(start, i) });
      start = i; top = r.top;
    }
  }
  out.push({ text: text.slice(start), rect: rectFor(start, text.length) });
  return out.filter((s) => s.text.trim() && (s.rect.width || s.rect.height));
}

function katexPaintSpec(node) {
  const doc = node.ownerDocument;
  const win = doc.defaultView || window;

  let baselineY = null;
  const probe = doc.createElement("span");
  probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;";
  try {
    node.parentNode.insertBefore(probe, node);
    baselineY = probe.getBoundingClientRect().bottom;
  } catch {}

  const base = node.getBoundingClientRect();
  try { probe.remove(); } catch {}

  const depth = baselineY === null ? 0 : base.bottom - baselineY;

  const ops = [];
  const walk = (n) => {
    n.childNodes.forEach((ch) => {
      if (ch.nodeType === 3) {
        if (!(ch.nodeValue || "").trim()) return;
        const cs = win.getComputedStyle(ch.parentElement);
        if (cs.visibility === "hidden" || cs.display === "none") return;
        for (const seg of lineSegments(ch)) {
          ops.push({
            type: "text", text: seg.text,
            x: seg.rect.left - base.left, y: seg.rect.top - base.top, h: seg.rect.height,
            fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
            fontStyle: cs.fontStyle, color: cs.color, letterSpacing: cs.letterSpacing,
          });
        }
        return;
      }
      if (ch.nodeType !== 1) return;
      if (/katex-mathml/.test(classNameOf(ch))) return;
      const cs = win.getComputedStyle(ch);
      if (cs.display === "none" || cs.visibility === "hidden") return;

      if (ch.tagName.toLowerCase() === "svg") {
        const r = ch.getBoundingClientRect();
        ops.push({ type: "svg", html: ch.outerHTML, x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
        return;
      }
      if (isKatexRule(ch, cs)) {
        const r = ch.getBoundingClientRect();
        let color = cs.borderBottomColor;
        if (isTransparent(color)) color = cs.backgroundColor;
        if (isTransparent(color)) color = cs.color;
        ops.push({
          type: "rule",
          x: r.left - base.left, y: r.top - base.top,
          w: r.width || 1,
          h: Math.max(0.6, r.height || parseFloat(cs.borderBottomWidth) || 1),
          color,
        });
        return;
      }
      if (!isTransparent(cs.backgroundColor)) {
        const r = ch.getBoundingClientRect();
        if (r.width && r.height) {
          ops.push({ type: "rule", behind: true, x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height, color: cs.backgroundColor });
        }
      }
      walk(ch);
    });
  };
  walk(node);
  ops.sort((a, b) => (a.behind ? 0 : 1) - (b.behind ? 0 : 1));
  return { w: base.width, h: base.height, depth, ops };
}

function rebuildKatexNode(cloneNode, spec) {
  const doc = cloneNode.ownerDocument;
  const box = doc.createElement("span");
  box.style.cssText =
    "position:relative;display:inline-block;overflow:visible;line-height:normal;font-size:0;" +
    `width:${spec.w}px;height:${spec.h}px;vertical-align:${-spec.depth}px;`;

  for (const op of spec.ops) {
    if (op.type === "text") {
      const s = doc.createElement("span");
      s.textContent = op.text;
      s.style.cssText =
        `position:absolute;left:${op.x}px;top:${op.y}px;height:${op.h}px;line-height:${op.h}px;white-space:pre;` +
        `font-family:${op.fontFamily};font-size:${op.fontSize};font-weight:${op.fontWeight};` +
        `font-style:${op.fontStyle};color:${op.color};` +
        (op.letterSpacing && op.letterSpacing !== "normal" ? `letter-spacing:${op.letterSpacing};` : "");
      box.appendChild(s);
    } else if (op.type === "rule") {
      const d = doc.createElement("div");
      d.style.cssText = `position:absolute;left:${op.x}px;top:${op.y}px;width:${op.w}px;height:${op.h}px;background:${op.color};`;
      box.appendChild(d);
    } else if (op.type === "svg") {
      const wrap = doc.createElement("div");
      wrap.style.cssText = `position:absolute;left:${op.x}px;top:${op.y}px;width:${op.w}px;height:${op.h}px;`;
      wrap.innerHTML = op.html;
      const svg = wrap.firstChild;
      if (svg && svg.style) { svg.style.width = "100%"; svg.style.height = "100%"; }
      box.appendChild(wrap);
    }
  }
  cloneNode.replaceWith(box);
}

function fontsUsedBy(sl) {
  const set = new Set(["Inter"]);
  (sl.elements || []).forEach((el) => { if (isTextElement(el) && el.fontFamily) set.add(el.fontFamily); });
  return set;
}

async function rasteriseWithHtml2Canvas(root, html, targetWidth, needsMath, families) {
  const doc = root.ownerDocument;

  const host = doc.createElement("div");
  host.setAttribute("data-export-root", "1");
  host.style.cssText =
    `position:absolute;left:0;top:0;width:${DESIGN_W}px;height:${DESIGN_H}px;` +
    "overflow:hidden;background:#ffffff;margin:0;padding:0;";
  host.innerHTML = html;
  root.appendChild(host);

  try {
    await ensureFonts(doc, families, needsMath);
    await waitImages(host);
    await new Promise((r) => setTimeout(r, 30));

    const specs = Array.from(host.querySelectorAll(".katex")).map(katexPaintSpec);

    return await html2canvas(host, {
      width: DESIGN_W,
      height: DESIGN_H,
      windowWidth: DESIGN_W,
      windowHeight: DESIGN_H,
      x: 0,
      y: 0,
      scrollX: 0,
      scrollY: 0,
      scale: targetWidth / DESIGN_W,
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
      imageTimeout: 15000,
      onclone: (clonedDoc) => {
        const clonedHost = clonedDoc.querySelector('[data-export-root="1"]');
        if (!clonedHost) return;
        const nodes = Array.from(clonedHost.querySelectorAll(".katex"));
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (specs[i]) rebuildKatexNode(nodes[i], specs[i]);
        }
      },
    });
  } finally {
    try { host.remove(); } catch {}
  }
}

async function legacyRender(sl, theme, html, targetWidth) {
  const needsMath = deckNeedsMath([sl]);
  const families = fontsUsedBy(sl);
  try {
    const sb = await getSandbox();
    return await rasteriseWithHtml2Canvas(sb.doc.body, html, targetWidth, needsMath, families);
  } catch (e) {
    console.warn("[SlideBaba] sandbox render unavailable, using main document:", e?.message || e);
    disposeSandbox();
    const fallback = document.createElement("div");
    fallback.style.cssText = "position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;";
    document.body.appendChild(fallback);
    try {
      return await rasteriseWithHtml2Canvas(fallback, html, targetWidth, needsMath, families);
    } finally {
      fallback.remove();
    }
  }
}

/* ================================================================
   Rasteriser
   ================================================================ */

/**
 * Render one slide to a canvas at the requested resolution.
 *
 * Primary path: hand the slide's DOM to the browser through <foreignObject>, so the
 * bitmap IS the browser's own rendering of the preview. Falls back to html2canvas only
 * if that fails outright.
 *
 * @param {object}  sl          slide
 * @param {object}  theme       theme record
 * @param {number}  targetWidth output width in px
 * @param {object=} ctx         snapshot context from createSnapshotContext(); built on
 *                              demand when omitted (fine for one-off renders)
 */
export async function renderSlideToCanvas(sl, theme, targetWidth = 1792, ctx = null) {
  const html = await slideHTML(sl, theme);

  try {
    const context = ctx || (await createSnapshotContext([sl]));
    const hasContent = (sl.elements || []).length > 0;
    return await snapshotToCanvas(html, context, targetWidth, hasContent);
  } catch (e) {
    console.warn("[SlideBaba] snapshot renderer unavailable, falling back:", e?.message || e);
    return legacyRender(sl, theme, html, targetWidth);
  }
}

export async function slidesToImages(slides, THEMES, DEFAULT_THEME) {
  const out = [];
  let ctx = null;
  try { ctx = await createSnapshotContext(slides); } catch { ctx = null; }
  try {
    for (const sl of slides) {
      const theme = THEMES[sl.theme] || THEMES[DEFAULT_THEME];
      const canvas = await renderSlideToCanvas(sl, theme, 1600, ctx);
      out.push(canvas.toDataURL("image/jpeg", 0.88));
      canvas.width = canvas.height = 0;
      await yieldUI();
    }
  } finally {
    disposeSandbox();
    clearSnapshotCache();
  }
  return out;
}

/* ================================================================
   PDF — one snapshot page per slide
   ================================================================ */

export async function exportSlidesPdf(slides, THEMES, DEFAULT_THEME, title, onProgress) {
  // Page = exactly the PPTX slide size, so both exports print at the same scale.
  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: [SLIDE_W_PT, SLIDE_H_PT],
    compress: true,
  });

  const n = slides.length;
  // Big decks are memory-bound in the browser, so step the raster resolution down
  // rather than letting the tab run out of memory halfway through.
  const targetW = n > 80 ? 1600 : n > 40 ? 1920 : 2240;
  const quality = n > 80 ? 0.82 : 0.92;

  let ctx = null;
  try { ctx = await createSnapshotContext(slides); } catch { ctx = null; }

  try {
    for (let i = 0; i < n; i++) {
      const sl = slides[i];
      const theme = THEMES[sl.theme] || THEMES[DEFAULT_THEME];
      const canvas = await renderSlideToCanvas(sl, theme, targetW, ctx);
      const data = canvas.toDataURL("image/jpeg", quality);
      canvas.width = canvas.height = 0;
      if (i) pdf.addPage([SLIDE_W_PT, SLIDE_H_PT], "landscape");
      pdf.addImage(data, "JPEG", 0, 0, SLIDE_W_PT, SLIDE_H_PT, undefined, "FAST");
      if (typeof onProgress === "function") onProgress(i + 1, n);
      await yieldUI();
    }
    pdf.save(`${title || "slidebaba"}.pdf`);
  } finally {
    disposeSandbox();
    clearSnapshotCache();
  }
}

/* ================================================================
   PPTX — native + editable, laid out with the editor's own numbers
   ================================================================ */

/** camelCase object from an inline style string. */
function cssToObj(css) {
  const out = {};
  for (const decl of String(css || "").split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const key = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!key || !val) continue;
    out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
  }
  return out;
}

/**
 * Split stored content into styled runs.
 * Stored content is plain text + `$math$` + the safe `<span style="...">` tags the
 * editor writes for per-word styling. The old export pushed the whole string through
 * mixedToUnicode(), so those tags ended up VISIBLE in PowerPoint.
 */
function styledRuns(content) {
  const s = String(content || "");
  const runs = [];
  const stack = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    runs.push({ text: buf, style: Object.assign({}, ...stack) });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("</span>", i)) { flush(); stack.pop(); i += 7; continue; }
    const m = /^<span\s+style="([^"<>]*)">/.exec(s.slice(i, i + 400));
    if (m) { flush(); stack.push(cssToObj(m[1])); i += m[0].length; continue; }
    if (s.startsWith("<br>", i) || s.startsWith("<br/>", i) || s.startsWith("<br />", i)) {
      buf += "\n";
      i += s.startsWith("<br>", i) ? 4 : s.startsWith("<br/>", i) ? 5 : 6;
      continue;
    }
    buf += s[i];
    i += 1;
  }
  flush();
  return runs;
}

function pxOf(v, fallback) {
  const m = /^(-?[\d.]+)\s*px$/i.exec(String(v || "").trim());
  return m ? parseFloat(m[1]) : fallback;
}

/** Build the pptxgenjs rich-text array for one text element. */
function pptxTextRuns(el, theme) {
  const baseSizePx = el.fontSize || 20;
  const baseColor = pptColor(el.color || `#${theme.pptText}`, theme.pptText);
  const runs = [];

  for (const run of styledRuns(el.content)) {
    const st = run.style || {};
    const weight = st.fontWeight;
    const deco = String(st.textDecoration || "");
    const opts = {
      fontFace: (st.fontFamily || el.fontFamily || "Inter").replace(/['"]/g, "").split(",")[0].trim(),
      fontSize: Math.round(pxOf(st.fontSize, baseSizePx) * PT * 2) / 2,
      bold: weight ? parseInt(weight, 10) >= 600 || weight === "bold" : !!el.bold,
      italic: st.fontStyle ? st.fontStyle === "italic" : !!el.italic,
      color: st.color ? pptColor(st.color, baseColor) : baseColor,
    };
    const underline = deco ? /underline/.test(deco) : !!el.underline;
    const strike = deco ? /line-through/.test(deco) : !!el.strike;
    if (underline) opts.underline = { style: "sng" };
    if (strike) opts.strike = true;
    if (st.background && !isTransparent(st.background)) opts.highlight = pptColor(st.background, "FFFF00");

    // Math -> Unicode, per run, then split so newlines become real line breaks.
    const pieces = mixedToUnicode(run.text).split("\n");
    pieces.forEach((piece, idx) => {
      runs.push({ text: piece, options: { ...opts, breakLine: idx < pieces.length - 1 } });
    });
  }

  if (!runs.length) runs.push({ text: "", options: { color: baseColor } });
  return runs;
}

export async function exportSlidesPptx(slides, THEMES, DEFAULT_THEME, title, onProgress) {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "SB169", width: 10, height: 5.625 });
  pptx.layout = "SB169";
  const SW = 10, SH = 5.625;
  const PX_TO_IN = SW / DESIGN_W; // editor px -> inches

  const n = slides.length;
  for (let i = 0; i < n; i++) {
    const sl = slides[i];
    const theme = THEMES[sl.theme] || THEMES[DEFAULT_THEME];
    const s = pptx.addSlide();

    if (sl.bgImage) {
      s.background = { data: await toDataUrl(sl.bgImage) };
    } else if (sl.bgColor) {
      s.background = { color: pptColor(sl.bgColor, theme.pptBg) };
    } else {
      s.background = { color: theme.pptBg };
    }

    for (const el of sl.elements || []) {
      const box = { x: (el.x / 100) * SW, y: (el.y / 100) * SH, w: (el.w / 100) * SW, h: (el.h / 100) * SH };
      const type = el.type || "text";

      if (type === "image") {
        // The editor uses object-fit:fill, i.e. stretch to the frame — which is exactly
        // what addImage does without a `sizing` option.
        s.addImage({ data: await toDataUrl(el.src), ...box });
      } else if (type === "rect") {
        const radius = el.radius || 0;
        const line = el.strokeWidth
          ? { color: pptColor(el.stroke || "#000000"), width: el.strokeWidth * PT }
          : { type: "none" };
        if (radius > 0) {
          // pptxgenjs takes rectRadius in inches, measured on the shorter side.
          s.addShape("roundRect", {
            ...box,
            rectRadius: Math.min(radius * PX_TO_IN, Math.min(box.w, box.h) / 2),
            fill: { color: pptColor(el.fill || "#6d3aed") },
            line,
          });
        } else {
          s.addShape("rect", { ...box, fill: { color: pptColor(el.fill || "#6d3aed") }, line });
        }
      } else if (type === "ellipse") {
        s.addShape("ellipse", {
          ...box,
          fill: { color: pptColor(el.fill || "#ec4899") },
          line: el.strokeWidth ? { color: pptColor(el.stroke || "#000000"), width: el.strokeWidth * PT } : { type: "none" },
        });
      } else if (type === "line") {
        s.addShape("line", {
          x: box.x, y: box.y + box.h / 2, w: box.w, h: 0,
          line: { color: pptColor(el.stroke || "#000000"), width: (el.strokeWidth || 2) * PT },
        });
      } else {
        const sizePt = Math.round((el.fontSize || 20) * PT * 2) / 2;
        s.addText(pptxTextRuns(el, theme), {
          ...box,
          fontSize: sizePt,
          fontFace: el.fontFamily || "Inter",
          bold: !!el.bold,
          italic: !!el.italic,
          underline: el.underline ? { style: "sng" } : undefined,
          strike: !!el.strike,
          align: el.align || "left",
          color: pptColor(el.color || `#${theme.pptText}`, theme.pptText),
          fill: el.highlight && !isTransparent(el.highlight) ? { color: pptColor(el.highlight) } : undefined,
          valign: "top",
          wrap: true,
          // The editor draws the text with `padding: 2px 6px`; PowerPoint's own default
          // inset is 0.05in/0.1in, which is what shifted every line in the old export.
          margin: [TEXT_PAD_Y * PT, TEXT_PAD_X * PT, TEXT_PAD_Y * PT, TEXT_PAD_X * PT],
          // CSS line-height:1.35 expressed in points. `lineSpacingMultiple:1` used to
          // give PowerPoint's single spacing (~1.2), so every extra line drifted upward.
          lineSpacing: Math.round(sizePt * TEXT_LINE_HEIGHT * 10) / 10,
          paraSpaceBefore: 0,
          paraSpaceAfter: 0,
          autoFit: false,
          shrinkText: false,
          isTextBox: true,
        });
      }
    }
    if (typeof onProgress === "function") onProgress(i + 1, n);
    await yieldUI();
  }
  await pptx.writeFile({ fileName: `${title || "slidebaba"}.pptx` });
}
