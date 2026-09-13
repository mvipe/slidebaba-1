"use client";

import { useEffect, useRef, useState, useCallback, useMemo, useLayoutEffect } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Layers, Type as TypeIcon, Shapes, ImagePlus, Palette, Wallpaper,
  Eye, Download, Plus, Copy, Trash2, ChevronLeft, ChevronRight, Cloud, CloudOff, X,
  Square, Circle, Minus, Upload, Loader2, FileText, Presentation, ChevronDown, Crown, Check,
  Table as TableIcon,
} from "lucide-react";
import Toolbar from "@/components/editor/Toolbar";
import { renderMixed } from "@/components/Katex";
import { THEMES, DEFAULT_THEME, uid, readHandoff, clearHandoff, newText, newRect, newEllipse, newLine, newImage, newTable } from "@/lib/slideStore";
import { useAuth } from "@/context/AuthContext";
import { saveDownload, listBackgrounds, saveBackground, removeBackground } from "@/lib/docs";
import {
  DESIGN_W, DESIGN_H, fitScale, slideBgStyle, frameStyle, textStyle, shapeInnerStyle, lineBarStyle, imageStyle, isTextElement, tableHTML, tableStyle, tableCellStyle, tableRows, tableColWidths,
} from "@/lib/slideRender";
import { useAutoSave } from "@/lib/useAutoSave";
import { readLocalDraft, clearLocalDraft, localKey } from "@/lib/docStore";
import { listGlobalBackgrounds } from "@/lib/admin";
import { consume, saveBrand, remaining } from "@/lib/plan";
import { downscaleDataUrl, fileToDataUrl, imageSize } from "@/lib/imageCrop";
import { exportSlidesPptx, exportSlidesPdf } from "@/lib/slideExport";
import ThemeToggleButton from "@/components/ThemeToggleButton";

const RAIL = [
  { id: "slides", label: "Slides", icon: Layers },
  { id: "text", label: "Text", icon: TypeIcon },
  { id: "shapes", label: "Shapes", icon: Shapes },
  { id: "table",  label: "Table",  icon: TableIcon },
  { id: "images", label: "Image", icon: ImagePlus },
  { id: "design", label: "Themes", icon: Palette },
  { id: "bg", label: "BG", icon: Wallpaper },
  { id: "brand", label: "Brand", icon: Crown },
];

function blankSlide(theme = DEFAULT_THEME) {
  return { id: uid("slide"), theme, elements: [newText({ content: "Click to edit your title", x: 6, y: 10, w: 88, h: 16, fontSize: 34, fontFamily: "Sora", bold: true })] };
}

function evXY(e) {
  const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
  return { x: t.clientX, y: t.clientY };
}

// Background styling comes from lib/slideRender.js so the editor, the preview modal and
// the exporter can never drift apart.
const slideBg = slideBgStyle;

export default function Editor() {
  const router = useRouter();
  const { user, profile, mergeProfile } = useAuth();
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const moveRef = useRef(null);
  const upRef = useRef(null);
  const fileImgRef = useRef(null);
  const fileBgRef = useRef(null);
  const brandInput = useRef(null);

  const [title, setTitle] = useState("Untitled");
  const [slides, setSlides] = useState([blankSlide()]);
  const [docId, setDocId] = useState(null);
  const hasEditedRef = useRef(false);
  const [current, setCurrent] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [rail, setRail] = useState("slides");
  const [bgScope, setBgScope] = useState("slide"); // "slide" | "all"
  const [styleScope, setStyleScope] = useState("element"); // "element" | "slide" | "all"
  const selApiRef = useRef(null); // set by the text box currently being edited
  const [hasSel, setHasSel] = useState(false); // are words selected inside it?
  const [preview, setPreview] = useState(false);
  const [dlOpen, setDlOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(null); // { done, total }
  const [bgLib, setBgLib] = useState([]);
  const [sharedBg, setSharedBg] = useState([]);
  const [mobileSheet, setMobileSheet] = useState(false);
  const [brandLogo, setBrandLogo] = useState("");
  const [brandName, setBrandName] = useState("");
  const [brandWH, setBrandWH] = useState(null);
  const [masterMode, setMasterMode] = useState(false);
  const [zoom, setZoom] = useState(1); // 1 = fit; user can zoom out/in
  const stageWrapRef = useRef(null);
  const [fit, setFit] = useState(1);    // design-surface -> screen scale

  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);

  useEffect(() => { if (user) listBackgrounds(user.uid).then(setBgLib).catch(() => {}); }, [user]);
  useEffect(() => { listGlobalBackgrounds().then(setSharedBg).catch(() => {}); }, []);

  useEffect(() => {
    if (profile?.brand) { setBrandLogo(profile.brand.logo || ""); setBrandName(profile.brand.name || ""); setBrandWH(profile.brand.wh || null); }
  }, [profile?.brand]);

  /* ---------- autosave (see lib/useAutoSave.js) ----------
     `build` describes what should be persisted. The heavy `slides` array is routed into
     chunked storage by lib/docs.js, so a deck full of images can never blow past the 1 MiB
     Firestore document limit — which is what used to make saves fail silently. */
  const buildSnapshot = useCallback(() => ({
    meta: { name: title, format: "slides", status: "generated" },
    payload: { slides },
  }), [title, slides]);

  const saver = useAutoSave({ user, docId, setDocId, build: buildSnapshot, format: "slides" });
  const { markDirty } = saver;

  // Load the document handed over from Studio / My Documents, and restore anything that was
  // still unsaved on this device the last time the editor was open.
  useEffect(() => {
    const h = readHandoff();

    // Claim the document id ALWAYS, and clear the handoff ALWAYS — even when the handoff
    // carries no slides.
    //
    // This used to happen only inside `if (h?.slides?.length)`. Opening a document that had
    // no slides version therefore left docId === null, so the first keystroke made autosave
    // take its "create" branch and mint a SECOND document, orphaning the original — which is
    // how work appeared to vanish from My Documents. The stale handoff also leaked into the
    // next navigation, so the wrong document could open afterwards.
    const handoffDocId = h?.docId || null;
    if (h) clearHandoff();
    if (handoffDocId) setDocId(handoffDocId);

    let loaded = null;
    if (h?.slides?.length) {
      loaded = { slides: h.slides, title: h.title || "Untitled", docId: handoffDocId };
    } else if (h?.docId) {
      // An empty deck for a real document: keep the title and the id, but do NOT prime the
      // autosave baseline — priming an empty payload would let a stray keystroke overwrite
      // a good saved version with nothing.
      if (h.title) setTitle(h.title);
    }

    const key = localKey(user?.uid, handoffDocId, "slides");
    const draft = readLocalDraft(key);
    const cloudAt = h?.updatedAtMs || 0;
    if (draft?.payload?.slides?.length && draft.at > cloudAt) {
      const when = new Date(draft.at).toLocaleString();
      const useDraft = window.confirm(
        `SlideBaba has unsaved changes on this device from ${when} that never reached the server.\n\n` +
        "OK  —  restore them\nCancel  —  discard them and open the saved version",
      );
      if (useDraft) {
        setSlides(draft.payload.slides);
        setTitle(draft.meta?.name || loaded?.title || "Untitled");
        hasEditedRef.current = true;
        setTimeout(() => markDirty(), 0);
        return;
      }
      clearLocalDraft(key);
    }

    if (loaded) {
      setSlides(loaded.slides);
      setTitle(loaded.title);
      saver.primeFrom({ slides: loaded.slides }, { name: loaded.title, format: "slides", status: "generated" }, h?.chunks ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slide = slides[current];
  const selected = slide?.elements.find((e) => e.id === selectedId) || null;
  const theme = THEMES[slide?.theme] || THEMES[DEFAULT_THEME];

  /* The canvas always LAYS OUT at the fixed 896x504 design size and is only scaled with a
     CSS transform. A transform cannot change where lines break, which is what guarantees
     the editor, the preview and the exported PDF are identical. Previously the canvas was a
     fluid `min(100%, 56rem)` box while font sizes stayed absolute, so text wrapped in a
     different place on every screen width — and different again in the PDF. */
  useLayoutEffect(() => {
    const box = stageWrapRef.current;
    if (!box) return undefined;
    const measure = () => {
      const cs = window.getComputedStyle(box);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const w = Math.max(1, box.clientWidth - padX);
      const h = Math.max(1, box.clientHeight - padY);
      setFit(Math.max(0.05, Math.min(1, fitScale(w, h))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    window.addEventListener("orientationchange", measure);
    return () => { ro.disconnect(); window.removeEventListener("orientationchange", measure); };
  }, []);

  const stageScale = fit * zoom;

  const commit = useCallback((updater) => {
    hasEditedRef.current = true;
    setPast((p) => [...p.slice(-49), slides]);
    setFuture([]);
    setSlides((s) => updater(s));
    markDirty();
  }, [slides, markDirty]);

  // Undo/redo change the document too, so they must mark it dirty — previously they didn't,
  // and an undone edit could be the last thing you did before closing the tab.
  const undo = () => { if (!past.length) return; const prev = past[past.length - 1]; setPast((p) => p.slice(0, -1)); setFuture((f) => [slides, ...f]); setSlides(prev); hasEditedRef.current = true; markDirty(); };
  const redo = () => { if (!future.length) return; const next = future[0]; setFuture((f) => f.slice(1)); setPast((p) => [...p, slides]); setSlides(next); hasEditedRef.current = true; markDirty(); };

  // element ops
  const mapCurrent = (fn) => commit((s) => s.map((sl, i) => (i === current ? fn(sl) : sl)));
  const patchMasterByMid = (mid, patch) => commit((s) => s.map((sl) => ({ ...sl, elements: sl.elements.map((e) => (e.mid === mid ? { ...e, ...patch } : e)) })));
  // Style/content edits never propagate by position. Brand/master-tagged elements (images) stay
  // in sync by their shared id; everything else edits only the current box.
  const patchEl = (id, patch) => {
    const el = slide?.elements.find((e) => e.id === id);
    if (!el) return;
    // Shared master elements sync across all slides; normal per-slide boxes only change here.
    if (el.master && el.mid) patchMasterByMid(el.mid, patch);
    else mapCurrent((sl) => ({ ...sl, elements: sl.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  };
  const updateSelected = (patch) => selected && patchEl(selected.id, patch);
  // Style scope: apply font/colour/etc. to just this element, every text box on this slide, or all slides.
  const isTextEl = (e) => e.type === "text" || !e.type;
  const applyStyle = (patch) => {
    if (!selected) return;
    // If words are selected inside the box being edited, style just those words.
    if (editingId === selected.id && selApiRef.current?.applyToSelection?.(patch)) return;
    if (styleScope === "element" || !isTextEl(selected)) { patchEl(selected.id, patch); return; }
    if (styleScope === "slide") {
      mapCurrent((sl) => ({ ...sl, elements: sl.elements.map((e) => (isTextEl(e) ? { ...e, ...patch } : e)) }));
    } else {
      commit((arr) => arr.map((sl) => ({ ...sl, elements: sl.elements.map((e) => (isTextEl(e) ? { ...e, ...patch } : e)) })));
    }
  };
  const deleteSelected = () => {
    if (!selected) return;
    if (selected.master && selected.mid) commit((s) => s.map((sl) => ({ ...sl, elements: sl.elements.filter((e) => e.mid !== selected.mid) })));
    else mapCurrent((sl) => ({ ...sl, elements: sl.elements.filter((e) => e.id !== selected.id) }));
    setSelectedId(null);
  };

  /* ---------------- table operations ---------------- */
  // Every one of these goes through patchEl, so undo/redo, autosave and master-element
  // syncing all keep working with no special cases.

  const setCell = (el, r, c, value) => {
    const rows = tableRows(el).map((row) => [...row]);
    if (!rows[r]) return;
    const next = String(value ?? "").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (rows[r][c] === next) return;
    rows[r][c] = next;
    patchEl(el.id, { rows });
  };

  const tableOp = (op) => {
    const el = selected;
    if (!el || el.type !== "table") return;
    const rows = tableRows(el).map((row) => [...row]);
    const widths = tableColWidths(el);
    const cols = rows[0].length;

    if (op === "addRow") rows.push(Array(cols).fill(""));
    if (op === "delRow" && rows.length > 1) rows.pop();
    if (op === "addCol") {
      rows.forEach((row) => row.push(""));
      patchEl(el.id, { rows, colW: Array(cols + 1).fill(100 / (cols + 1)) });
      return;
    }
    if (op === "delCol" && cols > 1) {
      rows.forEach((row) => row.pop());
      patchEl(el.id, { rows, colW: Array(cols - 1).fill(100 / (cols - 1)) });
      return;
    }
    void widths;
    patchEl(el.id, { rows });
  };

  const addTable = () => {
    addEl(newTable());
    setRail("slides");
    setMobileSheet(false);
  };

  const addEl = (el) => {
    if (masterMode) {
      // Master ON + newly added element = place it on every slide (shared master element).
      const mid = uid("m"); const baseId = uid("el");
      commit((s) => s.map((sl, i) => ({ ...sl, elements: [...sl.elements, { ...el, master: true, mid, id: i === current ? baseId : uid("el") }] })));
      setSelectedId(baseId);
    } else {
      mapCurrent((sl) => ({ ...sl, elements: [...sl.elements, el] }));
      setSelectedId(el.id);
    }
    setRail("slides"); setMobileSheet(false);
  };
  const addText = () => addEl(newText({ content: "New text — supports $x^2$ math" }));
  const addShape = (kind) => addEl(kind === "rect" ? newRect() : kind === "ellipse" ? newEllipse() : newLine());

  const onUploadImages = async (files) => {
    const list = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    let off = 0;
    for (const file of list) {
      try {
        const data = await downscaleDataUrl(await fileToDataUrl(file), 1400, 0.85);
        // size the box to the image's aspect ratio so resizing scales (never crops)
        let w = 50, h = 38;
        try {
          const { width, height } = await imageSize(data);
          if (width && height) h = Math.max(8, Math.min(82, w * (16 / 9) * (height / width)));
        } catch {}
        addEl(newImage(data, { x: Math.min(60, 18 + off), y: Math.min(55, 14 + off), w, h }));
        off += 5; // stagger multiple images so they don't stack exactly
      } catch {}
    }
  };

  // z-order
  const arrange = (action) => {
    if (!selected) return;
    mapCurrent((sl) => {
      const arr = [...sl.elements];
      const i = arr.findIndex((e) => e.id === selected.id);
      if (i < 0) return sl;
      const [it] = arr.splice(i, 1);
      if (action === "front") arr.push(it);
      else if (action === "back") arr.unshift(it);
      else if (action === "forward") arr.splice(Math.min(arr.length, i + 1), 0, it);
      else arr.splice(Math.max(0, i - 1), 0, it);
      return { ...sl, elements: arr };
    });
  };

  // position align within slide
  const alignEl = (dir) => {
    if (!selected) return;
    const w = selected.w, h = selected.h;
    const patch = {};
    if (dir === "left") patch.x = 2;
    else if (dir === "right") patch.x = 98 - w;
    else if (dir === "centerH") patch.x = (100 - w) / 2;
    else if (dir === "top") patch.y = 2;
    else if (dir === "bottom") patch.y = 98 - h;
    else if (dir === "middle") patch.y = (100 - h) / 2;
    patchEl(selected.id, patch);
  };

  // background / theme
  const applyScope = (patch) => {
    if (bgScope === "all" || masterMode) commit((s) => s.map((sl) => ({ ...sl, ...patch })));
    else mapCurrent((sl) => ({ ...sl, ...patch }));
  };
  const pickTheme = (themeId) => applyScope({ theme: themeId, bgColor: "", bgImage: "" });
  const pickBgColor = (color) => applyScope({ bgColor: color, bgImage: "" });
  const pickBgImage = async (file) => {
    if (!file) return;
    const data = await downscaleDataUrl(await fileToDataUrl(file), 1600, 0.82);
    applyScope({ bgImage: data });
    if (user) { const ref = await saveBackground(user.uid, data); if (ref?.id) setBgLib((b) => [{ id: ref.id, url: data }, ...b]); }
  };
  const deleteBg = async (id) => { if (user) await removeBackground(user.uid, id); setBgLib((b) => b.filter((x) => x.id !== id)); };

  // ---- custom branding (logo + coaching name on every slide) ----
  const onBrandLogo = async (file) => {
    if (!file) return;
    const data = await downscaleDataUrl(await fileToDataUrl(file), 400, 0.85);
    let wh = null;
    try { const { width, height } = await imageSize(data); if (width && height) wh = height / width; } catch {}
    setBrandLogo(data); setBrandWH(wh);
  };
  const saveBrandNow = async () => {
    const brand = { logo: brandLogo || "", name: brandName || "", wh: brandWH || 0 };
    mergeProfile({ brand });
    if (user) await saveBrand(user.uid, brand);
  };
  const applyBranding = () => {
    if (!brandLogo && !brandName) return;
    const w = 12;
    const h = brandWH ? Math.max(5, Math.min(20, w * brandWH * (16 / 9))) : 10;
    const midLogo = uid("m"), midName = uid("m");
    commit((s) => s.map((sl) => {
      const els = sl.elements.filter((e) => !e.brand);
      const add = [];
      if (brandLogo) add.push({ ...newImage(brandLogo, { x: 3, y: 100 - h - 3, w, h }), brand: true, master: true, mid: midLogo });
      if (brandName) add.push({ ...newText({ content: brandName, x: brandLogo ? 4 + w : 3, y: 92, w: 50, h: 7, fontSize: 16, bold: true, color: "#6d3aed" }), brand: true, master: true, mid: midName });
      return { ...sl, elements: [...els, ...add] };
    }));
    setRail("slides"); setMobileSheet(false);
  };
  const removeBranding = () => commit((s) => s.map((sl) => ({ ...sl, elements: sl.elements.filter((e) => !e.brand) })));
  const clearBg = () => applyScope({ bgColor: "", bgImage: "" });

  // slides
  const addSlide = () => { const sl = blankSlide(slide?.theme || DEFAULT_THEME); commit((s) => [...s.slice(0, current + 1), sl, ...s.slice(current + 1)]); setCurrent(current + 1); setSelectedId(null); };
  const duplicateSlide = () => { const copy = { ...slide, id: uid("slide"), elements: slide.elements.map((e) => ({ ...e, id: uid("el") })) }; commit((s) => [...s.slice(0, current + 1), copy, ...s.slice(current + 1)]); setCurrent(current + 1); };
  const deleteSlide = () => { if (slides.length === 1) return; commit((s) => s.filter((_, i) => i !== current)); setCurrent((c) => Math.max(0, c - 1)); setSelectedId(null); };

  // drag
  const onElMouseDown = (e, el) => {
    if (editingId === el.id) return;
    e.stopPropagation();
    setSelectedId(el.id);
    const p0 = evXY(e);
    const rect = canvasRef.current.getBoundingClientRect();
    const isImg = el.type === "image";
    dragRef.current = { id: el.id, idx: slide.elements.findIndex((x) => x.id === el.id), useIndex: masterMode && !el.mid && !isImg, mid: el.mid || null, startX: p0.x, startY: p0.y, ox: el.x, oy: el.y, rectW: rect.width, rectH: rect.height, curIndex: current };
    moveRef.current = (ev) => {
      const d = dragRef.current; if (!d) return;
      if (ev.cancelable) ev.preventDefault();
      const p = evXY(ev);
      const nx = Math.min(98, Math.max(0, d.ox + ((p.x - d.startX) / d.rectW) * 100));
      const ny = Math.min(98, Math.max(0, d.oy + ((p.y - d.startY) / d.rectH) * 100));
      setSlides((s) => s.map((sl, i) => {
        if (d.useIndex) return { ...sl, elements: sl.elements.map((it, k) => (k === d.idx ? { ...it, x: nx, y: ny } : it)) };
        if (d.mid) return { ...sl, elements: sl.elements.map((it) => (it.mid === d.mid ? { ...it, x: nx, y: ny } : it)) };
        return i === d.curIndex ? { ...sl, elements: sl.elements.map((it) => (it.id === d.id ? { ...it, x: nx, y: ny } : it)) } : sl;
      }));
    };
    upRef.current = endGesture;
    window.addEventListener("mousemove", moveRef.current);
    window.addEventListener("mouseup", upRef.current);
    window.addEventListener("touchmove", moveRef.current, { passive: false });
    window.addEventListener("touchend", upRef.current);
  };

  // resize
  const onResizeStart = (e, corner, el) => {
    e.stopPropagation();
    setSelectedId(el.id);
    const p0 = evXY(e);
    const rect = canvasRef.current.getBoundingClientRect();
    const isImg = el.type === "image";
    dragRef.current = { id: el.id, idx: slide.elements.findIndex((x) => x.id === el.id), useIndex: masterMode && !el.mid && !isImg, mid: el.mid || null, corner, startX: p0.x, startY: p0.y, ox: el.x, oy: el.y, ow: el.w, oh: el.h, ofs: el.fontSize || 20, isText: el.type === "text" || !el.type, diag: corner.length === 2, rectW: rect.width, rectH: rect.height, curIndex: current };
    moveRef.current = (ev) => {
      const d = dragRef.current; if (!d) return;
      if (ev.cancelable) ev.preventDefault();
      const p = evXY(ev);
      const dx = ((p.x - d.startX) / d.rectW) * 100;
      const dy = ((p.y - d.startY) / d.rectH) * 100;
      let x = d.ox, y = d.oy, w = d.ow, h = d.oh;
      if (d.corner.includes("e")) w = d.ow + dx;
      if (d.corner.includes("s")) h = d.oh + dy;
      if (d.corner.includes("w")) { x = d.ox + dx; w = d.ow - dx; }
      if (d.corner.includes("n")) { y = d.oy + dy; h = d.oh - dy; }
      w = Math.max(3, w); h = Math.max(2, h);
      x = Math.max(0, Math.min(x, 99)); y = Math.max(0, Math.min(y, 99));
      const patch = { x, y, w, h };
      if (d.isText && d.diag && d.ow > 0) {
        const scale = Math.max(0.2, Math.min(8, w / d.ow));
        patch.fontSize = Math.max(8, Math.min(240, Math.round(d.ofs * scale)));
      }
      setSlides((s) => s.map((sl, i) => {
        if (d.useIndex) return { ...sl, elements: sl.elements.map((it, k) => (k === d.idx ? { ...it, ...patch } : it)) };
        if (d.mid) return { ...sl, elements: sl.elements.map((it) => (it.mid === d.mid ? { ...it, ...patch } : it)) };
        return i === d.curIndex ? { ...sl, elements: sl.elements.map((it) => (it.id === d.id ? { ...it, ...patch } : it)) } : sl;
      }));
    };
    upRef.current = endGesture;
    window.addEventListener("mousemove", moveRef.current);
    window.addEventListener("mouseup", upRef.current);
    window.addEventListener("touchmove", moveRef.current, { passive: false });
    window.addEventListener("touchend", upRef.current);
  };

  const endGesture = () => {
    dragRef.current = null;
    window.removeEventListener("mousemove", moveRef.current);
    window.removeEventListener("mouseup", upRef.current);
    window.removeEventListener("touchmove", moveRef.current);
    window.removeEventListener("touchend", upRef.current);
    hasEditedRef.current = true;
    markDirty();
  };

  /* ---------- export ----------
     The old version awaited consume() — a Firestore write — BEFORE exporting, and returned
     without a word if it didn't succeed. Once the oversized autosave writes had clogged the
     Firestore queue that call never resolved, so pressing Download simply did nothing. It
     also burned a credit even when the export then failed.

     Now: the allowance is checked locally (no network), the file is produced first, and the
     usage record is written afterwards in the background. Nothing about the download can
     hang on the network any more, and every failure is reported. */
  const downloadAs = async (kind) => {
    setDlOpen(false);
    if (exporting) return;
    if (!slides.length) { alert("There's nothing to export yet."); return; }

    if (user && profile) {
      const left = remaining(profile).docsLeft;
      if (left <= 0) {
        alert("You've used all your document credits for this cycle. Upgrade your plan for more.");
        router.push("/dashboard/subscription");
        return;
      }
    }

    // Get the work safely stored before a long export, but never block the export on it.
    if (user && saver.isDirty()) saver.saveNow().catch(() => {});

    setExporting(true);
    setExportProgress({ done: 0, total: slides.length });
    const name = title || "slidebaba";
    const onProgress = (done, total) => setExportProgress({ done, total });

    try {
      if (kind === "pdf") await exportSlidesPdf(slides, THEMES, DEFAULT_THEME, name, onProgress);
      else await exportSlidesPptx(slides, THEMES, DEFAULT_THEME, name, onProgress);

      // Bookkeeping happens after the file exists, and can never break the download.
      if (user) {
        consume(user.uid, profile, "doc").then((cr) => { if (cr?.ok) mergeProfile(cr.patch); }).catch(() => {});
        saveDownload(user.uid, {
          name: `${name}.${kind === "pdf" ? "pdf" : "pptx"}`,
          format: kind === "pdf" ? "pdf" : "pptx",
          slidesCount: slides.length,
        }).catch(() => {});
      }
    } catch (e) {
      console.error("[SlideBaba] export failed:", e);
      alert(
        "Sorry, the export failed: " + (e?.message || e) +
        "\n\nYour slides are safe. Try again, or export fewer slides at a time if this is a very large deck.",
      );
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  return (
    <div className="app-shell flex h-screen [height:100dvh] flex-col bg-ink-950">
      <header className="flex min-h-[3.5rem] flex-wrap items-center justify-between gap-y-2 border-b border-white/10 bg-ink-900/80 px-2 py-2 sm:h-14 sm:flex-nowrap sm:py-0 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <button onClick={() => router.push("/dashboard/studio")} className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-slate-300 hover:bg-ink-700 hover:text-white"><ArrowLeft className="h-4 w-4" /></button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="SlideBaba" className="hidden h-8 w-8 rounded-md sm:block" />
          <div className="min-w-0 flex-1">
            <input value={title} onChange={(e) => { setTitle(e.target.value); hasEditedRef.current = true; markDirty(); }} className="w-full min-w-0 bg-transparent font-display text-sm font-bold text-white outline-none" />
            <p className="text-[11px] text-slate-500">{slides.length} slides</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SaveBadge status={saver.status} error={saver.error} onRetry={() => saver.saveNow()} />
          <ThemeToggleButton />
          <button onClick={() => setMasterMode((v) => !v)} title="Master slide: elements you add or move here appear on every slide" className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition ${masterMode ? "bg-brand-gradient text-white shadow-soft" : "btn-ghost"}`}><Crown className="h-4 w-4" /> Master{masterMode ? " · On" : ""}</button>
          <button onClick={() => setPreview(true)} className="btn-ghost hidden px-3 py-2 text-sm sm:inline-flex"><Eye className="h-4 w-4" /> Preview</button>

          {/* Download dropdown: PDF + PPTX */}
          <div className="relative">
            <button onClick={() => setDlOpen((v) => !v)} disabled={exporting} className="btn-primary px-3 py-2 text-sm disabled:opacity-60">
              {exporting ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> {exportProgress ? `Exporting ${exportProgress.done}/${exportProgress.total}` : "Exporting…"}</>
              ) : (
                <><Download className="h-4 w-4" /> Download <ChevronDown className="h-3.5 w-3.5 opacity-80" /></>
              )}
            </button>
            {dlOpen && !exporting && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setDlOpen(false)} />
                <div className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-xl border border-white/10 bg-ink-850 p-1.5 shadow-glow">
                  <button onClick={() => downloadAs("pptx")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-white hover:bg-ink-700">
                    <Presentation className="h-4 w-4 text-flame-400" /> <span><b className="font-semibold">PowerPoint</b><br /><span className="text-[11px] text-slate-500">.pptx — editable slides</span></span>
                  </button>
                  <button onClick={() => downloadAs("pdf")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-white hover:bg-ink-700">
                    <FileText className="h-4 w-4 text-accent-400" /> <span><b className="font-semibold">PDF</b><br /><span className="text-[11px] text-slate-500">.pdf — one slide per page</span></span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      {masterMode && (
        <div className="flex items-center justify-center gap-2 border-b border-brand-500/30 bg-brand-500/10 px-3 py-1.5 text-center text-xs font-semibold text-brand-200">
          <Crown className="h-3.5 w-3.5" /> Master slide is on — anything you add now appears on every slide. Editing an existing box only changes this slide.
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* rail */}
        <div className="hidden w-16 flex-col items-center gap-1 border-r border-white/10 bg-ink-900 py-3 md:flex">
          {RAIL.map((r) => (
            <button key={r.id} onClick={() => setRail(r.id)} className={`flex w-14 flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-semibold transition ${rail === r.id ? "bg-brand-500/15 text-brand-300" : "text-slate-500 hover:text-white"}`}>
              <r.icon className="h-5 w-5" />
              {r.label}
            </button>
          ))}
        </div>

        {/* panel: left column on desktop, bottom sheet on mobile */}
        {mobileSheet && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMobileSheet(false)} />}
        <div className={`${mobileSheet ? "translate-y-0" : "translate-y-full"} fixed inset-x-0 bottom-0 z-40 max-h-[62vh] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-ink-900 p-3 pb-6 shadow-glow transition-transform duration-200 md:static md:z-auto md:max-h-none md:w-60 md:shrink-0 md:translate-y-0 md:rounded-none md:border-r md:border-t-0 md:bg-ink-900/60 md:pb-3 md:shadow-none md:transition-none`}>
          <button onClick={() => setMobileSheet(false)} className="mx-auto mb-3 block h-1.5 w-12 rounded-full bg-white/20 md:hidden" aria-label="Close panel" />
          {rail === "slides" && <SlidesPanel slides={slides} current={current} theme={theme} onSelect={(i) => { setCurrent(i); setSelectedId(null); }} onAdd={addSlide} onDup={duplicateSlide} onDelete={deleteSlide} />}
          {rail === "text" && (
            <div className="space-y-2">
              <p className="px-1 text-xs font-bold uppercase tracking-widest text-slate-500">Text</p>
              <button onClick={addText} className="btn-ghost w-full justify-start"><Plus className="h-4 w-4" /> Add text box</button>
              <p className="px-1 pt-2 text-xs text-slate-500">Wrap math in $…$, e.g. <code className="text-brand-300">{"$\\frac{a}{b}$"}</code></p>
            </div>
          )}
          {rail === "table" && (
            <div className="space-y-2">
              <p className="px-1 text-xs font-bold uppercase tracking-widest text-slate-500">Table</p>
              <button onClick={addTable} className="btn-ghost w-full justify-start"><Plus className="h-4 w-4" /> Insert table</button>
              <p className="px-1 pt-2 text-xs text-slate-500">Double-click a table to edit its cells. Rows and columns are in the toolbar when a table is selected.</p>
            </div>
          )}
          {rail === "shapes" && (
            <div className="space-y-2">
              <p className="px-1 text-xs font-bold uppercase tracking-widest text-slate-500">Shapes</p>
              <button onClick={() => addShape("rect")} className="btn-ghost w-full justify-start"><Square className="h-4 w-4" /> Rectangle</button>
              <button onClick={() => addShape("ellipse")} className="btn-ghost w-full justify-start"><Circle className="h-4 w-4" /> Ellipse</button>
              <button onClick={() => addShape("line")} className="btn-ghost w-full justify-start"><Minus className="h-4 w-4" /> Line</button>
            </div>
          )}
          {rail === "images" && (
            <div className="space-y-2">
              <p className="px-1 text-xs font-bold uppercase tracking-widest text-slate-500">Image</p>
              <input ref={fileImgRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { onUploadImages(e.target.files); e.target.value = ""; }} />
              <button onClick={() => fileImgRef.current?.click()} className="btn-ghost w-full justify-start"><Upload className="h-4 w-4" /> Upload image(s)</button>
              <p className="px-1 pt-1 text-xs text-slate-500">PNG / JPG. Drag a corner to resize — it scales, never crops.</p>
            </div>
          )}
          {rail === "design" && (
            <div className="space-y-3">
              <ScopeToggle scope={bgScope} setScope={setBgScope} />
              <p className="px-1 text-xs font-bold uppercase tracking-widest text-slate-500">Themes</p>
              {Object.values(THEMES).map((t) => (
                <button key={t.id} onClick={() => pickTheme(t.id)} className={`flex w-full items-center gap-3 rounded-xl p-2.5 ring-1 transition ${slide?.theme === t.id && !slide?.bgColor && !slide?.bgImage ? "ring-2 ring-brand-400" : "ring-white/10 hover:ring-brand-400/50"}`}>
                  <span className="h-9 w-12 rounded-md ring-1 ring-white/10" style={{ background: t.bg }}><span className="block h-1.5 w-6 translate-x-1.5 translate-y-2 rounded" style={{ background: t.accent }} /></span>
                  <span className="text-sm font-semibold text-white">{t.label}</span>
                </button>
              ))}
            </div>
          )}
          {rail === "bg" && (
            <div className="space-y-3">
              <ScopeToggle scope={bgScope} setScope={setBgScope} />
              <p className="px-1 text-xs font-bold uppercase tracking-widest text-slate-500">Background</p>
              <label className="flex cursor-pointer items-center justify-between rounded-xl bg-ink-800 px-3 py-2.5 ring-1 ring-inset ring-white/10">
                <span className="text-sm text-white">Solid color</span>
                <input type="color" value={slide?.bgColor || theme.bg} onChange={(e) => pickBgColor(e.target.value)} className="h-7 w-10 cursor-pointer rounded bg-transparent" />
              </label>
              <input ref={fileBgRef} type="file" accept="image/*" className="hidden" onChange={(e) => pickBgImage(e.target.files?.[0])} />
              <button onClick={() => fileBgRef.current?.click()} className="btn-ghost w-full justify-start"><Upload className="h-4 w-4" /> Upload background image</button>
              {bgLib.length > 0 && (
                <>
                  <p className="px-1 pt-1 text-xs font-bold uppercase tracking-widest text-slate-500">My backgrounds</p>
                  <div className="grid grid-cols-3 gap-2">
                    {bgLib.map((b) => (
                      <div key={b.id} className="group relative">
                        <button onClick={() => applyScope({ bgImage: b.url })} className="block aspect-video w-full overflow-hidden rounded-lg ring-1 ring-white/10 hover:ring-brand-400">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={b.url} alt="" className="h-full w-full object-cover" />
                        </button>
                        <button onClick={() => deleteBg(b.id)} className="absolute right-1 top-1 hidden h-5 w-5 place-items-center rounded bg-black/60 text-white group-hover:grid" aria-label="Delete background"><Trash2 className="h-3 w-3" /></button>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {sharedBg.length > 0 && (
                <>
                  <p className="px-1 pt-1 text-xs font-bold uppercase tracking-widest text-slate-500">Shared backgrounds</p>
                  <div className="grid grid-cols-3 gap-2">
                    {sharedBg.map((b) => (
                      <button key={b.id} onClick={() => applyScope({ bgImage: b.url })} className="block aspect-video w-full overflow-hidden rounded-lg ring-1 ring-white/10 hover:ring-brand-400">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={b.url} alt="" className="h-full w-full object-cover" />
                      </button>
                    ))}
                  </div>
                </>
              )}
              <button onClick={clearBg} className="btn-ghost w-full justify-start text-slate-400"><X className="h-4 w-4" /> Clear custom background</button>
            </div>
          )}
          {rail === "brand" && (
            <div className="space-y-3">
              <p className="px-1 text-xs font-bold uppercase tracking-widest text-slate-500">Custom Branding</p>
              <p className="px-1 text-xs text-slate-500">Place your logo & coaching name on every slide. Saved to your account for all projects.</p>
              <div className="grid h-24 place-items-center rounded-xl bg-ink-800 ring-1 ring-inset ring-white/10">
                {brandLogo ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={brandLogo} alt="logo" className="max-h-20 max-w-[80%] object-contain" />
                ) : <span className="text-xs text-slate-500">No logo yet</span>}
              </div>
              <input ref={brandInput} type="file" accept="image/*" className="hidden" onChange={(e) => onBrandLogo(e.target.files?.[0])} />
              <button onClick={() => brandInput.current?.click()} className="btn-ghost w-full justify-start"><Upload className="h-4 w-4" /> Upload logo</button>
              <input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="Coaching / brand name" className="w-full rounded-xl bg-ink-800 px-3 py-2.5 text-sm text-white outline-none ring-1 ring-inset ring-white/10 placeholder:text-slate-500" />
              <button onClick={saveBrandNow} className="btn-ghost w-full justify-start"><Check className="h-4 w-4 text-emerald-400" /> Save brand</button>
              <button onClick={applyBranding} className="btn-primary w-full"><Crown className="h-4 w-4" /> Add to all slides</button>
              <button onClick={removeBranding} className="btn-ghost w-full justify-start text-slate-400"><X className="h-4 w-4" /> Remove from slides</button>
            </div>
          )}
        </div>

        {/* canvas */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {selected?.master && (
            <div className="flex items-center gap-1.5 border-b border-brand-500/20 bg-brand-500/10 px-3 py-1 text-[11px] font-semibold text-brand-200"><Crown className="h-3 w-3" /> This element is on every slide — your changes apply everywhere.</div>
          )}
          <Toolbar el={selected} onChange={applyStyle} onDelete={deleteSelected} onUndo={undo} onRedo={redo} canUndo={past.length > 0} canRedo={future.length > 0} onArrange={arrange} onAlign={alignEl} scope={styleScope} setScope={setStyleScope} selActive={hasSel && editingId === selectedId} />
                onTableOp={tableOp}
          <div ref={stageWrapRef} className="flex flex-1 overflow-auto bg-dots p-4 sm:p-8" onMouseDown={() => setSelectedId(null)}>
            {/* Outer box reserves the on-screen footprint; the inner surface is always
                exactly DESIGN_W x DESIGN_H and is scaled, never resized. */}
            <div className="m-auto shrink-0" style={{ width: DESIGN_W * stageScale, height: DESIGN_H * stageScale }}>
              <div
                ref={canvasRef}
                className="relative select-none overflow-hidden shadow-glow ring-1 ring-white/10"
                style={{
                  width: DESIGN_W, height: DESIGN_H,
                  transform: `scale(${stageScale})`, transformOrigin: "top left",
                  ...slideBg(slide, theme), color: theme.text,
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {slide?.elements.map((el) => (
                  <ElementView key={el.id} el={el} theme={theme} selected={el.id === selectedId} editing={el.id === editingId} scale={stageScale}
                    onMouseDown={(e) => onElMouseDown(e, el)}
                    onResizeStart={onResizeStart}
                    onDoubleClick={() => { if (isTextElement(el) || el.type === "table") { setSelectedId(el.id); setEditingId(el.id); } }}
                    onBlur={(val) => { setEditingId(null); setHasSel(false); if (val !== el.content) patchEl(el.id, { content: val }); }}
                    onRegisterSel={(api) => { selApiRef.current = api; }}
                    onSelState={setHasSel}
                    onContent={(val) => { if (val !== el.content) patchEl(el.id, { content: val }); }}
                    onCell={(r, c, val) => setCell(el, r, c, val)}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="flex h-12 shrink-0 items-center justify-between border-t border-white/10 bg-ink-900/80 px-5 text-sm">
            <div className="flex items-center gap-1">
              <button onClick={() => setZoom((z) => Math.max(0.25, Math.round((z - 0.1) * 100) / 100))} title="Zoom out" className="grid h-7 w-7 place-items-center rounded-lg text-slate-300 hover:bg-ink-700"><Minus className="h-4 w-4" /></button>
              <button onClick={() => setZoom(1)} title="Reset to fit" className="min-w-[3.25rem] rounded-lg px-2 py-1 text-center text-xs font-bold text-slate-200 hover:bg-ink-700">{Math.round(zoom * 100)}%</button>
              <button onClick={() => setZoom((z) => Math.min(2, Math.round((z + 0.1) * 100) / 100))} title="Zoom in" className="grid h-7 w-7 place-items-center rounded-lg text-slate-300 hover:bg-ink-700"><Plus className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setCurrent((c) => Math.max(0, c - 1))} className="grid h-7 w-7 place-items-center rounded-lg text-slate-300 hover:bg-ink-700"><ChevronLeft className="h-4 w-4" /></button>
              <span className="text-slate-300">Slide <b className="text-white">{current + 1}</b> of {slides.length}</span>
              <button onClick={() => setCurrent((c) => Math.min(slides.length - 1, c + 1))} className="grid h-7 w-7 place-items-center rounded-lg text-slate-300 hover:bg-ink-700"><ChevronRight className="h-4 w-4" /></button>
            </div>
            <span className="hidden items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400 sm:flex"><span className="h-2.5 w-2.5 rounded-full" style={{ background: theme.dot }} /> {theme.label}</span>
          </div>

          {/* mobile tools rail */}
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-white/10 bg-ink-900 px-2 py-2 md:hidden">
            {RAIL.map((r) => (
              <button key={r.id} onClick={() => { setRail(r.id); setMobileSheet(true); }} className={`flex min-w-[68px] shrink-0 flex-col items-center gap-1 rounded-xl px-2 py-2 text-[11px] font-bold transition ${rail === r.id && mobileSheet ? "bg-brand-500/20 text-brand-200" : "text-slate-400 hover:text-white"}`}>
                <r.icon className="h-7 w-7" /> {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {preview && <PreviewModal slides={slides} onClose={() => setPreview(false)} />}
    </div>
  );
}

function ScopeToggle({ scope, setScope }) {
  return (
    <div className="flex items-center gap-1 rounded-xl bg-ink-800 p-1 ring-1 ring-inset ring-white/10">
      <button onClick={() => setScope("slide")} className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition ${scope === "slide" ? "bg-brand-gradient text-white" : "text-slate-400 hover:text-white"}`}>This slide</button>
      <button onClick={() => setScope("all")} className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition ${scope === "all" ? "bg-brand-gradient text-white" : "text-slate-400 hover:text-white"}`}>All slides</button>
    </div>
  );
}

function handlePos(c) {
  const o = -7;
  const mid = "calc(50% - 7px)";
  if (c === "nw") return { left: o, top: o, cursor: "nwse-resize" };
  if (c === "ne") return { right: o, top: o, cursor: "nesw-resize" };
  if (c === "sw") return { left: o, bottom: o, cursor: "nesw-resize" };
  if (c === "se") return { right: o, bottom: o, cursor: "nwse-resize" };
  if (c === "w") return { left: o, top: mid, cursor: "ew-resize" };
  return { right: o, top: mid, cursor: "ew-resize" }; // e
}

// ---- word-level styling helpers (rich text inside a box) ----
const WORD_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#111827"];
const WORD_HL = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#fed7aa", "#e9d5ff"];

function escKeepSpans(s) {
  let out = ""; let i = 0;
  const str = String(s || "");
  while (i < str.length) {
    if (str.startsWith("</span>", i)) { out += "</span>"; i += 7; continue; }
    const m = /^<span\s+style="[^"<>]*">/.exec(str.slice(i, i + 240));
    if (m) { out += m[0]; i += m[0].length; continue; }
    const c = str[i];
    out += c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c;
    i += 1;
  }
  return out;
}
// Stored content (raw text + $math$ + <span> color tags) -> HTML for the editable surface.
function contentToEditHtml(content) { return escKeepSpans(content).replace(/\n/g, "<br>"); }
// Read the editable surface DOM back into stored content, keeping color spans + newlines.
// Read the inline styles we support off a styled node in the editable surface.
function spanCssOf(nd) {
  const st = nd.style; if (!st) return "";
  const parts = [];
  if (st.color) parts.push(`color:${st.color}`);
  const bg = st.backgroundColor || st.background;
  if (bg && bg !== "transparent" && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bg)) parts.push(`background:${bg}`);
  if (st.fontFamily) parts.push(`font-family:${String(st.fontFamily).replace(/"/g, "'")}`);
  if (st.fontSize) parts.push(`font-size:${st.fontSize}`);
  if (st.fontWeight) parts.push(`font-weight:${st.fontWeight}`);
  if (st.fontStyle && st.fontStyle !== "normal") parts.push(`font-style:${st.fontStyle}`);
  const td = st.textDecorationLine || st.textDecoration;
  if (td) {
    const keep = String(td).split(/\s+/).filter((x) => ["underline", "line-through", "overline", "none"].includes(x)).join(" ");
    if (keep) parts.push(`text-decoration:${keep}`);
  }
  return parts.join(";");
}

function editHtmlToContent(root) {
  let out = "";
  const wrapTag = (css, node) => { out += `<span style="${css}">`; walk(node); out += "</span>"; };
  const walk = (node) => {
    node.childNodes.forEach((nd) => {
      if (nd.nodeType === 3) { out += nd.nodeValue; return; }
      const name = nd.nodeName;
      if (name === "BR") { out += "\n"; return; }
      if (name === "SPAN" || name === "FONT") {
        const css = spanCssOf(nd);
        if (css) { wrapTag(css, nd); return; }
        walk(nd); return;
      }
      if (name === "B" || name === "STRONG") { wrapTag("font-weight:700", nd); return; }
      if (name === "I" || name === "EM") { wrapTag("font-style:italic", nd); return; }
      if (name === "U") { wrapTag("text-decoration:underline", nd); return; }
      if (name === "DIV" || name === "P") { if (out && !out.endsWith("\n")) out += "\n"; walk(nd); return; }
      walk(nd);
    });
  };
  walk(root);
  return out.replace(/\n+$/, "");
}

// Map a toolbar patch onto per-word span CSS. Returns null for things that can't apply
// to a selection (e.g. paragraph alignment) so the caller falls back to the scope rules.
function patchToSpanCss(patch) {
  const css = {}; let any = false;
  if (patch.fontFamily) { css.fontFamily = patch.fontFamily; any = true; }
  if (patch.fontSize) { css.fontSize = `${patch.fontSize}px`; any = true; }
  if ("bold" in patch) { css.fontWeight = patch.bold ? "700" : "400"; any = true; }
  if ("italic" in patch) { css.fontStyle = patch.italic ? "italic" : "normal"; any = true; }
  if ("underline" in patch || "strike" in patch) {
    const d = [];
    if (patch.underline) d.push("underline");
    if (patch.strike) d.push("line-through");
    css.textDecoration = d.length ? d.join(" ") : "none"; any = true;
  }
  if (patch.color) { css.color = patch.color; any = true; }
  if ("highlight" in patch) { css.background = patch.highlight || "transparent"; any = true; }
  return any ? css : null;
}


function ElementView({ el, theme, selected, editing, scale = 1, onMouseDown, onDoubleClick, onBlur, onResizeStart, onRegisterSel, onSelState, onContent, onCell }) {
  const taRef = useRef(null);
  const isText = isTextElement(el);
  const rendered = useMemo(() => (isText ? renderMixed(el.content) : ""), [el.content, isText]);
  const [pop, setPop] = useState(null);
  const rangeRef = useRef(null); // last words the user selected (survives clicking the toolbar)

  useEffect(() => {
    if (editing && taRef.current) {
      const ta = taRef.current;
      ta.innerHTML = contentToEditHtml(el.content); // uncontrolled: set once when editing starts
      ta.focus();
      const r = document.createRange(); r.selectNodeContents(ta); r.collapse(false);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    } else {
      setPop(null); rangeRef.current = null;
    }
  }, [editing]);

  // The live selection if it's still inside this box, otherwise the last one we saved.
  const currentRange = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      if (taRef.current?.contains(r.commonAncestorContainer)) return r;
    }
    const saved = rangeRef.current;
    if (saved && !saved.collapsed && taRef.current?.contains(saved.commonAncestorContainer)) return saved;
    return null;
  };

  const saveContent = () => { if (taRef.current) onContent?.(editHtmlToContent(taRef.current)); };

  // Computed style of the selected words, so B/I/U act as real toggles on the selection.
  const selComputedStyle = () => {
    try {
      const r = currentRange();
      if (!r) return null;
      let node = r.startContainer;
      if (node.nodeType === 3) node = node.parentElement;
      return node ? window.getComputedStyle(node) : null;
    } catch { return null; }
  };
  const resolveToggles = (patch) => {
    const cs = selComputedStyle();
    if (!cs) return patch;
    const out = { ...patch };
    const deco = cs.textDecorationLine || cs.textDecoration || "";
    if ("bold" in out) out.bold = !(parseInt(cs.fontWeight, 10) >= 600);
    if ("italic" in out) out.italic = cs.fontStyle !== "italic";
    if ("underline" in out) out.underline = !/underline/.test(deco);
    if ("strike" in out) out.strike = !/line-through/.test(deco);
    return out;
  };

  // Wrap the selected words in a span carrying the requested styles. Returns true if applied.
  const applySelection = (rawPatch) => {
    const patch = resolveToggles(rawPatch);
    const css = patchToSpanCss(patch);
    if (!css) return false;
    const range = currentRange();
    if (!range) return false;
    try {
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      const span = document.createElement("span");
      Object.assign(span.style, css);
      try { range.surroundContents(span); }
      catch { const frag = range.extractContents(); span.appendChild(frag); range.insertNode(span); }
      const r2 = document.createRange(); r2.selectNodeContents(span);
      sel.removeAllRanges(); sel.addRange(r2);
      rangeRef.current = r2.cloneRange();
      saveContent();
      onSelState?.(true);
      return true;
    } catch { return false; }
  };

  const clearSelection = () => {
    const range = currentRange();
    if (!range) return;
    try {
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      const txt = range.toString();
      range.deleteContents();
      const tn = document.createTextNode(txt);
      range.insertNode(tn);
      const r2 = document.createRange(); r2.selectNodeContents(tn);
      sel.removeAllRanges(); sel.addRange(r2);
      rangeRef.current = r2.cloneRange();
      saveContent();
    } catch {}
    setPop(null);
  };

  // Let the main toolbar drive the selection (Canva-style) while this box is being edited.
  useEffect(() => {
    if (!editing) return undefined;
    onRegisterSel?.({ applyToSelection: applySelection });
    return () => onRegisterSel?.(null);
  }, [editing]);

  // Track the selection: show the floating bar + tell the toolbar to switch to "Selected text".
  const onSel = () => {
    if (!taRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !taRef.current.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      setPop(null); rangeRef.current = null; onSelState?.(false); return;
    }
    const range = sel.getRangeAt(0);
    rangeRef.current = range.cloneRange();
    const rr = range.getBoundingClientRect();
    const br = taRef.current.getBoundingClientRect();
    setPop({ x: rr.left - br.left + rr.width / 2, y: rr.top - br.top });
    onSelState?.(true);
  };

  const styleWord = (kind, color) => {
    if (kind === "clear") { clearSelection(); return; }
    applySelection(kind === "color" ? { color } : { highlight: color });
    setPop(null);
  };

  // Every style below comes from lib/slideRender.js, which the exporter uses verbatim.
  // Keeping one source of truth is what makes the PDF match what you see.
  const wrap = frameStyle(el);

  let inner = null;
  if (isText) {
    const tStyle = textStyle(el, theme);
    inner = editing ? (
      <div ref={taRef} contentEditable suppressContentEditableWarning spellCheck={false}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={onSel}
        onKeyUp={onSel}
        onBlur={(e) => {
          const rt = e.relatedTarget;
          const toToolbar = rt && typeof rt.closest === "function" && rt.closest("[data-editor-toolbar]");
          const val = editHtmlToContent(e.currentTarget);
          if (toToolbar) { onContent?.(val); return; } // keep editing + keep the words selected
          setPop(null); onSelState?.(false);
          onBlur(val);
        }}
        className="kx"
        style={{ ...tStyle, outline: "none", minWidth: 20 }} />
    ) : (
      <div className="kx" style={tStyle} dangerouslySetInnerHTML={{ __html: rendered }} />
    );
  } else if (el.type === "table") {
    // Editing shows one contentEditable per cell (each commits on blur); otherwise the
    // table is rendered from lib/slideRender.js — the exact same markup builder the PDF
    // exporter uses, so the two cannot drift.
    inner = editing ? (
      <table style={{ ...tableStyle(el), outline: "none" }} onMouseDown={(e) => e.stopPropagation()}>
        <colgroup>{tableColWidths(el).map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}</colgroup>
        <tbody>
          {tableRows(el).map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => {
                const isHead = Boolean(el.header ?? true) && r === 0 && tableRows(el).length > 1;
                return (
                  <td
                    key={c}
                    contentEditable
                    suppressContentEditableWarning
                    spellCheck={false}
                    style={{ ...tableCellStyle(el, theme, isHead), outline: "none", cursor: "text" }}
                    onBlur={(e) => onCell?.(r, c, e.currentTarget.innerText)}
                    onKeyDown={(e) => {
                      // Enter commits and leaves; Shift+Enter inserts a line break.
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
                      if (e.key === "Escape") { e.preventDefault(); e.currentTarget.blur(); }
                    }}
                  >
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <div className="kx" style={{ width: "100%", height: "100%" }}
        dangerouslySetInnerHTML={{ __html: tableHTML(el, theme, (cell) => renderMixed(String(cell || ""))) }} />
    );
  } else if (el.type === "line") {
    inner = <div style={shapeInnerStyle(el)}><div style={lineBarStyle(el)} /></div>;
  } else if (el.type === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    inner = <img src={el.src} alt="" draggable={false} style={imageStyle(el)} />;
  } else {
    inner = <div style={shapeInnerStyle(el)} />;
  }

  return (
    <div
      className={`absolute ${editing ? "" : "cursor-move touch-none"} transition-[outline] ${selected ? "outline outline-2 outline-brand-400" : "outline-none hover:outline hover:outline-1 hover:outline-brand-400/40"}`}
      style={wrap}
      onMouseDown={onMouseDown}
      onTouchStart={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {inner}
      {editing && pop && (
        <div
          className="absolute z-[95] flex items-center gap-1 rounded-lg bg-ink-950/95 p-1 shadow-glow ring-1 ring-white/15"
          style={{ left: pop.x, top: pop.y, transform: "translate(-50%, -115%)" }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <span className="px-0.5 text-[11px] font-black text-slate-300">A</span>
          {WORD_COLORS.map((c) => (
            <button key={"t" + c} onMouseDown={(e) => { e.preventDefault(); styleWord("color", c); }} title="Text colour" className="h-4 w-4 rounded-full ring-1 ring-white/25" style={{ background: c }} />
          ))}
          <span className="ml-1 grid h-4 w-4 place-items-center rounded-sm bg-white/10 text-[10px] font-black text-slate-300">▉</span>
          {WORD_HL.map((c) => (
            <button key={"h" + c} onMouseDown={(e) => { e.preventDefault(); styleWord("bg", c); }} title="Highlight" className="h-4 w-4 rounded-sm ring-1 ring-white/25" style={{ background: c }} />
          ))}
          <button onMouseDown={(e) => { e.preventDefault(); styleWord("clear"); }} title="Clear" className="ml-1 rounded px-1 text-xs font-bold text-slate-300 hover:text-white">✕</button>
        </div>
      )}
      {selected && !editing && ["nw", "ne", "sw", "se", "w", "e"].map((c) => (
        <span key={c} onMouseDown={(e) => onResizeStart(e, c, el)} onTouchStart={(e) => onResizeStart(e, c, el)}
          className="absolute z-20 h-3.5 w-3.5 touch-none rounded-sm border border-brand-500 bg-white"
          /* The whole surface is transform-scaled, so counter-scale the grab handles to keep
             them the same physical size at every zoom level. */
          style={{ ...handlePos(c), transform: `scale(${1 / (scale || 1)})` }} />
      ))}
    </div>
  );
}

function SlidesPanel({ slides, current, theme, onSelect, onAdd, onDup, onDelete }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Slides</p>
        <div className="flex gap-1">
          <button onClick={onDup} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-ink-700 hover:text-white" title="Duplicate"><Copy className="h-3.5 w-3.5" /></button>
          <button onClick={onDelete} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-ink-700 hover:text-accent-400" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {slides.map((sl, i) => {
        const t = THEMES[sl.theme] || theme;
        return (
          <button key={sl.id} onClick={() => onSelect(i)} className={`group relative block w-full overflow-hidden rounded-lg ring-1 transition ${i === current ? "ring-2 ring-brand-400" : "ring-white/10 hover:ring-brand-400/50"}`}>
            <span className="absolute left-1.5 top-1.5 z-10 rounded bg-black/40 px-1.5 text-[10px] font-bold text-white">{i + 1}</span>
            <div className="aspect-video p-2 text-left" style={{ ...slideBg(sl, t), color: t.text }}>
              {/* A table shows its first row rather than nothing — a slide whose only content
                  is a table used to look empty in this list. */}
              {sl.elements
                .filter((e) => e.type === "text" || !e.type || e.type === "table")
                .slice(0, 3)
                .map((e) => (
                  <div key={e.id} className="truncate" style={{ fontSize: Math.max(5, (e.fontSize || 15) / 5), fontWeight: e.bold ? 700 : 400 }}>
                    {e.type === "table"
                      ? (tableRows(e)[0] || []).join(" · ").replace(/\$/g, "")
                      : String(e.content || "").replace(/\$/g, "")}
                  </div>
                ))}
            </div>
          </button>
        );
      })}
      <button onClick={onAdd} className="btn-ghost w-full justify-center border border-dashed border-white/15 bg-transparent"><Plus className="h-4 w-4" /> Add slide</button>
    </div>
  );
}

/* Read-only slide surface. Uses exactly the same fixed design size and the same element
   styles as the editor canvas and the exporter, so the preview is a true preview.
   The old modal rendered into a 1024px-wide box while the exporter rendered at 896px, so
   the very same text wrapped in a different place — that alone made every PDF look
   "misaligned" compared with what had just been on screen. */
function StaticSlide({ sl, theme }) {
  return (
    <>
      {(sl.elements || []).map((el) => {
        const frame = frameStyle(el);
        if (isTextElement(el)) {
          return (
            <div key={el.id} style={frame}>
              <div className="kx" style={textStyle(el, theme)} dangerouslySetInnerHTML={{ __html: renderMixed(el.content || "") }} />
            </div>
          );
        }
        if (el.type === "table") {
          return (
            <div key={el.id} style={frame}>
              <div className="kx" style={{ width: "100%", height: "100%" }}
                dangerouslySetInnerHTML={{ __html: tableHTML(el, theme, (cell) => renderMixed(String(cell || ""))) }} />
            </div>
          );
        }
        if (el.type === "line") {
          return <div key={el.id} style={frame}><div style={shapeInnerStyle(el)}><div style={lineBarStyle(el)} /></div></div>;
        }
        if (el.type === "image") {
          return (
            <div key={el.id} style={frame}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={el.src} alt="" style={imageStyle(el)} />
            </div>
          );
        }
        return <div key={el.id} style={frame}><div style={shapeInnerStyle(el)} /></div>;
      })}
    </>
  );
}

function PreviewModal({ slides, onClose }) {
  const [i, setI] = useState(0);
  const boxRef = useRef(null);
  const [scale, setScale] = useState(1);
  const sl = slides[i];
  const theme = THEMES[sl?.theme] || THEMES[DEFAULT_THEME];

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const measure = () => setScale(Math.max(0.05, fitScale(box.clientWidth, box.clientHeight)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setI((v) => Math.min(slides.length - 1, v + 1));
      if (e.key === "ArrowLeft") setI((v) => Math.max(0, v - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, slides.length]);

  if (!sl) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-6" onClick={onClose}>
      <button onClick={onClose} className="absolute right-5 top-5 grid h-10 w-10 place-items-center rounded-xl bg-ink-800 text-white ring-1 ring-white/10"><X className="h-5 w-5" /></button>
      <div ref={boxRef} className="flex w-full max-w-5xl flex-1 items-center justify-center overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div style={{ width: DESIGN_W * scale, height: DESIGN_H * scale }}>
          <div
            className="relative overflow-hidden shadow-glow"
            style={{
              width: DESIGN_W, height: DESIGN_H,
              transform: `scale(${scale})`, transformOrigin: "top left",
              ...slideBg(sl, theme), color: theme.text,
            }}
          >
            <StaticSlide sl={sl} theme={theme} />
          </div>
        </div>
      </div>
      <div className="mt-4 flex shrink-0 items-center justify-center gap-4 text-white" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setI((v) => Math.max(0, v - 1))} className="btn-ghost px-3 py-2"><ChevronLeft className="h-4 w-4" /></button>
        <span className="text-sm">{i + 1} / {slides.length}</span>
        <button onClick={() => setI((v) => Math.min(slides.length - 1, v + 1))} className="btn-ghost px-3 py-2"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

/* Honest save indicator. It only says "Saved" once the server has confirmed the write. */
function SaveBadge({ status, error, onRetry }) {
  if (status === "error") {
    return (
      <button
        onClick={onRetry}
        title={error || "Save failed"}
        className="flex items-center gap-1.5 rounded-lg bg-accent-500/15 px-2.5 py-1.5 text-xs font-semibold text-accent-300 ring-1 ring-inset ring-accent-500/30 hover:bg-accent-500/25"
      >
        <CloudOff className="h-3.5 w-3.5" /> Not saved — retry
      </button>
    );
  }
  const label = status === "saving" ? "Saving…" : status === "dirty" ? "Unsaved changes" : "Saved";
  return (
    <span className="hidden items-center gap-1.5 text-xs text-slate-400 sm:flex" title={label}>
      {status === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />} {label}
    </span>
  );
}
