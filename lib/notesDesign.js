/**
 * Page design for the A4 notes editor — the notes-side equivalent of the slide editor's
 * themes and background panel.
 *
 * WHY THIS IS A SEPARATE MODULE
 *   The on-screen page and the PRINTED page have to agree. The notes editor exports its
 *   PDF through `window.print()`, so the page's CSS width and the `@page` size are two
 *   different declarations of the same fact — and when they drift, the preview and the
 *   PDF disagree, which is precisely the bug class lib/slideRender.js exists to prevent on
 *   the slides side. Deriving both from ONE table here makes that impossible.
 *
 * Everything is stored on the document (in the chunked payload, not the parent metadata —
 * see HEAVY_KEYS in lib/docs.js), so two documents can look completely different.
 */

/** Page sizes, in millimetres, with the CSS pixel width used on screen (96dpi). */
export const PAGE_SIZES = {
  a4:     { id: "a4",     label: "A4",     mm: [210, 297], px: 794,  cssSize: "A4" },
  letter: { id: "letter", label: "Letter", mm: [216, 279], px: 816,  cssSize: "Letter" },
  legal:  { id: "legal",  label: "Legal",  mm: [216, 356], px: 816,  cssSize: "Legal" },
};
export const DEFAULT_PAGE_SIZE = "a4";

/** Margin presets. `mm` drives @page; `css` drives the on-screen body padding. */
export const MARGINS = {
  compact: { id: "compact", label: "Compact", mm: 8,  css: "18px 22px" },
  normal:  { id: "normal",  label: "Normal",  mm: 10, css: "32px 40px" },
  wide:    { id: "wide",    label: "Wide",    mm: 16, css: "44px 64px" },
};
export const DEFAULT_MARGIN = "normal";

/**
 * Page themes. Deliberately the same *shape* as slideStore's THEMES (`bg` + `text`) so the
 * two editors can be given the same palette, but with paper-appropriate values — a slide's
 * dark themes are unreadable on a printed page and waste toner.
 */
export const PAGE_THEMES = {
  paper:    { id: "paper",    label: "Paper",     bg: "#ffffff", text: "#1e293b", head: "#5b21b6" },
  cream:    { id: "cream",    label: "Cream",     bg: "#fdf8ef", text: "#3f3527", head: "#8a5a12" },
  mint:     { id: "mint",     label: "Mint",      bg: "#f3fbf7", text: "#14342a", head: "#0f766e" },
  sky:      { id: "sky",      label: "Sky",       bg: "#f4f8ff", text: "#152036", head: "#1d4ed8" },
  graph:    { id: "graph",    label: "Grid",      bg: "#ffffff", text: "#1e293b", head: "#4338ca", grid: true },
};
export const DEFAULT_PAGE_THEME = "paper";

export const pageSize = (id) => PAGE_SIZES[id] || PAGE_SIZES[DEFAULT_PAGE_SIZE];
export const marginOf = (id) => MARGINS[id] || MARGINS[DEFAULT_MARGIN];
export const pageTheme = (id) => PAGE_THEMES[id] || PAGE_THEMES[DEFAULT_PAGE_THEME];

/** Everything a fresh document starts with. Also the shape hydration falls back to. */
export const DEFAULT_DESIGN = {
  theme: DEFAULT_PAGE_THEME,
  pageSize: DEFAULT_PAGE_SIZE,
  margin: DEFAULT_MARGIN,
  pageBg: "",        // overrides the theme background when set
  pageBgImage: "",   // overrides both when set
  bodyFont: "",      // "" = the stylesheet default
  bodySize: 15,
  footer: false,
  footerText: "",
};

/** Merge a stored design over the defaults, ignoring anything unrecognised. */
export function normalizeDesign(stored) {
  const d = stored && typeof stored === "object" ? stored : {};
  return {
    ...DEFAULT_DESIGN,
    ...Object.fromEntries(Object.entries(d).filter(([k]) => k in DEFAULT_DESIGN)),
  };
}

/** Inline style for the page surface itself. */
export function pageStyle(design) {
  const d = normalizeDesign(design);
  const t = pageTheme(d.theme);
  const base = { color: t.text };

  if (d.pageBgImage) {
    return {
      ...base,
      backgroundImage: `url("${d.pageBgImage}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
    };
  }
  if (t.grid && !d.pageBg) {
    // A faint 5mm grid, drawn with gradients so it needs no image and prints cleanly.
    return {
      ...base,
      background: "#ffffff",
      backgroundImage:
        "linear-gradient(#e6eaf2 1px, transparent 1px), linear-gradient(90deg, #e6eaf2 1px, transparent 1px)",
      backgroundSize: "18.9px 18.9px",
    };
  }
  return { ...base, background: d.pageBg || t.bg };
}

/** Inline style for the editable body area (margins + document default type). */
export function bodyStyle(design) {
  const d = normalizeDesign(design);
  return {
    padding: marginOf(d.margin).css,
    fontSize: `${Number(d.bodySize) || DEFAULT_DESIGN.bodySize}px`,
    ...(d.bodyFont ? { fontFamily: `'${d.bodyFont}', sans-serif` } : {}),
  };
}

/**
 * The CSS that has to be generated rather than written by hand, because the on-screen page
 * and `@page` must describe the same sheet. Injected into the editor's <style> block.
 */
export function pageCss(design) {
  const d = normalizeDesign(design);
  const size = pageSize(d.pageSize);
  const mm = marginOf(d.margin).mm;
  const t = pageTheme(d.theme);
  return `
        .notes-page{ width:${size.px}px; min-height:${Math.round(size.px * (size.mm[1] / size.mm[0]))}px; }
        .notes-body .q-head{ color:${t.head}; }
        .notes-body .q-body{ color:${t.text}; }
        @media (max-width:860px){ .notes-page{ width:100%; } }
        @media print { @page{ size:${size.cssSize}; margin:${mm}mm; } }`;
}
