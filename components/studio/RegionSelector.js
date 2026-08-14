"use client";

import { useRef, useState, useEffect } from "react";
import { ChevronLeft, ChevronRight, Trash2, Eraser } from "lucide-react";

// pages: string[] of image data URLs. onChange(regions) where each region is
// { page, fx, fy, fw, fh } in fractions (0..1) of that page image.
export default function RegionSelector({ pages = [], onChange }) {
  const wrapRef = useRef(null);
  const [page, setPage] = useState(0);
  const [rects, setRects] = useState([]); // {id, page, fx, fy, fw, fh}
  const [draft, setDraft] = useState(null);
  const startRef = useRef(null);

  useEffect(() => {
    onChange?.(rects);
  }, [rects, onChange]);

  const getXY = (e) => {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    return { clientX: t.clientX, clientY: t.clientY };
  };
  const pt = (e) => {
    const { clientX, clientY } = getXY(e);
    const r = wrapRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
    };
  };

  const down = (e) => {
    e.preventDefault();
    const p = pt(e);
    startRef.current = p;
    setDraft({ fx: p.x, fy: p.y, fw: 0, fh: 0 });
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", up);
  };
  const move = (e) => {
    const s = startRef.current;
    if (!s) return;
    if (e.touches) e.preventDefault();
    const p = pt(e);
    setDraft({
      fx: Math.min(s.x, p.x),
      fy: Math.min(s.y, p.y),
      fw: Math.abs(p.x - s.x),
      fh: Math.abs(p.y - s.y),
    });
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    window.removeEventListener("touchmove", move);
    window.removeEventListener("touchend", up);
    setDraft((d) => {
      if (d && d.fw > 0.02 && d.fh > 0.02) {
        setRects((prev) => [...prev, { id: Math.random().toString(36).slice(2), page, ...d }]);
      }
      return null;
    });
    startRef.current = null;
  };

  const removeRect = (id) => setRects((prev) => prev.filter((r) => r.id !== id));
  const clearPage = () => setRects((prev) => prev.filter((r) => r.page !== page));

  const onThisPage = rects.filter((r) => r.page === page);

  return (
    <div className="rounded-2xl bg-ink-850 p-4 ring-1 ring-white/10">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-white">
          Draw boxes around each question / part{" "}
          <span className="text-slate-500">({rects.length} selected)</span>
        </p>
        <div className="flex items-center gap-2">
          {pages.length > 1 && (
            <div className="flex items-center gap-1.5 text-sm text-slate-300">
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} className="grid h-7 w-7 place-items-center rounded-lg bg-ink-800 hover:bg-ink-700"><ChevronLeft className="h-4 w-4" /></button>
              Page {page + 1}/{pages.length}
              <button onClick={() => setPage((p) => Math.min(pages.length - 1, p + 1))} className="grid h-7 w-7 place-items-center rounded-lg bg-ink-800 hover:bg-ink-700"><ChevronRight className="h-4 w-4" /></button>
            </div>
          )}
          <button onClick={clearPage} className="flex items-center gap-1.5 rounded-lg bg-ink-800 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-white">
            <Eraser className="h-3.5 w-3.5" /> Clear page
          </button>
        </div>
      </div>

      <div
        ref={wrapRef}
        onMouseDown={down}
        onTouchStart={down}
        className="relative mx-auto w-full max-w-2xl cursor-crosshair touch-none select-none overflow-hidden rounded-xl ring-1 ring-white/10"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={pages[page]} alt="page" className="pointer-events-none w-full" draggable={false} />
        {onThisPage.map((r, i) => (
          <div key={r.id} className="region-box" style={{ left: `${r.fx * 100}%`, top: `${r.fy * 100}%`, width: `${r.fw * 100}%`, height: `${r.fh * 100}%` }}>
            <span className="region-label">{i + 1}</span>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => removeRect(r.id)}
              className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full bg-accent-600 text-white"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        {draft && (
          <div className="region-box" style={{ left: `${draft.fx * 100}%`, top: `${draft.fy * 100}%`, width: `${draft.fw * 100}%`, height: `${draft.fh * 100}%` }} />
        )}
      </div>
      <p className="mt-2 text-center text-xs text-slate-500">Click and drag to draw a box. Add as many as you need, then hit Extract.</p>
    </div>
  );
}
