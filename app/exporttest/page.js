"use client";

// Diagnostic route — measures the vertical offset between the editor DOM text
// and the renderSlideToCanvas export raster.

import { useEffect, useRef, useState } from "react";
import { renderSlideToCanvas } from "@/lib/slideExport";

const W = 1600, H = 900, EDITOR_W = 896, SCALE = W / EDITOR_W;

const TEST_SLIDE = {
  id: "test1",
  theme: "clean-white",
  elements: [
    { id: "el1", type: "text", x: 6, y: 7, w: 88, h: 12, fontSize: 28, bold: true, fontFamily: "Sora", content: "प्रश्न 1 — Sample Title" },
    { id: "el2", type: "text", x: 6, y: 24, w: 88, h: 66, fontSize: 22, bold: false, fontFamily: "Inter", content: "Line one of the question stem here.\n$\\frac{3x-1}{(x-1)(x-2)(x-3)}$\n(A) first option   (B) second option" }
  ]
};

export default function ExportTest() {
  const slideRef = useRef(null);
  const titleRef = useRef(null);
  const bodyRef = useRef(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    (async () => {
      if (document.fonts?.ready) { try { await document.fonts.ready; } catch {} }
      await new Promise((r) => setTimeout(r, 200));

      const slideTop = slideRef.current.getBoundingClientRect().top;
      const firstLineTop = (node) => {
        const range = document.createRange();
        const tn = node.firstChild;
        range.setStart(tn, 0); range.setEnd(tn, Math.min(3, tn.textContent.length));
        return range.getBoundingClientRect().top - slideTop;
      };
      const edTitle = firstLineTop(titleRef.current);
      const edBody = firstLineTop(bodyRef.current);

      const canvas = await renderSlideToCanvas(TEST_SLIDE, { bg: "#ffffff", text: "#000000" }, W, H);
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, W, H).data;
      const inkRowInBand = (y0, y1) => {
        for (let y = y0; y < y1; y++) {
          for (let x = 0; x < W; x++) {
            if (data[(y * W + x) * 4 + 3] > 20) return y / SCALE;
          }
        }
        return -1;
      };
      const exTitle = inkRowInBand(Math.round(0.04 * H), Math.round(0.20 * H));
      const exBody = inkRowInBand(Math.round(0.21 * H), Math.round(0.45 * H));

      const out = {
        editorTitleTop: +edTitle.toFixed(1), exportTitleTop: +exTitle.toFixed(1), titleShift: +(exTitle - edTitle).toFixed(1),
        editorBodyTop: +edBody.toFixed(1), exportBodyTop: +exBody.toFixed(1), bodyShift: +(exBody - edBody).toFixed(1),
      };
      window.__exporttest = out;
      setResult(out);
    })();
  }, []);

  return (
    <div style={{ padding: 20, fontFamily: "monospace" }}>
      <p>Measuring editor-DOM vs export-raster vertical offset… (0.0 shift = 100% exact match)</p>
      <pre id="result">{result ? JSON.stringify(result, null, 2) : "…"}</pre>

      <div ref={slideRef} style={{ position: "relative", width: 896, height: 504, background: "#fff", outline: "1px solid #999" }}>
        <div ref={titleRef} style={{ position: "absolute", left: "6%", top: "7%", width: "88%", minHeight: "12%", fontSize: 28, fontFamily: "Sora,sans-serif", fontWeight: 700, lineHeight: 1.35, whiteSpace: "pre-wrap", padding: "2px 6px" }}>प्रश्न 1 — Sample Title</div>
        <div ref={bodyRef} style={{ position: "absolute", left: "6%", top: "24%", width: "88%", minHeight: "66%", fontSize: 22, fontFamily: "Inter,sans-serif", fontWeight: 400, lineHeight: 1.35, whiteSpace: "pre-wrap", padding: "2px 6px" }}>Line one of the question stem here.</div>
      </div>
    </div>
  );
}

