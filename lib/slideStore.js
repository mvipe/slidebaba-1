import { splitTextAndTables } from "@/lib/tableText";
// Handoff between AI Studio and the editor (sessionStorage) + shared themes,
// fonts and element factories used by the editor and exporter.

export const THEMES = {
  "clean-white": { id: "clean-white", label: "Clean White", bg: "#ffffff", text: "#0b0a18", accent: "#6d3aed", dot: "#6d3aed", pptBg: "FFFFFF", pptText: "0B0A18" },
  "soft-gray": { id: "soft-gray", label: "Soft Gray", bg: "#f1f5f9", text: "#0f172a", accent: "#6d3aed", dot: "#64748b", pptBg: "F1F5F9", pptText: "0F172A" },
  "midnight-purple": { id: "midnight-purple", label: "Midnight Purple", bg: "#1a1340", text: "#ffffff", accent: "#a78bfa", dot: "#7c5cff", pptBg: "1A1340", pptText: "FFFFFF" },
  "deep-ink": { id: "deep-ink", label: "Deep Ink", bg: "#0b0a18", text: "#f3f1ff", accent: "#ec4899", dot: "#ec4899", pptBg: "0B0A18", pptText: "F3F1FF" },
  "sunset": { id: "sunset", label: "Sunset", bg: "#1f1020", text: "#ffe9d6", accent: "#fb923c", dot: "#f97316", pptBg: "1F1020", pptText: "FFE9D6" },
  "ocean": { id: "ocean", label: "Ocean", bg: "#0c2233", text: "#e6f6ff", accent: "#38bdf8", dot: "#0ea5e9", pptBg: "0C2233", pptText: "E6F6FF" },
  "forest": { id: "forest", label: "Forest", bg: "#0e2a1f", text: "#e7fff2", accent: "#34d399", dot: "#10b981", pptBg: "0E2A1F", pptText: "E7FFF2" },
};

export const DEFAULT_THEME = "clean-white";

// Fonts offered in the editor (loaded via Google Fonts <link> in layout.js).
export const FONTS = [
  "Inter", "Sora", "Plus Jakarta Sans", "Lexend", "Poppins", "Roboto", "Montserrat",
  "Lato", "Open Sans", "Nunito", "Raleway", "Work Sans", "DM Sans", "Space Grotesk",
  "Merriweather", "Playfair Display", "Lora", "PT Serif", "Oswald", "Bebas Neue",
  "Source Sans 3", "Quicksand", "Comfortaa", "Caveat", "Roboto Mono", "Georgia", "Arial",
];

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ---------- element factories ---------- */
export function newText(partial = {}) {
  return {
    id: uid("el"), type: "text", content: "New text",
    x: 12, y: 40, w: 60, h: 14,
    fontSize: 20, fontFamily: "Inter", bold: false, italic: false, underline: false, strike: false,
    align: "left", color: "", highlight: "", ...partial,
  };
}
export function newRect(partial = {}) {
  return { id: uid("el"), type: "rect", x: 30, y: 35, w: 30, h: 22, fill: "#6d3aed", stroke: "", strokeWidth: 0, radius: 8, ...partial };
}
export function newEllipse(partial = {}) {
  return { id: uid("el"), type: "ellipse", x: 32, y: 32, w: 26, h: 26, fill: "#ec4899", stroke: "", strokeWidth: 0, ...partial };
}
export function newLine(partial = {}) {
  return { id: uid("el"), type: "line", x: 20, y: 50, w: 60, h: 6, stroke: "#0b0a18", strokeWidth: 3, ...partial };
}
export function newImage(src, partial = {}) {
  return { id: uid("el"), type: "image", src, x: 25, y: 25, w: 50, h: 40, radius: 8, ...partial };
}

/**
 * A table element.
 *
 * `rows` is a rectangular array of plain strings (which may contain $math$). Everything
 * else is presentation and has a sensible default in slideRender.TABLE_DEFAULTS, so an
 * element written by an older build still renders.
 *
 * Height is a starting box only — frameStyle lets tables grow downwards, so a table with
 * more rows than the box is never clipped.
 */
export function newTable(partial = {}) {
  const rows = Array.isArray(partial.rows) && partial.rows.length
    ? partial.rows
    : [["Column 1", "Column 2", "Column 3"], ["", "", ""], ["", "", ""]];
  const cols = Math.max(1, ...rows.map((r) => (Array.isArray(r) ? r.length : 1)));
  return {
    id: uid("el"), type: "table",
    x: 8, y: 28, w: 84, h: 34,
    rows,
    colW: Array(cols).fill(100 / cols),
    header: true,
    fontSize: 15, fontFamily: "Inter", color: "",
    align: "left",
    borderColor: "#94a3b8", borderWidth: 1,
    headerFill: "#eef2f7", headerBold: true, cellFill: "",
    cellPadX: 8, cellPadY: 5,
    ...partial,
  };
}

/* ---------- AI -> slides ---------- */
export function slidesFromOutline(outline, theme = DEFAULT_THEME) {
  const list = Array.isArray(outline) ? outline : [];
  return list.map((s) => ({
    id: uid("slide"),
    theme,
    elements: [
      newText({ content: s.title || "Untitled", x: 6, y: 8, w: 88, h: 16, fontSize: 34, fontFamily: "Sora", bold: true }),
      newText({ content: (s.bullets || []).map((b) => `• ${b}`).join("\n"), x: 6, y: 28, w: 88, h: 60, fontSize: 20 }),
    ],
  }));
}

// One slide per item, full verbatim text.
// OCR'd tables become real table elements — see lib/tableText.js for why.
export function slidesFromItems(items, theme = DEFAULT_THEME) {
  const list = Array.isArray(items) ? items : [];
  return list.map((it, i) => ({
    id: uid("slide"),
    theme,
    elements: [
      newText({ content: it.title || `Q${i + 1}`, x: 6, y: 7, w: 88, h: 12, fontSize: 28, fontFamily: "Sora", bold: true }),
      ...bodyElements(it.text || "", { y: 24, h: 66, fontSize: 22 }),
    ],
  }));
}

/**
 * Turn one item's body text into elements, stacking prose and tables in printed order.
 * Heights are a rough share of the available band; the editor and the fitted builder
 * refine them. Used by both the SSR fallback above and lib/slideLayout.js.
 */
export function bodyElements(text, { y = 24, h = 66, fontSize = 22, x = 6, w = 88 } = {}) {
  const parts = splitTextAndTables(text);
  if (!parts.length) return [newText({ content: "", x, y, w, h, fontSize })];
  if (parts.length === 1 && parts[0].kind === "text") {
    return [newText({ content: parts[0].text, x, y, w, h, fontSize })];
  }

  // Weight each piece so tables get room proportional to their row count.
  const weights = parts.map((p) => (p.kind === "table" ? Math.max(2, p.rows.length) : Math.max(2, Math.ceil(p.text.length / 90))));
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  let cursor = y;
  return parts.map((p, i) => {
    const share = (weights[i] / total) * h;
    const el = p.kind === "table"
      ? newTable({ rows: p.rows, header: p.header, x, y: cursor, w, h: Math.max(8, share), fontSize: Math.min(fontSize, 16) })
      : newText({ content: p.text, x, y: cursor, w, h: Math.max(6, share), fontSize });
    cursor += share;
    return el;
  });
}

/* ---------- handoff ----------
   Studio → editor / documents → editor uses this to pass a document across a client-side
   navigation. It used to go through sessionStorage only, which is capped at ~5 MB: a deck
   containing a couple of images threw QuotaExceededError, the exception escaped, and the
   document opened blank. Navigation inside the app never reloads the page, so an in-memory
   handoff is both faster and unlimited; sessionStorage is kept purely as a best-effort
   fallback for a hard refresh and is allowed to fail silently. */

let memoryHandoff = null;
const SS_KEY = "slidebaba:handoff";

export function saveHandoff(payload) {
  if (typeof window === "undefined") return;
  memoryHandoff = payload;
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify(payload));
  } catch {
    // Too big for sessionStorage — the in-memory copy still carries it across the navigation.
    try { sessionStorage.removeItem(SS_KEY); } catch {}
  }
}

export function readHandoff() {
  if (typeof window === "undefined") return null;
  if (memoryHandoff) return memoryHandoff;
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearHandoff() {
  if (typeof window === "undefined") return;
  memoryHandoff = null;
  try { sessionStorage.removeItem(SS_KEY); } catch {}
}
