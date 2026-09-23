"use client";

import { useState, useEffect, useRef } from "react";
import {
  Bold, Italic, Underline, Strikethrough,
  AlignLeft, AlignCenter, AlignRight,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  ArrowUpToLine, ArrowDownToLine, ArrowUp, ArrowDown,
  Trash2, Undo2, Redo2, Type, Highlighter, ChevronDown, Move, LayoutGrid, Layers, Droplet,
} from "lucide-react";
import { FONTS } from "@/lib/slideStore";
import { listGlobalFonts, ensureFontLoaded } from "@/lib/admin";

const SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 60, 72, 96];
const STROKES = [0, 1, 2, 3, 4, 6, 8, 12];

export default function Toolbar({ el, onChange, onDelete, onUndo, onRedo, canUndo, canRedo, onArrange, onAlign, onTableOp, scope = "element", setScope, selActive = false }) {
  const [adminFonts, setAdminFonts] = useState([]);
  useEffect(() => {
    listGlobalFonts().then((fonts) => {
      fonts.forEach((f) => ensureFontLoaded(f.url));
      setAdminFonts(fonts.map((f) => f.name).filter(Boolean));
    }).catch(() => {});
  }, []);
  const allFonts = Array.from(new Set([...(FONTS || []), ...adminFonts]));
  const [open, setOpen] = useState(null); // "palign" | "pos" | "arrange" | null
  const upd = (patch) => el && onChange(patch);
  const isText = el?.type === "text" || (el && !el.type);
  const isShape = el?.type === "rect" || el?.type === "ellipse";
  const isLine = el?.type === "line";
  const isImage = el?.type === "image";
  const isTable = el?.type === "table";
  const hasShape = isShape || isLine;

  const AlignIcon = el?.align === "center" ? AlignCenter : el?.align === "right" ? AlignRight : AlignLeft;
  const pick = (fn, ...a) => { fn(...a); setOpen(null); };

  return (
    <div data-editor-toolbar className="flex flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-white/10 bg-ink-900/80 px-3 py-2.5 md:flex-wrap md:px-4">
      {/* TEXT */}
      {isText && setScope && (
        selActive ? (
          <div className="mr-1 flex shrink-0 items-center gap-1 rounded-md bg-brand-gradient px-2 py-1 text-[11px] font-bold text-white shadow-soft" title="Changes apply to the words you selected">
            <Highlighter className="h-3 w-3" /> Selected text
          </div>
        ) : (
          <div className="mr-1 flex shrink-0 items-center rounded-md bg-ink-800 p-0.5 ring-1 ring-inset ring-white/10" title="Apply changes to">
            {[["element", "This text"], ["slide", "This slide"], ["all", "All slides"]].map(([v, label]) => (
              <button key={v} onMouseDown={(e) => e.preventDefault()} onClick={() => setScope(v)} className={`whitespace-nowrap rounded px-2 py-1 text-[11px] font-bold transition ${scope === v ? "bg-brand-gradient text-white" : "text-slate-400 hover:text-white"}`}>{label}</button>
            ))}
          </div>
        )
      )}
      <select value={isText || isTable ? el.fontFamily || "Inter" : "Inter"} disabled={!isText && !isTable} onChange={(e) => upd({ fontFamily: e.target.value })}
        className="max-w-[120px] shrink-0 rounded-md bg-ink-800 px-2 py-1.5 text-sm text-white ring-1 ring-inset ring-white/10 disabled:opacity-40">
        {allFonts.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
      <select value={isText || isTable ? el.fontSize || 20 : 20} disabled={!isText && !isTable} onChange={(e) => upd({ fontSize: Number(e.target.value) })}
        className="shrink-0 rounded-md bg-ink-800 px-2 py-1.5 text-sm text-white ring-1 ring-inset ring-white/10 disabled:opacity-40">
        {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <Divider />
      <Btn disabled={!isText} active={isText && el.bold} onClick={() => upd({ bold: !el.bold })} title="Bold"><Bold className="h-4 w-4" /></Btn>
      <Btn disabled={!isText} active={isText && el.italic} onClick={() => upd({ italic: !el.italic })} title="Italic"><Italic className="h-4 w-4" /></Btn>
      <Btn disabled={!isText} active={isText && el.underline} onClick={() => upd({ underline: !el.underline })} title="Underline"><Underline className="h-4 w-4" /></Btn>
      <Btn disabled={!isText} active={isText && el.strike} onClick={() => upd({ strike: !el.strike })} title="Strikethrough"><Strikethrough className="h-4 w-4" /></Btn>
      <Divider />

      {/* paragraph align -> single dropdown */}
      <Drop disabled={!isText} open={open === "palign"} onToggle={() => setOpen(open === "palign" ? null : "palign")} onClose={() => setOpen(null)}
        trigger={<><AlignIcon className="h-4 w-4" /><ChevronDown className="h-3 w-3 opacity-70" /></>} title="Text alignment">
        <Item active={isText && el.align === "left"} onClick={() => pick(upd, { align: "left" })}><AlignLeft className="h-4 w-4" /> Left</Item>
        <Item active={isText && el.align === "center"} onClick={() => pick(upd, { align: "center" })}><AlignCenter className="h-4 w-4" /> Center</Item>
        <Item active={isText && el.align === "right"} onClick={() => pick(upd, { align: "right" })}><AlignRight className="h-4 w-4" /> Right</Item>
      </Drop>

      <ColorBtn title="Text color" disabled={!isText} icon={<Type className="h-4 w-4 text-white" />} value={isText ? el.color || "#0b0a18" : "#0b0a18"} onChange={(v) => upd({ color: v })} />
      <ColorBtn title="Highlight" disabled={!isText} icon={<Highlighter className="h-4 w-4 text-flame-400" />} value={isText ? el.highlight || "#fde047" : "#fde047"} onChange={(v) => upd({ highlight: v })} />
      {isText && el.highlight && <button onClick={() => upd({ highlight: "" })} className="text-xs text-slate-400 hover:text-white">clear</button>}

      {/* SHAPE */}
      {hasShape && (
        <>
          <Divider />
          {!isLine && <ColorBtn title="Fill" icon={<span className="text-[10px] font-bold text-white">FILL</span>} value={el.fill || "#6d3aed"} onChange={(v) => upd({ fill: v })} />}
          <ColorBtn title="Border / line color" icon={<span className="text-[10px] font-bold text-white">LINE</span>} value={el.stroke || "#0b0a18"} onChange={(v) => upd({ stroke: v })} />
          <select value={el.strokeWidth ?? 0} onChange={(e) => upd({ strokeWidth: Number(e.target.value) })}
            className="shrink-0 rounded-md bg-ink-800 px-2 py-1.5 text-sm text-white ring-1 ring-inset ring-white/10" title="Thickness">
            {STROKES.map((s) => <option key={s} value={s}>{s}px</option>)}
          </select>
        </>
      )}

      {/* TABLE */}
      {isTable && (
        <>
          <Divider />
          <div className="flex shrink-0 items-center gap-1 rounded-md bg-ink-800 p-0.5 ring-1 ring-inset ring-white/10">
            <span className="px-1.5 text-[11px] font-bold text-slate-400">Rows</span>
            <button onClick={() => onTableOp?.("addRow")} title="Add row" className="rounded px-2 py-1 text-sm font-bold text-slate-300 hover:bg-white/10 hover:text-white">+</button>
            <button onClick={() => onTableOp?.("delRow")} title="Remove last row" className="rounded px-2 py-1 text-sm font-bold text-slate-300 hover:bg-white/10 hover:text-white">−</button>
          </div>
          <div className="flex shrink-0 items-center gap-1 rounded-md bg-ink-800 p-0.5 ring-1 ring-inset ring-white/10">
            <span className="px-1.5 text-[11px] font-bold text-slate-400">Cols</span>
            <button onClick={() => onTableOp?.("addCol")} title="Add column" className="rounded px-2 py-1 text-sm font-bold text-slate-300 hover:bg-white/10 hover:text-white">+</button>
            <button onClick={() => onTableOp?.("delCol")} title="Remove last column" className="rounded px-2 py-1 text-sm font-bold text-slate-300 hover:bg-white/10 hover:text-white">−</button>
          </div>
          <button
            onClick={() => upd({ header: !(el.header ?? true) })}
            title="Toggle header row"
            className={`shrink-0 rounded-md px-2 py-1.5 text-[11px] font-bold ring-1 ring-inset transition ${(el.header ?? true) ? "bg-brand-gradient text-white ring-transparent" : "bg-ink-800 text-slate-400 ring-white/10 hover:text-white"}`}
          >
            Header
          </button>
          <ColorBtn title="Border colour" icon={<span className="text-[10px] font-bold text-white">LINE</span>} value={el.borderColor || "#94a3b8"} onChange={(v) => upd({ borderColor: v })} />
          <select value={el.borderWidth ?? 1} onChange={(e) => upd({ borderWidth: Number(e.target.value) })}
            className="shrink-0 rounded-md bg-ink-800 px-2 py-1.5 text-sm text-white ring-1 ring-inset ring-white/10" title="Border thickness">
            {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}px</option>)}
          </select>
          <ColorBtn title="Header fill" icon={<span className="text-[10px] font-bold text-white">HDR</span>} value={el.headerFill || "#eef2f7"} onChange={(v) => upd({ headerFill: v })} />
        </>
      )}

      {/* IMAGE */}
      {isImage && (
        <>
          <Divider />
          <div className="flex shrink-0 items-center gap-2 text-xs text-slate-300">
            Corner
            <input type="range" min="0" max="50" value={el.radius ?? 8} onChange={(e) => upd({ radius: Number(e.target.value) })} className="h-1 w-16 cursor-pointer accent-brand-500" />
          </div>
        </>
      )}

      <Divider />

      {/* arrange (layer) -> single dropdown */}
      <Drop disabled={!el} open={open === "arrange"} onToggle={() => setOpen(open === "arrange" ? null : "arrange")} onClose={() => setOpen(null)}
        trigger={<><LayoutGrid className="h-4 w-4" /><ChevronDown className="h-3 w-3 opacity-70" /></>} title="Layer order">
        <Item onClick={() => pick(onArrange, "front")}><ArrowUpToLine className="h-4 w-4" /> Bring to front</Item>
        <Item onClick={() => pick(onArrange, "forward")}><ArrowUp className="h-4 w-4" /> Forward</Item>
        <Item onClick={() => pick(onArrange, "backward")}><ArrowDown className="h-4 w-4" /> Backward</Item>
        <Item onClick={() => pick(onArrange, "back")}><ArrowDownToLine className="h-4 w-4" /> Send to back</Item>
      </Drop>

      {/* position align -> single dropdown */}
      <Drop disabled={!el} open={open === "pos"} onToggle={() => setOpen(open === "pos" ? null : "pos")} onClose={() => setOpen(null)}
        trigger={<><Move className="h-4 w-4" /><ChevronDown className="h-3 w-3 opacity-70" /></>} title="Position on slide">
        <Item onClick={() => pick(onAlign, "left")}><AlignStartVertical className="h-4 w-4" /> Left</Item>
        <Item onClick={() => pick(onAlign, "centerH")}><AlignCenterVertical className="h-4 w-4" /> Center (H)</Item>
        <Item onClick={() => pick(onAlign, "right")}><AlignEndVertical className="h-4 w-4" /> Right</Item>
        <Item onClick={() => pick(onAlign, "top")}><AlignStartHorizontal className="h-4 w-4" /> Top</Item>
        <Item onClick={() => pick(onAlign, "middle")}><AlignCenterHorizontal className="h-4 w-4" /> Middle (V)</Item>
        <Item onClick={() => pick(onAlign, "bottom")}><AlignEndHorizontal className="h-4 w-4" /> Bottom</Item>
      </Drop>

      <Divider />
      {/* Opacity — applies to ANY selected element (text, image, shape, table). Stored 0..1. */}
      <div className={`flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 ring-1 ring-inset ring-white/10 ${el ? "" : "opacity-40"}`} title="Opacity">
        <Droplet className="h-3.5 w-3.5 text-slate-300" />
        <input
          type="range" min="10" max="100" step="5"
          value={Math.round((el?.opacity ?? 1) * 100)}
          disabled={!el}
          onChange={(e) => upd({ opacity: Number(e.target.value) / 100 })}
          className="h-1 w-16 cursor-pointer accent-brand-500 disabled:cursor-not-allowed"
        />
        <span className="w-8 text-right text-[11px] tabular-nums text-slate-400">{Math.round((el?.opacity ?? 1) * 100)}%</span>
      </div>

      <Divider />
      <Btn disabled={!el} title="Delete" onClick={onDelete}><Trash2 className="h-4 w-4 text-accent-400" /></Btn>

      <div className="ml-auto flex items-center gap-1.5">
        <Btn disabled={!canUndo} onClick={onUndo} title="Undo"><Undo2 className="h-4 w-4" /></Btn>
        <Btn disabled={!canRedo} onClick={onRedo} title="Redo"><Redo2 className="h-4 w-4" /></Btn>
      </div>
    </div>
  );
}

function Drop({ trigger, children, open, onToggle, onClose, disabled, title }) {
  const btnRef = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // keep the 176px-wide menu on-screen
      const left = Math.min(r.left, (typeof window !== "undefined" ? window.innerWidth : 9999) - 184);
      setPos({ left: Math.max(8, left), top: r.bottom + 6 });
    }
  }, [open]);
  return (
    <div className="relative">
      <button ref={btnRef} onMouseDown={(e) => e.preventDefault()} onClick={onToggle} disabled={disabled} title={title}
        className="flex h-8 shrink-0 items-center gap-0.5 rounded-md px-2 text-slate-300 ring-1 ring-inset ring-white/10 transition enabled:hover:bg-ink-700 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-40">
        {trigger}
      </button>
      {open && !disabled && pos && (
        <>
          <div className="fixed inset-0 z-[80]" onClick={onClose} />
          <div className="fixed z-[90] w-44 overflow-hidden rounded-xl border border-white/10 bg-ink-850 p-1.5 shadow-glow" style={{ left: pos.left, top: pos.top }}>{children}</div>
        </>
      )}
    </div>
  );
}

function Item({ children, onClick, active }) {
  return (
    <button onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-ink-700 ${active ? "text-brand-300" : "text-white"}`}>
      {children}
    </button>
  );
}

function ColorBtn({ title, icon, value, onChange, disabled }) {
  return (
    <label className={`relative grid h-8 w-9 shrink-0 place-items-center rounded-md ring-1 ring-inset ring-white/10 ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-ink-700"}`} title={title}>
      {icon}
      <span className="absolute bottom-1 h-1 w-5 rounded" style={{ background: value }} />
      <input type="color" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed" />
    </label>
  );
}

function Btn({ children, active, disabled, onClick, title }) {
  return (
    <button onMouseDown={(e) => e.preventDefault()} onClick={onClick} disabled={disabled} title={title}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ring-1 ring-inset transition disabled:opacity-40 disabled:cursor-not-allowed ${active ? "bg-brand-500/25 text-white ring-brand-500/40" : "text-slate-300 ring-white/10 enabled:hover:bg-ink-700 enabled:hover:text-white"}`}>
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-6 w-px bg-white/10" />;
}