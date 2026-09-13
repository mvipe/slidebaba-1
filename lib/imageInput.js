/**
 * Decoding a page image for an OCR engine.
 *
 * WHY THIS IS ITS OWN MODULE
 *   This used to live in lib/paddleocr.js, and lib/openaiOcr.js imported it from there.
 *   That meant Model 1 (ChatGPT) pulled the entire PaddleOCR adapter into its module graph
 *   to reuse one pure function — so "the ChatGPT engine" was not actually independent of
 *   the PaddleOCR engine, and a change to the Paddle side could affect the ChatGPT side.
 *
 *   Neither engine should be able to reach the other. This file is the shared, neutral
 *   piece they both legitimately need: turning whatever the browser sent into bytes.
 */

const DATA_URL_RE = /^data:([^;,]*)?(;[^,]*)?,(.*)$/s;

/**
 * Accepts a data: URL, a bare base64 string, or an http(s) URL.
 * Returns { base64, bytes, mime, fileType, isUrl, url }.
 * fileType follows the PaddleOCR API convention: 0 = PDF, 1 = image.
 */
export function readImageInput(image) {
  const raw = String(image || "").trim();
  if (!raw) throw new Error("Missing image data.");

  if (/^https?:\/\//i.test(raw)) {
    const isPdf = /\.pdf(\?|#|$)/i.test(raw);
    return { base64: "", bytes: null, mime: isPdf ? "application/pdf" : "image/*", fileType: isPdf ? 0 : 1, isUrl: true, url: raw };
  }

  let mime = "image/png";
  let b64 = raw;
  const m = raw.match(DATA_URL_RE);
  if (m) {
    mime = (m[1] || "image/png").toLowerCase();
    b64 = m[3] || "";
    if (!/;base64/i.test(m[2] || "")) {
      // Rare: a non-base64 data URL. Re-encode so the API always gets base64.
      b64 = Buffer.from(decodeURIComponent(b64), "utf8").toString("base64");
    }
  }
  b64 = b64.replace(/\s+/g, "");
  if (!b64) throw new Error("Image payload is empty.");

  let bytes;
  try { bytes = Buffer.from(b64, "base64"); }
  catch { throw new Error("Image payload is not valid base64."); }
  if (!bytes.length) throw new Error("Image payload decoded to zero bytes.");

  const isPdf = mime.includes("pdf") || bytes.slice(0, 4).toString("latin1") === "%PDF";
  return { base64: b64, bytes, mime: isPdf ? "application/pdf" : mime, fileType: isPdf ? 0 : 1, isUrl: false, url: "" };
}

export function extForMime(mime) {
  if (!mime) return "png";
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("bmp")) return "bmp";
  if (mime.includes("tif")) return "tiff";
  return "png";
}
