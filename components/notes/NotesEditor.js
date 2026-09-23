"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import katex from "katex";
import {
  ArrowLeft, Bold, Italic, Underline, Strikethrough, List, ListOrdered,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Type, Highlighter, Undo2, Redo2,
  Download, Loader2, Cloud, CloudOff, ChevronDown, Minus, Link2, Indent, Outdent, Eraser,
  Columns2, FileText, Sigma, Table as TableIcon, Image as ImageIcon, Printer, X, Palette,
} from "lucide-react";
import { renderMixedAnnotated } from "@/components/Katex";
import { readHandoff, clearHandoff } from "@/lib/slideStore";
import { latexToUnicode } from "@/lib/mathText";
import { consume, remaining } from "@/lib/plan";
import { useAuth } from "@/context/AuthContext";
import { saveDownload, listBackgrounds, saveBackground } from "@/lib/docs";
import { listGlobalBackgrounds } from "@/lib/admin";
import { fileToDataUrl, downscaleDataUrl } from "@/lib/imageCrop";
import { readBrand, writeBrand, prepareLogo } from "@/lib/brand";
import {
  DEFAULT_DESIGN, normalizeDesign, pageStyle, pageBgLayerStyle, bodyStyle, pageCss,
  PAGE_THEMES, PAGE_SIZES, MARGINS,
} from "@/lib/notesDesign";
import { useAutoSave } from "@/lib/useAutoSave";
import { readLocalDraft, clearLocalDraft, localKey } from "@/lib/docStore";
import ThemeToggleButton from "@/components/ThemeToggleButton";

const FONTS = ["Inter", "Sora", "Poppins", "Lora", "Merriweather", "Playfair Display", "Roboto", "Lato", "Nunito", "Georgia", "Arial", "Roboto Mono"];
const SIZES = [{ l: "10", v: "1" }, { l: "13", v: "2" }, { l: "16", v: "3" }, { l: "18", v: "4" }, { l: "24", v: "5" }, { l: "32", v: "6" }, { l: "48", v: "7" }];
const SNIPPETS = [["x²", "x^{2}"], ["a⁄b", "\\frac{a}{b}"], ["√", "\\sqrt{x}"], ["θ", "\\theta"], ["π", "\\pi"], ["≤", "\\leq"], ["≥", "\\geq"], ["×", "\\times"], ["÷", "\\div"], ["∑", "\\sum"], ["∫", "\\int"], ["°", "^{\\circ}"]];

function renderLatex(latex, display) {
  try { return katex.renderToString(latex || "", { throwOnError: false, displayMode: !!display }); }
  catch { return String(latex || "").replace(/</g, "&lt;"); }
}
function escapeHtml(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function buildBodyHtml(items) {
  if (!items?.length) return "<p>Start typing your notes…</p>";
  return items.map((it, i) => {
    const head = `<p class="q-head"><strong>${escapeHtml(it.title || `Question ${i + 1}`)}</strong></p>`;
    return `<section class="q-block">${head}<div class="q-body">${renderMixedAnnotated(it.text || "")}</div></section>`;
  }).join("");
}
function blockToText(bodyEl) {
  const clone = bodyEl.cloneNode(true);
  clone.querySelectorAll(".mathpill").forEach((p) => p.replaceWith(document.createTextNode(latexToUnicode(p.getAttribute("data-latex") || ""))));
  return clone.innerText;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const readFile = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

export default function NotesEditor() {
  const router = useRouter();
  const { user, profile, mergeProfile } = useAuth();

  const bodyRef = useRef(null);
  const hTitleRef = useRef(null);
  const hPdfRef = useRef(null);
  const hContactRef = useRef(null);
  const hTeacherRef = useRef(null);
  const didInit = useRef(false);
  const itemsRef = useRef(null);
  const imgInput = useRef(null);
  const logoInput = useRef(null);

  const [title, setTitle] = useState("Untitled Notes");
  const [docId, setDocId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [dlOpen, setDlOpen] = useState(false);
  const [alignOpen, setAlignOpen] = useState(false);
  const [cols, setCols] = useState(1);
  const [hdBg, setHdBg] = useState("");
  const [hdColor, setHdColor] = useState("#ffffff");
  const [logo, setLogo] = useState(""); // "" = SlideBaba, "none" = removed, dataURL = custom

  // Page design — the notes-side equivalent of the slide editor's themes + background rail.
  const [design, setDesign] = useState(DEFAULT_DESIGN);
  const [designOpen, setDesignOpen] = useState(false);
  const [bgLib, setBgLib] = useState([]);      // the user's own saved backgrounds
  const [sharedBg, setSharedBg] = useState([]); // admin-provided ones
  const [brandBusy, setBrandBusy] = useState("");
  const bgInput = useRef(null);
  const setD = (patch) => setDesign((d) => ({ ...d, ...patch }));

  // LaTeX formula editor
  const [mathEdit, setMathEdit] = useState(null); // { node, display }
  const [mathDraft, setMathDraft] = useState("");

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    const h = readHandoff();
    if (h?.title) setTitle(h.title);
    if (h?.docId) setDocId(h.docId);
    if (h?.cols === 2) setCols(2);
    // Keep the OCR items with the document. They are the only thing that can rebuild the
    // notes if the HTML is ever lost, and re-saving without them would quietly drop them.
    if (h?.items?.length) itemsRef.current = h.items;
    if (bodyRef.current) {
      bodyRef.current.innerHTML = h?.notesHtml || (h?.items?.length ? buildBodyHtml(h.items) : "<p>Start typing your notes…</p>");
      bodyRef.current.querySelectorAll(".mathpill, .katex").forEach((n) => n.setAttribute("contenteditable", "false"));
    }
    const hd = h?.header || {};
    if (hTitleRef.current) hTitleRef.current.innerText = hd.title || "SlideBaba Coaching";
    if (hPdfRef.current && hd.pdf) hPdfRef.current.innerText = hd.pdf;
    if (hContactRef.current && hd.contact) hContactRef.current.innerText = hd.contact;
    if (hTeacherRef.current && hd.teacher) hTeacherRef.current.innerText = hd.teacher;
    if (hd.bg) setHdBg(hd.bg);
    if (hd.color) setHdColor(hd.color);
    if (hd.logo) setLogo(hd.logo);
    if (hd.design) setDesign(normalizeDesign(hd.design));
    clearHandoff();

    // Anything that never made it to the server last time is still on this device.
    const key = localKey(user?.uid, h?.docId || null, "notes");
    const draft = readLocalDraft(key);
    if (draft?.payload?.notesHtml && bodyRef.current) {
      const when = new Date(draft.at).toLocaleString();
      if (window.confirm(
        `SlideBaba has unsaved notes on this device from ${when} that never reached the server.\n\n` +
        "OK  —  restore them\nCancel  —  discard them and open the saved version",
      )) {
        bodyRef.current.innerHTML = draft.payload.notesHtml;
        bodyRef.current.querySelectorAll(".mathpill, .katex").forEach((n) => n.setAttribute("contenteditable", "false"));
        if (draft.meta?.name) setTitle(draft.meta.name);
      } else {
        clearLocalDraft(key);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Autosave. The notes body is read straight out of the DOM at save time, and the (often
     very large, image-bearing) HTML is written through the chunked store — a single
     Firestore document could not hold it, which is why saves used to fail while the header
     still said "Saved". */
  const buildSnapshot = useCallback(() => ({
    meta: { name: title, format: "notes", status: "generated", cols },
    // `header` now travels in the PAYLOAD, not the metadata: a custom logo is a base64 data
    // URL, and on the parent document it blew past Firestore's 1 MiB cap and made every
    // save of this document fail permanently. lib/docs.js routes it for us — it just has to
    // be here rather than in `meta`.
    payload: {
      notesHtml: bodyRef.current?.innerHTML || "",
      ...(itemsRef.current?.length ? { items: itemsRef.current } : {}),
      header: {
        title: hTitleRef.current?.innerText || "",
        pdf: hPdfRef.current?.innerText || "",
        contact: hContactRef.current?.innerText || "",
        teacher: hTeacherRef.current?.innerText || "",
        bg: hdBg, color: hdColor, logo,
        design,
      },
    },
  }), [title, cols, hdBg, hdColor, logo, design]);

  const saver = useAutoSave({ user, docId, setDocId, build: buildSnapshot, format: "notes" });
  const scheduleSave = saver.markDirty;   // every existing call site keeps working

  useEffect(() => { scheduleSave(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, cols, hdBg, hdColor, logo, design]);

  // Backgrounds are shared with the slide editor: one library, both surfaces.
  useEffect(() => {
    if (!user) return;
    listBackgrounds(user.uid).then(setBgLib).catch(() => {});
    listGlobalBackgrounds().then(setSharedBg).catch(() => {});
  }, [user]);

  const pickPageBgImage = async (file) => {
    if (!file) return;
    const data = await downscaleDataUrl(await fileToDataUrl(file), 1400, 0.82);
    setD({ pageBgImage: data });
    scheduleSave();
    if (user) {
      const ref = await saveBackground(user.uid, data);
      if (ref?.id) setBgLib((b) => [{ id: ref.id, url: data }, ...b]);
    }
  };

  /* ---- brand, shared with the slide editor via users/{uid}.brand ---- */

  const useSavedBrand = () => {
    const b = readBrand(profile);
    if (!b.logo && !b.name) return;
    if (b.logo) setLogo(b.logo);
    if (b.name && hTitleRef.current) hTitleRef.current.innerText = b.name;
    scheduleSave();
  };

  const saveAsBrand = async () => {
    setBrandBusy("saving");
    try {
      await writeBrand(user?.uid, {
        logo: logo && logo !== "none" ? logo : "",
        name: hTitleRef.current?.innerText || "",
        wh: readBrand(profile).wh,
      }, mergeProfile);
      setBrandBusy("saved");
      setTimeout(() => setBrandBusy(""), 1800);
    } catch {
      setBrandBusy("failed");
      setTimeout(() => setBrandBusy(""), 2500);
    }
  };

  const cmd = (command, value = null) => { bodyRef.current?.focus(); try { document.execCommand(command, false, value); } catch {} setAlignOpen(false); scheduleSave(); };
  const highlight = (color) => {
    bodyRef.current?.focus();
    try { if (!document.execCommand("hiliteColor", false, color)) document.execCommand("backColor", false, color); }
    catch { try { document.execCommand("backColor", false, color); } catch {} }
    scheduleSave();
  };
  const addLink = () => { const url = window.prompt("Link URL:", "https://"); if (url) cmd("createLink", url); };
  const insertTable = () => {
    const r = parseInt(window.prompt("Rows?", "3") || "0", 10), c = parseInt(window.prompt("Columns?", "3") || "0", 10);
    if (!r || !c) return;
    let html = '<table class="notes-table"><tbody>';
    for (let i = 0; i < r; i++) { html += "<tr>"; for (let j = 0; j < c; j++) html += "<td><br></td>"; html += "</tr>"; }
    html += "</tbody></table><p><br></p>";
    cmd("insertHTML", html);
  };
  const onImage = async (file) => { if (!file) return; try { const data = await readFile(file); cmd("insertHTML", `<img src="${data}" style="max-width:100%;height:auto;" />`); } catch {} };
  const onLogo = async (file) => {
    if (!file) return;
    try {
      const prepared = await prepareLogo(file);
      if (prepared?.logo) { setLogo(prepared.logo); scheduleSave(); }
    } catch { /* an unreadable image is not worth an error dialog */ }
  };

  /* -------- formula editor -------- */
  const openMathEditor = (node) => {
    const display = !!node.querySelector(".katex-display");
    setMathEdit({ node, display });
    setMathDraft(node.getAttribute("data-latex") || "");
  };
  const onBodyClick = (e) => {
    const pill = e.target.closest?.(".mathpill");
    if (pill) { e.preventDefault(); openMathEditor(pill); }
  };
  const insertEquation = () => {
    bodyRef.current?.focus();
    const id = "m" + Date.now();
    cmd("insertHTML", `<span class="mathpill" data-latex="x^{2}" data-fresh="${id}">${renderLatex("x^{2}", false)}</span>\u200b`);
    const pill = bodyRef.current?.querySelector(`.mathpill[data-fresh="${id}"]`);
    if (pill) { pill.removeAttribute("data-fresh"); pill.setAttribute("contenteditable", "false"); openMathEditor(pill); }
  };
  const saveMath = () => {
    if (!mathEdit?.node) return;
    const n = mathEdit.node;
    n.innerHTML = renderLatex(mathDraft, mathEdit.display);
    n.setAttribute("data-latex", mathDraft);
    n.setAttribute("contenteditable", "false");
    setMathEdit(null); scheduleSave();
  };
  const deleteMath = () => { mathEdit?.node?.remove(); setMathEdit(null); scheduleSave(); };

  /* -------- exports -------- */
  /* The allowance is now checked locally (instant, no network) and the usage is recorded
     AFTER the file has been produced. Previously a slow or stuck Firestore write blocked
     the export entirely and the button appeared to do nothing. */
  const checkAllowance = () => {
    if (!user || !profile) return true;
    if (remaining(profile).docsLeft > 0) return true;
    alert("You've used all your document credits for this cycle. Upgrade your plan for more.");
    router.push("/dashboard/subscription");
    return false;
  };
  const recordUse = (name, format) => {
    if (!user) return;
    consume(user.uid, profile, "doc").then((cr) => { if (cr?.ok) mergeProfile(cr.patch); }).catch(() => {});
    saveDownload(user.uid, { name, format, kind: "notes" }).catch(() => {});
  };

  const exportPdf = async () => {
    setDlOpen(false); setMathEdit(null);
    if (!checkAllowance()) return;
    if (user && saver.isDirty()) saver.saveNow().catch(() => {});
    setTimeout(() => {
      window.print();
      recordUse(`${title || "notes"}.pdf`, "pdf");
    }, 120);
  };
  const exportDocx = async () => {
    setDlOpen(false);
    if (!checkAllowance()) return;
    if (user && saver.isDirty()) saver.saveNow().catch(() => {});
    setExporting(true);
    try {
      const docx = await import("docx");
      const { Document, Packer, Paragraph, TextRun, AlignmentType } = docx;
      const children = [];
      const coaching = hTitleRef.current?.innerText?.trim() || "SlideBaba Coaching";
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: coaching, bold: true, size: 32, color: "3A1F7A" })] }));
      const sub = [hPdfRef.current?.innerText, hContactRef.current?.innerText, hTeacherRef.current?.innerText].map((x) => (x || "").trim()).filter(Boolean).join("    |    ");
      if (sub) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: sub, size: 18, color: "666666" })] }));
      children.push(new Paragraph({ text: "" }));
      const blocks = Array.from(bodyRef.current?.querySelectorAll(".q-block") || []);
      if (blocks.length) {
        blocks.forEach((blk) => {
          const head = blk.querySelector(".q-head")?.innerText?.trim();
          if (head) children.push(new Paragraph({ spacing: { before: 180, after: 40 }, children: [new TextRun({ text: head, bold: true, size: 24, color: "5B21B6" })] }));
          const bodyEl = blk.querySelector(".q-body");
          if (bodyEl) blockToText(bodyEl).split("\n").forEach((line) => children.push(new Paragraph({ children: [new TextRun({ text: line, size: 22 })] })));
        });
      } else {
        blockToText(bodyRef.current).split("\n").forEach((line) => children.push(new Paragraph({ children: [new TextRun({ text: line, size: 22 })] })));
      }
      const doc = new Document({ sections: [{ properties: cols === 2 ? { column: { count: 2, space: 560 } } : {}, children }] });
      download(await Packer.toBlob(doc), `${title || "notes"}.docx`);
      recordUse(`${title || "notes"}.docx`, "docx");
    } catch (e) { console.error("[SlideBaba] notes DOCX failed:", e); alert("Word export failed: " + (e?.message || e)); }
    finally { setExporting(false); }
  };

  return (
    <div className="app-shell flex h-screen [height:100dvh] flex-col bg-slate-100 dark:bg-ink-950">
      <style>{`
        .notes-hd-field:empty:before{ content:attr(data-ph); opacity:.7; }
        .notes-body{ outline:none; }
        .notes-body.cols2{ column-count:2; column-gap:34px; }
        .notes-body .q-block{ break-inside:avoid; margin-bottom:22px; }
        .notes-body .q-head{ font-weight:800; color:#5b21b6; margin:0 0 6px; }
        .notes-body .q-body{ white-space:pre-wrap; line-height:1.7; color:#1e293b; }
        /* Urdu glyphs fall back to Nastaliq (per-glyph); Latin/Devanagari keep their font. */
        .notes-body, .notes-body .q-body, .notes-body .q-head{ font-family: inherit, 'Noto Nastaliq Urdu'; }
        .notes-body [lang="ur"], .notes-body .urdu{ font-family:'Noto Nastaliq Urdu', serif; line-height:2.0; }
        .notes-body .mathpill{ display:inline-block; background:#eef1f7; border:1px solid #e1e6f0; border-radius:6px; padding:1px 6px; cursor:pointer; }
        .notes-body .mathpill:hover{ background:#e4e9fb; border-color:#c7d2fe; }
        .notes-body .mathpill .katex{ background:transparent; border:0; padding:0; }
        .notes-body p{ margin:0 0 8px; } .notes-body ul,.notes-body ol{ margin:0 0 8px 22px; }
        .notes-table{ border-collapse:collapse; width:100%; margin:6px 0 12px; }
        .notes-table td{ border:1px solid #cbd5e1; padding:6px 8px; min-width:40px; }
        @media (max-width:860px){ .notes-page{ width:100%; } }
        @media print {
          body * { visibility:hidden !important; }
          #notes-print, #notes-print * { visibility:visible !important; }
          #notes-print *{ -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
          #notes-print{ position:absolute; left:0; top:0; width:100%; }
          .notes-page{ width:100% !important; min-height:auto !important; box-shadow:none !important; }
          .mathpill{ background:transparent !important; border:0 !important; padding:0 !important; }
        }
      `}</style>
      {/* Page size, margins and theme colours are generated so that the on-screen sheet and
          the printed @page can never describe different paper. See lib/notesDesign.js. */}
      <style>{pageCss(design)}</style>

      <header className="flex min-h-[3.5rem] shrink-0 flex-wrap items-center justify-between gap-y-2 border-b border-white/10 bg-ink-900/90 px-2 py-2 no-print sm:h-14 sm:flex-nowrap sm:py-0 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <button onClick={() => router.push("/dashboard/studio")} className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-slate-300 hover:bg-ink-700 hover:text-white"><ArrowLeft className="h-4 w-4" /></button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="SlideBaba" className="hidden h-8 w-8 rounded-md sm:block" />
          <div className="min-w-0 flex-1">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full min-w-0 bg-transparent font-display text-sm font-bold text-white outline-none" />
            <p className="text-[11px] text-slate-500">A4 Notes</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <NotesSaveBadge status={saver.status} error={saver.error} onRetry={() => saver.saveNow()} />
          <ThemeToggleButton />
          <div className="relative">
            <button onClick={() => setDlOpen((v) => !v)} disabled={exporting} className="btn-primary px-3 py-2 text-sm disabled:opacity-60">
              {exporting ? <><Loader2 className="h-4 w-4 animate-spin" /> Exporting…</> : <><Download className="h-4 w-4" /> Download <ChevronDown className="h-3.5 w-3.5 opacity-80" /></>}
            </button>
            {dlOpen && !exporting && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setDlOpen(false)} />
                <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-white/10 bg-ink-850 p-1.5 shadow-glow">
                  <button onClick={exportPdf} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-white hover:bg-ink-700">
                    <Printer className="h-4 w-4 text-accent-400" /> <span><b>PDF</b><br /><span className="text-[11px] text-slate-500">vector quality — choose “Save as PDF”</span></span>
                  </button>
                  <button onClick={exportDocx} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-white hover:bg-ink-700">
                    <FileText className="h-4 w-4 text-sky-400" /> <span><b>Word</b><br /><span className="text-[11px] text-slate-500">.docx — editable in Word</span></span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* toolbar */}
      <div className="no-print flex shrink-0 flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-white/10 bg-ink-900/80 px-3 py-2.5 md:flex-wrap md:px-4">
        <select onChange={(e) => cmd("fontName", e.target.value)} defaultValue="Inter" title="Font" className="max-w-[110px] shrink-0 rounded-md bg-ink-800 px-2 py-1.5 text-sm text-white ring-1 ring-inset ring-white/10">
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select onChange={(e) => cmd("fontSize", e.target.value)} defaultValue="3" title="Size" className="shrink-0 rounded-md bg-ink-800 px-2 py-1.5 text-sm text-white ring-1 ring-inset ring-white/10">
          {SIZES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
        </select>
        <select onChange={(e) => cmd("formatBlock", e.target.value)} defaultValue="p" title="Style" className="shrink-0 rounded-md bg-ink-800 px-2 py-1.5 text-sm text-white ring-1 ring-inset ring-white/10">
          <option value="p">Normal</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option>
        </select>
        <Sep />
        <TBtn onClick={() => cmd("bold")} title="Bold"><Bold className="h-4 w-4" /></TBtn>
        <TBtn onClick={() => cmd("italic")} title="Italic"><Italic className="h-4 w-4" /></TBtn>
        <TBtn onClick={() => cmd("underline")} title="Underline"><Underline className="h-4 w-4" /></TBtn>
        <TBtn onClick={() => cmd("strikeThrough")} title="Strikethrough"><Strikethrough className="h-4 w-4" /></TBtn>
        <TBtn onClick={() => cmd("removeFormat")} title="Clear formatting"><Eraser className="h-4 w-4" /></TBtn>
        <Sep />
        <TBtn onClick={() => cmd("insertUnorderedList")} title="Bullet list"><List className="h-4 w-4" /></TBtn>
        <TBtn onClick={() => cmd("insertOrderedList")} title="Numbered list"><ListOrdered className="h-4 w-4" /></TBtn>
        <TBtn onClick={() => cmd("outdent")} title="Outdent"><Outdent className="h-4 w-4" /></TBtn>
        <TBtn onClick={() => cmd("indent")} title="Indent"><Indent className="h-4 w-4" /></TBtn>
        <Sep />
        <ColorBtn title="Text color" icon={<Type className="h-4 w-4 text-white" />} defaultValue="#1e293b" onChange={(v) => cmd("foreColor", v)} />
        <ColorBtn title="Highlight" icon={<Highlighter className="h-4 w-4 text-flame-400" />} defaultValue="#fde047" onChange={highlight} />
        <div className="relative">
          <TBtn onClick={() => setAlignOpen((v) => !v)} title="Alignment"><AlignLeft className="h-4 w-4" /><ChevronDown className="h-3 w-3 opacity-70" /></TBtn>
          {alignOpen && (
            <>
              <div className="fixed inset-0 z-40" onMouseDown={() => setAlignOpen(false)} />
              <div className="absolute left-0 z-50 mt-2 w-40 overflow-hidden rounded-xl border border-white/10 bg-ink-850 p-1.5 shadow-glow">
                <MenuItem onClick={() => cmd("justifyLeft")}><AlignLeft className="h-4 w-4" /> Left</MenuItem>
                <MenuItem onClick={() => cmd("justifyCenter")}><AlignCenter className="h-4 w-4" /> Center</MenuItem>
                <MenuItem onClick={() => cmd("justifyRight")}><AlignRight className="h-4 w-4" /> Right</MenuItem>
                <MenuItem onClick={() => cmd("justifyFull")}><AlignJustify className="h-4 w-4" /> Justify</MenuItem>
              </div>
            </>
          )}
        </div>
        <Sep />
        <TBtn onClick={insertEquation} title="Insert / edit formula (LaTeX)"><Sigma className="h-4 w-4 text-brand-300" /></TBtn>
        <TBtn onClick={insertTable} title="Insert table"><TableIcon className="h-4 w-4" /></TBtn>
        <TBtn onClick={addLink} title="Insert link"><Link2 className="h-4 w-4" /></TBtn>
        <input ref={imgInput} type="file" accept="image/*" className="hidden" onChange={(e) => onImage(e.target.files?.[0])} />
        <TBtn onClick={() => imgInput.current?.click()} title="Insert image"><ImageIcon className="h-4 w-4" /></TBtn>
        <TBtn onClick={() => cmd("insertHorizontalRule")} title="Divider"><Minus className="h-4 w-4" /></TBtn>
        <Sep />
        <input ref={logoInput} type="file" accept="image/*" className="hidden" onChange={(e) => onLogo(e.target.files?.[0])} />
        <input ref={bgInput} type="file" accept="image/*" className="hidden" onChange={(e) => pickPageBgImage(e.target.files?.[0])} />
        <button
          onClick={() => setDesignOpen((v) => !v)}
          title="Page design and branding"
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm ring-1 ring-inset transition ${designOpen ? "bg-brand-500/25 text-white ring-brand-500/40" : "text-slate-300 ring-white/10 hover:bg-ink-700 hover:text-white"}`}
        >
          <Palette className="h-4 w-4" /> Design
        </button>
        <Sep />
        <button onClick={() => setCols((c) => (c === 2 ? 1 : 2))} title="Split into two columns"
          className={`flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-sm ring-1 ring-inset transition ${cols === 2 ? "bg-brand-500/25 text-white ring-brand-500/40" : "text-slate-300 ring-white/10 hover:bg-ink-700 hover:text-white"}`}>
          <Columns2 className="h-4 w-4" /> {cols === 2 ? "2 cols" : "1 col"}
        </button>
        <div className="flex items-center gap-1.5 md:ml-auto">
          <TBtn onClick={() => cmd("undo")} title="Undo"><Undo2 className="h-4 w-4" /></TBtn>
          <TBtn onClick={() => cmd("redo")} title="Redo"><Redo2 className="h-4 w-4" /></TBtn>
        </div>
      </div>

      {/* Design panel — page customization + branding, the notes-side counterpart of the
          slide editor's Themes / BG / Brand rails. */}
      {designOpen && (
        <>
          <div className="fixed inset-0 z-30 bg-black/40 no-print" onClick={() => setDesignOpen(false)} />
          <aside className="no-print fixed right-0 top-0 z-40 flex h-full w-[320px] max-w-[88vw] flex-col overflow-y-auto border-l border-white/10 bg-ink-900 p-4 shadow-glow">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-white">Page design</h3>
              <button onClick={() => setDesignOpen(false)} className="grid h-8 w-8 place-items-center rounded-md text-slate-400 hover:bg-ink-700 hover:text-white"><X className="h-4 w-4" /></button>
            </div>

            <Group label="Theme">
              <div className="grid grid-cols-5 gap-1.5">
                {Object.values(PAGE_THEMES).map((t) => (
                  <button key={t.id} onClick={() => { setD({ theme: t.id, pageBg: "", pageBgImage: "" }); scheduleSave(); }}
                    title={t.label}
                    className={`h-10 rounded-lg ring-1 transition ${design.theme === t.id && !design.pageBg && !design.pageBgImage ? "ring-2 ring-brand-400" : "ring-white/15 hover:ring-brand-400/60"}`}
                    style={{ background: t.bg }}>
                    <span className="block h-1.5 w-1/2 rounded-full" style={{ background: t.head, margin: "0 auto" }} />
                  </button>
                ))}
              </div>
            </Group>

            <Group label="Page size">
              <div className="flex gap-1.5">
                {Object.values(PAGE_SIZES).map((z) => (
                  <button key={z.id} onClick={() => { setD({ pageSize: z.id }); scheduleSave(); }}
                    className={`flex-1 rounded-lg px-2 py-2 text-xs font-bold ring-1 ring-inset transition ${design.pageSize === z.id ? "bg-brand-gradient text-white ring-transparent" : "bg-ink-800 text-slate-300 ring-white/10 hover:text-white"}`}>
                    {z.label}
                  </button>
                ))}
              </div>
            </Group>

            <Group label="Margins">
              <div className="flex gap-1.5">
                {Object.values(MARGINS).map((m) => (
                  <button key={m.id} onClick={() => { setD({ margin: m.id }); scheduleSave(); }}
                    className={`flex-1 rounded-lg px-2 py-2 text-xs font-bold ring-1 ring-inset transition ${design.margin === m.id ? "bg-brand-gradient text-white ring-transparent" : "bg-ink-800 text-slate-300 ring-white/10 hover:text-white"}`}>
                    {m.label}
                  </button>
                ))}
              </div>
            </Group>

            <Group label="Body text size">
              <div className="flex items-center gap-3">
                <input type="range" min="11" max="22" value={design.bodySize}
                  onChange={(e) => setD({ bodySize: Number(e.target.value) })}
                  onMouseUp={scheduleSave} onTouchEnd={scheduleSave}
                  className="h-1 flex-1 cursor-pointer accent-brand-500" />
                <span className="w-10 text-right text-xs font-bold text-slate-300">{design.bodySize}px</span>
              </div>
            </Group>

            <Group label="Page background">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="color" value={design.pageBg || "#ffffff"}
                    onChange={(e) => { setD({ pageBg: e.target.value, pageBgImage: "" }); scheduleSave(); }}
                    className="h-8 w-10 cursor-pointer rounded bg-transparent" />
                  Colour
                </label>
                <button onClick={() => bgInput.current?.click()} className="btn-ghost px-2 py-1.5 text-xs"><ImageIcon className="h-3.5 w-3.5" /> Image</button>
                {(design.pageBg || design.pageBgImage) && (
                  <button onClick={() => { setD({ pageBg: "", pageBgImage: "", bgOpacity: 1 }); scheduleSave(); }} className="text-xs text-slate-400 hover:text-white">reset</button>
                )}
              </div>
              {design.pageBgImage && (
                <div className="mt-2.5 flex items-center gap-3">
                  <span className="text-[11px] text-slate-400">Opacity</span>
                  <input type="range" min="10" max="100" step="5"
                    value={Math.round((design.bgOpacity ?? 1) * 100)}
                    onChange={(e) => setD({ bgOpacity: Number(e.target.value) / 100 })}
                    onMouseUp={scheduleSave} onTouchEnd={scheduleSave}
                    className="h-1 flex-1 cursor-pointer accent-brand-500" />
                  <span className="w-9 text-right text-[11px] tabular-nums text-slate-400">{Math.round((design.bgOpacity ?? 1) * 100)}%</span>
                </div>
              )}
              {(bgLib.length > 0 || sharedBg.length > 0) && (
                <div className="mt-2 grid grid-cols-4 gap-1.5">
                  {[...bgLib, ...sharedBg].slice(0, 12).map((b) => (
                    <button key={b.id} onClick={() => { setD({ pageBgImage: b.url, pageBg: "" }); scheduleSave(); }}
                      className="h-10 rounded-md bg-cover bg-center ring-1 ring-white/15 hover:ring-brand-400"
                      style={{ backgroundImage: `url("${b.url}")` }} />
                  ))}
                </div>
              )}
            </Group>

            <Group label="Header band">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="color" value={hdBg || "#3a1f7a"} onChange={(e) => { setHdBg(e.target.value); scheduleSave(); }} className="h-8 w-10 cursor-pointer rounded bg-transparent" />
                  Background
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="color" value={hdColor || "#ffffff"} onChange={(e) => { setHdColor(e.target.value); scheduleSave(); }} className="h-8 w-10 cursor-pointer rounded bg-transparent" />
                  Text
                </label>
              </div>
            </Group>

            <Group label="Branding">
              <div className="flex flex-wrap gap-2">
                <button onClick={() => logoInput.current?.click()} className="btn-ghost px-2 py-1.5 text-xs"><ImageIcon className="h-3.5 w-3.5" /> Upload logo</button>
                <button onClick={() => { setLogo((l) => (l === "none" ? "" : "none")); scheduleSave(); }} className="btn-ghost px-2 py-1.5 text-xs">
                  {logo === "none" ? "Show logo" : "Hide logo"}
                </button>
              </div>
              {/* One brand, both editors — users/{uid}.brand. Setting it up for slides used
                  to have no effect here at all. */}
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={useSavedBrand} disabled={!readBrand(profile).logo && !readBrand(profile).name}
                  className="btn-ghost px-2 py-1.5 text-xs disabled:opacity-40">
                  Use my saved brand
                </button>
                <button onClick={saveAsBrand} className="btn-ghost px-2 py-1.5 text-xs">
                  {brandBusy === "saving" ? "Saving…" : brandBusy === "saved" ? "Saved ✓" : brandBusy === "failed" ? "Failed" : "Save as my brand"}
                </button>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-slate-500">Your saved brand is shared with the slide editor.</p>
            </Group>

            <Group label="Footer">
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={!!design.footer} onChange={(e) => { setD({ footer: e.target.checked }); scheduleSave(); }} className="accent-brand-500" />
                Show a footer line
              </label>
              {design.footer && (
                <input value={design.footerText} onChange={(e) => setD({ footerText: e.target.value })} onBlur={scheduleSave}
                  placeholder="Footer text (defaults to your coaching name)"
                  className="mt-2 w-full rounded-md bg-ink-800 px-2 py-1.5 text-xs text-white ring-1 ring-inset ring-white/10 outline-none placeholder:text-slate-500" />
              )}
              <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
                The footer prints once at the end of the notes. Per-page footers aren&apos;t possible with browser printing.
              </p>
            </Group>
          </aside>
        </>
      )}

      {/* A4 canvas */}
      <div className="flex-1 overflow-auto bg-slate-200/70 p-6 dark:bg-ink-950">
        <div id="notes-print" className="mx-auto w-fit">
          <div className="notes-page relative mx-auto overflow-hidden shadow-card" style={pageStyle(design)}>
            {pageBgLayerStyle(design) && <div aria-hidden style={pageBgLayerStyle(design)} />}
            <div className="relative z-10 flex items-center justify-between gap-4 bg-gradient-to-r from-[#1d1248] to-[#3a1f7a] px-6 py-4 text-white" style={{ background: hdBg || undefined, color: hdColor || undefined }}>
              {logo === "none" ? (
                <div className="h-12 w-12 shrink-0" />
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={logo || "/logo.png"} alt="" className="h-12 w-12 shrink-0 rounded-lg bg-white/10 object-contain p-1" />
              )}
              <div className="flex-1 text-center">
                <div ref={hTitleRef} contentEditable suppressContentEditableWarning onInput={scheduleSave}
                  className="notes-hd-field mx-auto inline-block min-w-[180px] font-display text-2xl font-extrabold outline-none" data-ph="Coaching Name" />
                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  <span ref={hPdfRef} contentEditable suppressContentEditableWarning onInput={scheduleSave} data-ph="PDF Name" className="notes-hd-field rounded-full bg-white/15 px-3 py-1 text-xs font-semibold outline-none" />
                  <span ref={hContactRef} contentEditable suppressContentEditableWarning onInput={scheduleSave} data-ph="Contact Details" className="notes-hd-field rounded-full bg-white/15 px-3 py-1 text-xs font-semibold outline-none" />
                  <span ref={hTeacherRef} contentEditable suppressContentEditableWarning onInput={scheduleSave} data-ph="Teacher Name" className="notes-hd-field rounded-full bg-white/15 px-3 py-1 text-xs font-semibold outline-none" />
                </div>
              </div>
              <div className="h-12 w-12" />
            </div>
            <div ref={bodyRef} contentEditable suppressContentEditableWarning onInput={scheduleSave} onClick={onBodyClick}
              className={`notes-body relative z-10 ${cols === 2 ? "cols2" : ""}`} style={bodyStyle(design)} />
            {design.footer && (
              <div className="relative z-10 px-10 pb-6 pt-2 text-center text-[11px] opacity-70">
                {design.footerText || hTitleRef.current?.innerText || ""}
              </div>
            )}
          </div>
        </div>
        <p className="no-print mx-auto mt-4 max-w-[794px] text-center text-xs text-slate-500">
          Click any formula to edit its LaTeX. Use the toolbar for tables, images, colours, highlight and a two-column split. PDF exports at vector quality.
        </p>
      </div>

      {/* formula editor modal */}
      {mathEdit && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4" onMouseDown={() => setMathEdit(null)}>
          <div className="w-full max-w-lg rounded-2xl bg-ink-850 p-5 ring-1 ring-white/10" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-white">Edit formula (LaTeX)</h3>
              <button onClick={() => setMathEdit(null)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-ink-700 hover:text-white"><X className="h-4 w-4" /></button>
            </div>
            <div className="mb-3 grid min-h-[64px] place-items-center rounded-xl bg-white p-3 text-ink-900">
              <span className="kx" dangerouslySetInnerHTML={{ __html: renderLatex(mathDraft, mathEdit.display) }} />
            </div>
            <textarea value={mathDraft} onChange={(e) => setMathDraft(e.target.value)} spellCheck={false} rows={3}
              className="w-full resize-none rounded-xl bg-ink-800 px-3 py-2.5 font-mono text-sm text-white outline-none ring-1 ring-inset ring-white/10"
              placeholder="e.g. \frac{x^2+1}{2}" />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SNIPPETS.map(([label, tex]) => (
                <button key={tex} onClick={() => setMathDraft((d) => d + tex)} className="rounded-lg bg-ink-800 px-2 py-1 text-sm text-slate-200 ring-1 ring-inset ring-white/10 hover:bg-ink-700">{label}</button>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between">
              <button onClick={deleteMath} className="text-sm text-accent-400 hover:text-accent-300">Delete formula</button>
              <div className="flex gap-2">
                <button onClick={() => setMathEdit(null)} className="btn-ghost px-3 py-2 text-sm">Cancel</button>
                <button onClick={saveMath} className="btn-primary px-3 py-2 text-sm">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TBtn({ children, onClick, title }) {
  return (
    <button onMouseDown={(e) => e.preventDefault()} onClick={onClick} title={title}
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-md px-2 text-slate-300 ring-1 ring-inset ring-white/10 transition hover:bg-ink-700 hover:text-white">{children}</button>
  );
}
function ColorBtn({ title, icon, defaultValue, onChange }) {
  return (
    <label className="relative grid h-8 w-9 shrink-0 cursor-pointer place-items-center rounded-md ring-1 ring-inset ring-white/10 hover:bg-ink-700" title={title}>
      {icon}
      <input type="color" defaultValue={defaultValue} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
    </label>
  );
}
function Sep() { return <span className="mx-1 h-6 w-px bg-white/10" />; }
function MenuItem({ children, onClick }) {
  return (
    <button onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-white hover:bg-ink-700">{children}</button>
  );
}

/* Only reports "Saved" once the server has actually confirmed the write. */
function NotesSaveBadge({ status, error, onRetry }) {
  if (status === "error") {
    return (
      <button onClick={onRetry} title={error || "Save failed"}
        className="flex items-center gap-1.5 rounded-lg bg-accent-500/15 px-2.5 py-1.5 text-xs font-semibold text-accent-300 ring-1 ring-inset ring-accent-500/30 hover:bg-accent-500/25">
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

/** One labelled block in the design panel. */
function Group({ label, children }) {
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
      {children}
    </div>
  );
}
