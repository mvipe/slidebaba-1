// Crop a region out of an image data URL. rect = {x,y,w,h} in NATURAL pixels.
export function cropImage(src, rect) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = Math.max(1, Math.round(rect.w));
      const h = Math.max(1, Math.round(rect.h));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = reject;
    img.src = src;
  });
}

// Read an image file to a data URL.
export function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// Render every page of a PDF to an image data URL using pdfjs-dist.
export async function pdfToPageImages(file, scale = 2.4) {
  const pdfjs = await import("pdfjs-dist");
  // Worker from CDN matched to the installed version (avoids bundler config).
  pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    pages.push(canvas.toDataURL("image/jpeg", 0.9));
  }
  return pages;
}

// Load an image and return its natural dimensions.
export function imageSize(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = src;
  });
}

// Shrink an image data URL so OCR uploads are small & fast (keeps aspect ratio).
export function downscaleDataUrl(src, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      if (scale >= 1) {
        resolve(src);
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

// Split a page image into overlapping vertical TILES so each region can be OCR'd
// at high resolution. Dense two-column exam pages lose accuracy when the whole
// page is squeezed into one 2048px image (each character gets too few pixels);
// tiling gives each half/third far more effective resolution.
//   n = number of vertical strips (2 for two-column, 3 for very dense)
//   overlap = fraction of width shared between neighbours so nothing is cut at the seam
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
    // full height, just a vertical slice
    // eslint-disable-next-line no-await-in-loop
    const tile = await cropImage(src, { x, y: 0, w, h: height });
    tiles.push(tile);
  }
  return tiles;
}

// Decide how many vertical tiles to use. Indian exam/answer-key pages are almost always
// TWO-COLUMN even when the sheet is portrait, so we tile by default and only skip tiling
// for clearly narrow single-column images. Aspect ratio alone can't see columns, so we
// lean towards 2 tiles (which is safe: overlap + de-dup means nothing is lost or doubled).
export function suggestTileCount(width, height) {
  const ar = width / height;
  if (width < 900) return 1;     // too small / narrow to be two columns
  if (ar >= 1.5) return 3;       // very wide spread -> likely 2-3 columns, tile more
  return 2;                      // portrait or landscape sheet -> treat as two-column
}