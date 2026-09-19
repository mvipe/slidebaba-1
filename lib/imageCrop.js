/**
 * SlideBaba — page rasterising, cropping and accuracy slicing (browser side).
 *
 * ============================================================================
 * WHY THIS FILE WAS REWRITTEN (Sept 2026)
 * ============================================================================
 * Two separate bugs lived here, and together they are the reason a big PDF
 * "just said Try again" and why dense Hindi pages came back wrong.
 *
 * 1. MEMORY.  `pdfToPageImages` rendered EVERY page at scale 2.4 (~1700x2400)
 *    and kept a full-resolution JPEG data URL for each one in an array. A data
 *    URL is a JavaScript string, and strings are UTF-16 — 2 bytes per character.
 *    A 100-page paper is ~80 MB of base64, so ~160 MB of live string data, on
 *    top of every canvas backing store, held for the whole scan. Past roughly
 *    50 pages Chrome starts refusing canvas allocations: `toDataURL` quietly
 *    returns a blank image or `render` throws, the whole upload lands in the
 *    catch block, and the user sees "Try again" with no idea why. It looked
 *    exactly like a plan limit, which is why it was reported as one.
 *
 *    Fixed two ways: `openPdf()` lets the caller render a FEW pages at a time
 *    and throw them away as they are consumed, so peak memory no longer depends
 *    on the page count at all; and every canvas is explicitly released
 *    (`width = height = 0`) instead of waiting for the GC, which is what
 *    actually frees the backing store.
 *
 * 2. RESOLUTION.  Pages were rendered at 2.4x, then re-encoded DOWN to 1600px
 *    at quality 0.82 before upload — two lossy JPEG passes, ending at about
 *    145 DPI. Now the page is rendered ONCE, directly at the target size, at
 *    quality 0.95. One encode, no double loss, sharper glyphs.
 *
 * And one addition: `sliceForAccuracy()`. A vision model sees a fixed pixel
 * budget per image, so a whole A4 page gives each Devanagari matra only a pixel
 * or two. Cutting the page into overlapping slices and reading each one at full
 * size multiplies the effective resolution. `analyzePageLayout()` first looks
 * for a real vertical gutter so a two-column paper is cut into COLUMNS (which
 * preserves reading order) and a single-column paper into horizontal BANDS
 * (which never cuts a sentence in half).
 */

/* -------------------------------------------------------------------------- */
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Free a canvas's backing store immediately.
 *
 * Dropping the reference is NOT enough: the pixel buffer lives outside the JS heap
 * and is only reclaimed when the GC gets round to the wrapper, which on a long page
 * loop is far too late. Setting the dimensions to zero releases it now.
 */
function releaseCanvas(canvas) {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch { /* nothing to do */ }
}

function newCanvas(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
  // Scans are white paper. Filling first means a transparent PDF background never
  // comes out black once it is flattened into a JPEG.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode that image."));
    img.src = src;
  });
}

/** A data URL that is empty or all-white means the canvas allocation silently failed. */
function looksEmptyDataUrl(url) {
  return !url || url.length < 512 || url === "data:,";
}

/* -------------------------------------------------------------------------- */
/* basic image operations                                                      */
/* -------------------------------------------------------------------------- */

/** Crop a region out of an image data URL. rect = {x,y,w,h} in NATURAL pixels. */
export async function cropImage(src, rect, quality = 0.95) {
  const img = await loadImage(src);
  const { canvas, ctx } = newCanvas(rect.w, rect.h);
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL("image/jpeg", quality);
  releaseCanvas(canvas);
  return out;
}

/** Read an image file to a data URL. */
export function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("Could not read that file."));
    r.readAsDataURL(file);
  });
}

/** Load an image and return its natural dimensions. */
export async function imageSize(src) {
  const img = await loadImage(src);
  return { width: img.naturalWidth, height: img.naturalHeight };
}

/**
 * Shrink an image data URL so OCR uploads are small & fast (keeps aspect ratio).
 * Never upscales — an image already under `maxDim` is returned untouched, which
 * also means it is not re-encoded and does not lose a second generation of quality.
 */
export async function downscaleDataUrl(src, maxDim = 2400, quality = 0.95) {
  let img;
  try { img = await loadImage(src); } catch { return src; }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1) return src;

  const { canvas, ctx } = newCanvas(w * scale, h * scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL("image/jpeg", quality);
  releaseCanvas(canvas);
  return looksEmptyDataUrl(out) ? src : out;
}

/** A tiny preview copy. Used for the on-screen thumbnail so the big page image can be freed. */
export async function makeThumb(src, maxDim = 520, quality = 0.7) {
  try { return await downscaleDataUrl(src, maxDim, quality); }
  catch { return src; }
}

/* -------------------------------------------------------------------------- */
/* PDF rasterising                                                             */
/* -------------------------------------------------------------------------- */

let pdfjsPromise = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      // Worker from CDN matched to the installed version (avoids bundler config).
      pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

/**
 * Open a PDF once and render its pages ON DEMAND.
 *
 * This is the memory fix. The caller renders a small window of pages, OCRs them,
 * drops the images and asks for the next window, so peak memory is a handful of
 * pages no matter whether the document is 5 pages or 200.
 *
 * @returns {Promise<{numPages:number, renderPage:(i:number, opts?:object)=>Promise<string>, destroy:()=>void}>}
 */
export async function openPdf(file) {
  const pdfjs = await getPdfjs();
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

  return {
    numPages: pdf.numPages,

    /**
     * Render ONE page straight to its final OCR size.
     *
     * The scale is computed from the page's own dimensions so the long edge lands on
     * `maxDim` in a single render. The old code rendered at a fixed 2.4x and then
     * re-encoded down, which threw away quality twice for no reason.
     *
     * @param {number} i      1-based page number
     * @param {object} opts   { maxDim, quality, minScale, maxScale }
     */
    async renderPage(i, opts = {}) {
      const { maxDim = 2400, quality = 0.95, minScale = 0.5, maxScale = 5 } = opts;
      const page = await pdf.getPage(i);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = clamp(maxDim / Math.max(base.width, base.height), minScale, maxScale);
        const viewport = page.getViewport({ scale });
        const { canvas, ctx } = newCanvas(viewport.width, viewport.height);
        try {
          await page.render({ canvasContext: ctx, viewport, background: "#ffffff" }).promise;
          const url = canvas.toDataURL("image/jpeg", quality);
          if (looksEmptyDataUrl(url)) {
            throw new Error(
              `Page ${i} could not be rendered — the browser ran out of image memory. ` +
              "Close other tabs and try again, or split the PDF into smaller parts."
            );
          }
          return url;
        } finally {
          releaseCanvas(canvas);
        }
      } finally {
        try { page.cleanup(); } catch { /* older pdfjs */ }
      }
    },

    /**
     * Drop the DOCUMENT-level object cache. Call this between batches of pages.
     *
     * `page.cleanup()` only releases that one page's own objects. Anything pdf.js
     * considers SHARED lives in the document's common object store, and that store is
     * only cleared by `PDFDocumentProxy.cleanup()`.
     *
     * This matters far more than it sounds, because of how PowerPoint exports a PDF: it
     * puts the /Resources dictionary on the Pages tree NODE rather than on each page, so
     * every page inherits an XObject dict containing EVERY image in the deck. A 55-slide
     * export therefore tells pdf.js that page 1 has 55 images, page 2 has the same 55, and
     * so on. Each one decodes to width x height x 3 bytes — for a 1706x960 slide that is
     * 4.7 MB, so the deck's images are ~258 MB decoded. They accumulate in the shared
     * store, survive every page.cleanup(), and the tab dies somewhere in the middle.
     *
     * Safe only when no render is in flight — cleanup() aborts anything still drawing.
     */
    async cleanup() {
      try { await pdf.cleanup(); } catch { /* not fatal — it is a memory optimisation */ }
    },

    destroy() {
      try { pdf.cleanup(); } catch { /* ignore */ }
      try { pdf.destroy(); } catch { /* ignore */ }
    },
  };
}

/**
 * Render every page of a PDF to an image data URL.
 *
 * Kept for callers that genuinely want all pages at once (the snippet extractor,
 * which needs to display them). For the scan pipeline prefer `openPdf()` and render
 * in small windows — holding 100+ full-size pages is what used to crash the tab.
 *
 * @param {File} file
 * @param {object} opts  { maxDim, quality, maxPages, onProgress(done,total) }
 */
export async function pdfToPageImages(file, opts = {}) {
  // Back-compat: the old signature was pdfToPageImages(file, scale:number).
  const o = typeof opts === "number" ? { maxDim: Math.round(opts * 1000) } : (opts || {});
  const { maxDim = 2400, quality = 0.95, maxPages = 0, onProgress } = o;

  const doc = await openPdf(file);
  try {
    const total = maxPages > 0 ? Math.min(doc.numPages, maxPages) : doc.numPages;
    const pages = [];
    for (let i = 1; i <= total; i++) {
      // eslint-disable-next-line no-await-in-loop
      pages.push(await doc.renderPage(i, { maxDim, quality }));
      onProgress?.(i, total);
      // Let the browser breathe: a tight render loop starves the compositor and the
      // memory pressure signal that lets Chrome reclaim the canvases we just released.
      // eslint-disable-next-line no-await-in-loop
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return pages;
  } finally {
    doc.destroy();
  }
}

/** How many pages does this PDF have? Opens and closes it without rendering anything. */
export async function pdfPageCount(file) {
  const doc = await openPdf(file);
  try { return doc.numPages; } finally { doc.destroy(); }
}

/* -------------------------------------------------------------------------- */
/* layout analysis                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Look at the actual pixels and decide whether this page is one column or two.
 *
 * Aspect ratio cannot see columns — an A4 sheet is portrait whether it carries one
 * column or two — and guessing wrong is expensive in both directions: splitting a
 * single-column page down the middle cuts every sentence in half, while NOT splitting
 * a two-column page forces the model to interleave two reading orders.
 *
 * So: shrink the page, count dark pixels per x, and look for a tall clean gutter in
 * the middle third. A real two-column layout has one; a single-column page does not.
 *
 * @returns {Promise<{columns:1|2, splitFrac:number, ink:number, aspect:number}>}
 */
export async function analyzePageLayout(src) {
  const fallback = { columns: 1, splitFrac: 0.5, ink: 0, aspect: 1.4 };
  let img;
  try { img = await loadImage(src); } catch { return fallback; }

  const W = 340;
  const H = Math.max(40, Math.round((img.naturalHeight / img.naturalWidth) * W));
  const aspect = img.naturalHeight / Math.max(1, img.naturalWidth);

  const { canvas, ctx } = newCanvas(W, H);
  let data;
  try {
    ctx.drawImage(img, 0, 0, W, H);
    data = ctx.getImageData(0, 0, W, H).data;
  } catch {
    releaseCanvas(canvas);
    return { ...fallback, aspect };
  }
  releaseCanvas(canvas);

  // Dark-pixel count per column of the shrunken page.
  const colInk = new Float32Array(W);
  let totalInk = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      const p = row + x * 4;
      // Rec. 601 luma is plenty here and avoids three multiplications per pixel.
      const luma = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
      if (luma < 170) { colInk[x] += 1; totalInk += 1; }
    }
  }
  const ink = totalInk / (W * H);

  // A nearly blank page has no layout worth splitting.
  if (ink < 0.004) return { columns: 1, splitFrac: 0.5, ink, aspect };

  // Smooth so a single stray speck cannot close a real gutter.
  const smooth = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = -2; k <= 2; k++) {
      const xx = x + k;
      if (xx >= 0 && xx < W) { s += colInk[xx]; n++; }
    }
    smooth[x] = s / n;
  }

  // A gutter is a run of near-empty columns. Require it to be genuinely empty
  // (under 1.2% of the page height) and at least 1.8% of the width wide.
  const emptyAt = H * 0.012;
  const minRun = Math.max(5, Math.round(W * 0.018));
  const from = Math.round(W * 0.36);
  const to = Math.round(W * 0.64);

  let best = null;
  let runStart = -1;
  for (let x = from; x <= to; x++) {
    const isEmpty = smooth[x] <= emptyAt;
    if (isEmpty && runStart < 0) runStart = x;
    if ((!isEmpty || x === to) && runStart >= 0) {
      const end = isEmpty ? x : x - 1;
      const len = end - runStart + 1;
      if (len >= minRun && (!best || len > best.len)) best = { len, center: (runStart + end) / 2 };
      runStart = -1;
    }
  }

  // Both sides of the gutter must actually carry text, otherwise it is just a margin
  // next to an empty half rather than a real second column.
  if (best) {
    const c = Math.round(best.center);
    let left = 0, right = 0;
    for (let x = 0; x < c; x++) left += colInk[x];
    for (let x = c; x < W; x++) right += colInk[x];
    const lean = Math.min(left, right) / Math.max(1, Math.max(left, right));
    if (lean > 0.25) return { columns: 2, splitFrac: best.center / W, ink, aspect };
  }

  return { columns: 1, splitFrac: 0.5, ink, aspect };
}

/* -------------------------------------------------------------------------- */
/* accuracy slicing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Cut one page into overlapping slices, each of which is read separately at full
 * resolution. This is the single biggest accuracy lever available on the client.
 *
 * A vision model spends a fixed pixel budget per image, so a whole A4 page leaves a
 * Devanagari matra one or two pixels tall. Reading the same page as two slices gives
 * every glyph roughly twice the pixels, which is the difference between "बताइये" and
 * "बताइए". The overlap means nothing is lost at a seam, and the caller de-duplicates
 * whatever appears in both.
 *
 * Reading order is preserved: columns left-to-right, bands top-to-bottom.
 *
 * @param {string} src    page image data URL
 * @param {object} opts   { maxSlices, overlap, quality, layout }
 * @returns {Promise<Array<{image:string, part:{index:number,total:number,kind:"band"|"column"}}>>}
 */
export async function sliceForAccuracy(src, opts = {}) {
  const { maxSlices = 2, quality = 0.95 } = opts;
  if (maxSlices < 2) return [];

  let size;
  try { size = await imageSize(src); } catch { return []; }
  const { width, height } = size;
  // Too small to gain anything — slicing a postage stamp just adds API calls.
  if (width < 700 || height < 700) return [];

  const layout = opts.layout || (await analyzePageLayout(src));

  /* ---- two columns: cut vertically at the gutter ---- */
  if (layout.columns === 2) {
    const overlap = opts.overlap ?? 0.035;
    const split = clamp(layout.splitFrac, 0.3, 0.7);
    const bounds = [
      { from: 0, to: Math.min(1, split + overlap) },
      { from: Math.max(0, split - overlap), to: 1 },
    ];
    const out = [];
    for (let i = 0; i < bounds.length; i++) {
      const b = bounds[i];
      const x = Math.round(b.from * width);
      const w = Math.round((b.to - b.from) * width);
      // eslint-disable-next-line no-await-in-loop
      const image = await cropImage(src, { x, y: 0, w, h: height }, quality);
      out.push({ image, part: { index: i, total: bounds.length, kind: "column" } });
    }
    return out;
  }

  /* ---- one column: cut horizontally into bands ---- */
  // A taller page carries more lines, so it earns a third band when allowed.
  const n = clamp(layout.aspect >= 1.9 ? 3 : 2, 2, maxSlices);
  const overlap = opts.overlap ?? 0.1;
  const stride = 1 / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i * stride - (i > 0 ? overlap : 0));
    const to = Math.min(1, (i + 1) * stride + (i < n - 1 ? overlap : 0));
    const y = Math.round(from * height);
    const h = Math.round((to - from) * height);
    // eslint-disable-next-line no-await-in-loop
    const image = await cropImage(src, { x: 0, y, w: width, h }, quality);
    out.push({ image, part: { index: i, total: n, kind: "band" } });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* legacy tiling (Model 2 / PaddleOCR path)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Split a page image into overlapping VERTICAL strips (columns).
 * Still used by the PaddleOCR path, whose thin-page fallback was written against it.
 *   n = number of vertical strips (2 for two-column, 3 for very dense)
 *   overlap = fraction of width shared between neighbours so nothing is cut at the seam
 */
export async function tilePageImage(src, n = 2, overlap = 0.06) {
  const { width, height } = await imageSize(src);
  if (n <= 1 || width < 700) return [src];
  const tiles = [];
  const strideFrac = 1 / n;
  for (let i = 0; i < n; i++) {
    const startFrac = Math.max(0, i * strideFrac - (i > 0 ? overlap : 0));
    const endFrac = Math.min(1, (i + 1) * strideFrac + (i < n - 1 ? overlap : 0));
    const x = Math.round(startFrac * width);
    const w = Math.round((endFrac - startFrac) * width);
    // eslint-disable-next-line no-await-in-loop
    tiles.push(await cropImage(src, { x, y: 0, w, h: height }));
  }
  return tiles;
}

/**
 * Decide how many vertical tiles to use. Kept for the PaddleOCR path.
 * Prefer `analyzePageLayout()` — it looks at the pixels instead of guessing from shape.
 */
export function suggestTileCount(width, height) {
  const ar = width / height;
  if (width < 900) return 1;     // too small / narrow to be two columns
  if (ar >= 1.5) return 3;       // very wide spread -> likely 2-3 columns, tile more
  return 2;                      // portrait or landscape sheet -> treat as two-column
}
