/**
 * Diagrams / figures in scanned questions.
 *
 * The OCR text is text-only, so a question's diagram used to be dropped. Now the vision
 * model marks each figure where it appears, with its box on the page:
 *
 *   [[FIGURE ymin,xmin,ymax,xmax]]        0–1000 page scale (Gemini's native box format)
 *
 * The Studio crops that box out of the page image it already holds and swaps the marker
 * for a short reference while the text travels through splitting:   [[FIG:f3]]
 * and, once the questions are built, for the image itself:           [[IMG:data:image/jpeg;base64,…]]
 *
 * Slides turn [[IMG:…]] into an image box, notes and the preview into an <img>.
 * No imports: used by the Studio, the slide builder and the notes editor alike.
 */

const MARK_SRC = String.raw`\[\[\s*FIGURE\s*:?\s*(\d{1,4})\s*,\s*(\d{1,4})\s*,\s*(\d{1,4})\s*,\s*(\d{1,4})\s*\]\]`;
const REF_SRC = String.raw`\[\[FIG:([A-Za-z0-9_-]+)\]\]`;
const IMG_SRC = String.raw`\[\[IMG:(data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+)\]\]`;

export const figureMarkRe = () => new RegExp(MARK_SRC, "gi");
export const figureRefRe = () => new RegExp(REF_SRC, "g");
export const imageTokenRe = () => new RegExp(IMG_SRC, "g");

const tidy = (s) => String(s || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Remove raw figure markers (used where their coordinates would be wrong, e.g. page slices). */
export function stripFigureMarks(text) {
  return tidy(String(text || "").replace(figureMarkRe(), ""));
}

/** Text with its images taken out: { text, images:[dataUrl] } — for layouts that place images separately. */
export function extractImages(text) {
  const images = [];
  const rest = String(text || "").replace(imageTokenRe(), (_, src) => { images.push(src); return ""; });
  return { text: tidy(rest), images };
}

/** Text and images in printed order — for views that flow them inline (notes, preview). */
export function splitTextAndImages(text) {
  const src = String(text || "");
  const parts = [];
  let last = 0;
  const re = imageTokenRe();
  let m;
  while ((m = re.exec(src))) {
    const before = tidy(src.slice(last, m.index));
    if (before) parts.push({ kind: "text", text: before });
    parts.push({ kind: "image", src: m[1] });
    last = m.index + m[0].length;
  }
  const after = tidy(src.slice(last));
  if (after) parts.push({ kind: "text", text: after });
  return parts;
}

/** Does this text carry any figure at all (marker, reference or image)? */
export function hasFigures(text) {
  const s = String(text || "");
  return figureMarkRe().test(s) || figureRefRe().test(s) || imageTokenRe().test(s);
}
