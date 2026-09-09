/**
 * The user's reusable brand — logo + coaching name — shared by BOTH editors.
 *
 * WHY THIS EXISTS
 *   The slide editor already had branding: it stored `{ logo, name, wh }` on the user's
 *   profile (`users/{uid}.brand`) and stamped it onto every slide. The A4 notes editor had
 *   its own, completely disjoint version: a per-DOCUMENT `header.logo`, never read from or
 *   written to the profile. So a coaching centre that set up its logo for slides had to set
 *   it up again for notes, and changing it meant changing it twice.
 *
 *   One brand, one place. `readBrand` / `writeBrand` are the whole contract.
 *
 * The logo is a base64 data URL. It is small by construction — every writer downscales
 * through `prepareLogo` first — because it also has to fit inside a Firestore document.
 */

import { saveBrand } from "@/lib/plan";
import { fileToDataUrl, downscaleDataUrl, imageSize } from "@/lib/imageCrop";

/** Longest edge for a stored logo. Generous on screen, tiny in bytes. */
export const LOGO_MAX_DIM = 400;
export const LOGO_QUALITY = 0.85;

/** Read the brand off a loaded profile. Always returns a usable shape. */
export function readBrand(profile) {
  const b = profile?.brand || {};
  return {
    logo: typeof b.logo === "string" ? b.logo : "",
    name: typeof b.name === "string" ? b.name : "",
    wh: Number(b.wh) || 0,
  };
}

/**
 * Turn a picked file into a stored logo: downscaled, plus its aspect ratio so the slide
 * editor can size the stamped image without re-measuring.
 */
export async function prepareLogo(file) {
  if (!file) return null;
  const raw = await fileToDataUrl(file);
  const logo = await downscaleDataUrl(raw, LOGO_MAX_DIM, LOGO_QUALITY);
  let wh = 0;
  try {
    const { width, height } = await imageSize(logo);
    if (width && height) wh = height / width;
  } catch { /* aspect ratio is a nicety, not a requirement */ }
  return { logo, wh };
}

/**
 * Persist the brand to the user's profile and patch the in-memory profile.
 * Throws on failure so a caller can say so — saveBrand() itself only logs.
 */
export async function writeBrand(uid, brand, mergeProfile) {
  const clean = {
    logo: brand?.logo || "",
    name: brand?.name || "",
    wh: Number(brand?.wh) || 0,
  };
  mergeProfile?.({ brand: clean });
  if (uid) await saveBrand(uid, clean);
  return clean;
}
