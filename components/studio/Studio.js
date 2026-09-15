"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Cpu, Scissors, Upload, Loader2, Trash2, CheckCircle2, Circle,
  ArrowRight, FileUp, Crosshair, Scan, RefreshCw, FileText, Presentation,
  Laptop, Bot, AlertTriangle,
} from "lucide-react";
import { renderMixed } from "@/components/Katex";
import RegionSelector from "@/components/studio/RegionSelector";
import { useAuth } from "@/context/AuthContext";
import { saveHandoff } from "@/lib/slideStore";
import { buildFittedSlides } from "@/lib/slideLayout";
import { saveDocument, updateDocument, touchDocument } from "@/lib/docs";
import { canCreateSlides, consume, remaining, maxPagesFor, PLANS } from "@/lib/plan";
import PlanModal from "@/components/subscription/PlanModal";
import { cropImage, fileToDataUrl, pdfToPageImages, imageSize, downscaleDataUrl, tilePageImage } from "@/lib/imageCrop";

// Remove near-duplicate sections that can appear twice because column tiles overlap.
function dedupeSections(sections) {
  const norm = (t) => String(t || "").replace(/\s+/g, " ").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase().slice(0, 90);
  const seen = new Set();
  const out = [];
  for (const sec of sections || []) {
    const key = norm((sec.heading || "") + "|" + (sec.body || ""));
    if (key.length < 8) { out.push(sec); continue; } // too short to judge — keep
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sec);
  }
  return out;
}

// Matches an option marker in EITHER script Indian exam papers use: Latin/roman "(A)" "(iii)"
// or Devanagari "(क)" "(अ)" — papers OCR'd correctly in Hindi almost never carry Latin letters,
// so counting only A-D was undercounting (effectively to zero) on every Hindi MCQ page.
const OPTION_RE = /\([A-Da-divxIVX]+\)|\([क-ह]{1,3}\)/g;

// Count total multiple-choice options across sections — a good proxy for how complete a read is.
function totalOptionCount(sections) {
  let n = 0;
  for (const sec of sections || []) {
    const body = String(sec.body || "");
    n += (body.match(OPTION_RE) || []).length;
  }
  return n;
}

// How many sections show at least one option-like marker — i.e. look like MCQ questions.
function mcqSectionCount(sections) {
  let n = 0;
  for (const sec of sections || []) {
    OPTION_RE.lastIndex = 0;
    if (OPTION_RE.test(String(sec.body || ""))) n++;
  }
  return n;
}

// A whole-page read "looks thin" only when it shows signs of an MCQ page with options
// actually missing (e.g. (A)(B)(C) found but not (D)). We deliberately do NOT flag a page
// as thin just because it has zero options overall — plain theory/descriptive questions
// legitimately have none, and treating that as "thin" was re-running (and doubling the
// wait on) every non-MCQ page through the slower tile-split fallback for nothing.
function looksThin(sections) {
  if (!sections || !sections.length) return true;
  const mcq = mcqSectionCount(sections);
  if (!mcq) return false; // no MCQ signal on this page — trust the whole-page read
  const opts = totalOptionCount(sections);
  return opts < mcq * 3; // MCQ sections should show ~4 options each; well under that = suspicious
}


/* --------------------------------------------------------------------------
 * OCR engines
 *
 * "paddle"  PaddleOCR running on your own machine — free, unlimited, offline.
 * "openai"  ChatGPT (GPT-4o vision) — paid per page, hosted, rate-limited.
 *
 * The server routes both through the SAME structurer, so the choice only changes
 * who reads the pixels. Everything after that — question splitting, options,
 * LaTeX, slide layout, export — is identical, which is what makes this a real
 * A/B toggle rather than two different pipelines.
 *
 * Per-engine tuning below is not cosmetic: PaddleOCR (local) is happiest with one
 * page at a time and a 1600px upload, while the OpenAI API is fine with a couple
 * of pages in flight and wants a slightly larger image for `detail: "high"`.
 * ------------------------------------------------------------------------ */
// v2: the v1 key was populated by the old Model 2 default rather than by a real choice,
// so it must not be honoured — otherwise everyone who ever opened the Studio stays on
// Model 2 even though the default is now Model 1.
const ENGINE_STORAGE_KEY = "slidebaba.ocrEngine.v2";

const ENGINE_META = {
  openai: {
    id: "openai",
    label: "Model 1",
    sub: "ChatGPT",
    Icon: Bot,
    // Four pages in flight (was 2). This is the main lever on how long a multi-page PDF
    // takes end to end: each page's own read time is unchanged, but reading four at once
    // instead of two roughly halves the wall-clock again. Four is comfortably inside a
    // normal OpenAI rate limit; any 429 still backs off and retries on its own, and the
    // server gate (OPENAI_CONCURRENCY, now 4) matches so pages don't just queue there.
    concurrency: 4,
    tileConcurrency: 3,
    // Each analyze chunk is a real model call here, so keep the fan-out modest — but 3 in
    // flight instead of 2 shaves the second (splitting) wait on long papers too.
    analyzeConcurrency: 3,
    tries: 2,
    // NO column-tile fallback for Model 1.
    //
    // The tile pass re-reads a page as two half-width images when the whole-page read
    // looks like it lost options. That heuristic was written for PaddleOCR. On a hosted
    // vision model it TRIPLES the cost and the wall-clock time of a page — three long
    // completions instead of one — and a vision model rarely drops half a page in the
    // first place. This is the single biggest reason Model 1 felt slow on dense papers.
    tiles: false,
    // 1600px is what this was before the dual-engine work. Raising it to 1800 added
    // image tiles at detail:"high" for no measurable accuracy gain — just a slower,
    // more expensive call on every page.
    sizes: [
      { maxDim: 1600, quality: 0.82 },
      { maxDim: 1400, quality: 0.75 },
      { maxDim: 1150, quality: 0.68 },
    ],
  },
  paddle: {
    id: "paddle",
    label: "Model 2",
    sub: "PaddleOCR",
    Icon: Laptop,
    // One page at a time: the local server holds one model in memory and answers fastest
    // when it is not fighting itself for CPU.
    concurrency: 1,
    tileConcurrency: 1,
    analyzeConcurrency: 4,
    // ONE retry, not three. The local server already retries internally, and each attempt
    // can burn the full PADDLE_OCR_MAX_WAIT_MS (240s) — four attempts meant a failing page
    // took ~16 MINUTES to report anything at all.
    tries: 1,
    tiles: true,
    sizes: [
      { maxDim: 1600, quality: 0.82 },
      { maxDim: 1400, quality: 0.75 },
      { maxDim: 1150, quality: 0.68 },
    ],
  },
};

const ENGINE_ORDER = ["openai", "paddle"];
/** Fallback when the server has not answered yet — Model 1, matching lib/ocrEngine.js. */
const FALLBACK_ENGINE = "openai";
const engineMeta = (id) => ENGINE_META[id] || ENGINE_META.paddle;


export default function Studio() {
  const router = useRouter();
  const { user, profile, loading: authLoading, mergeProfile } = useAuth();
  const [payOpen, setPayOpen] = useState(false);
  const [pageLimit, setPageLimit] = useState(null); // { pages, allowed } when a PDF exceeds the plan cap
  const inputRef = useRef(null);
  const regionsRef = useRef([]);

  const [mode, setMode] = useState("pipeline");
  const [file, setFile] = useState(null);
  const [pages, setPages] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | scanning | preview
  const [items, setItems] = useState(null);
  const [slides, setSlides] = useState(null);
  const [docId, setDocId] = useState(null);
  const [error, setError] = useState("");
  const [prog, setProg] = useState(null);

  // Which OCR engine this scan uses. Remembered per browser so a user who prefers
  // one does not have to re-pick it on every visit.
  const [engine, setEngine] = useState(FALLBACK_ENGINE);
  const [engineInfo, setEngineInfo] = useState(null); // { default, engines:[{id,label,configured,free}] }
  const [notesBusy, setNotesBusy] = useState(false);
  // Remembers what has already been written for this document, so "Open" never fires a
  // second concurrent write of a payload the pipeline just saved.
  const savedRef = useRef(null);
  const engineRef = useRef(FALLBACK_ENGINE);
  engineRef.current = engine;

  // Restore the saved choice, then ask the server which engines are actually
  // configured. A stored engine that the server cannot run is dropped rather than
  // left to fail on the first page.
  useEffect(() => {
    let alive = true;
    let saved = "";
    try { saved = window.localStorage.getItem(ENGINE_STORAGE_KEY) || ""; } catch {}
    if (saved && ENGINE_ORDER.includes(saved)) setEngine(saved);

    (async () => {
      try {
        // Cheap call: which engines are configured. No network to the local server.
        const res = await fetch("/api/ocr", { cache: "no-store" });
        const data = await res.json();
        if (!alive || !data?.engines) return;
        setEngineInfo(data);
        const ready = data.engines.filter((e) => e.configured).map((e) => e.id);
        if (!ready.length) return;
        const wanted = saved && ENGINE_ORDER.includes(saved) ? saved : data.default;
        setEngine(ready.includes(wanted) ? wanted : ready[0]);
      } catch { /* health check is advisory — the toggle still works without it */ }
    })();

    return () => { alive = false; };
  }, []);

  /* ---------------- "is anything actually happening?" ----------------
   * A scan that shows "Reading page 0/2" and nothing else for five minutes is
   * indistinguishable from a hang. Two cheap signals fix that: a running clock, and —
   * for Model 2 — what its local server says it is doing. */

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (status !== "scanning") { setElapsed(0); return undefined; }
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [status]);

  const [serverNote, setServerNote] = useState("");
  useEffect(() => {
    if (status !== "scanning" || engine !== "paddle") { setServerNote(""); return undefined; }
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch("/api/ocr?live=1", { cache: "no-store" });
        const data = await res.json();
        if (!alive) return;
        const srv = data?.paddle?.reachable?.server;
        if (!data?.paddle?.reachable?.reachable) {
          setServerNote("Model 2's server stopped responding — check its window.");
        } else if (srv?.structureError) {
          // The most common one is a failed model download, which never resolves on
          // its own. Saying so beats letting the scan run out its retry budget.
          setServerNote(`Model 2 can't load its models: ${String(srv.structureError).slice(0, 160)}`);
        } else if (srv && srv.warm === false) {
          setServerNote("Model 2 is loading its models. The first run downloads about 1 GB — this happens once.");
        } else if (srv?.degraded) {
          setServerNote("Model 2 is running in reduced mode (no layout, formulas or tables).");
        } else {
          setServerNote("");
        }
      } catch { /* advisory only */ }
    };
    check();
    const t = setInterval(check, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [status, engine]);

  const fmtElapsed = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

  const pickEngine = (id) => {
    setEngine(id);
    try { window.localStorage.setItem(ENGINE_STORAGE_KEY, id); } catch {}
  };

  const engineReady = (id) => {
    const found = engineInfo?.engines?.find((e) => e.id === id);
    return found ? found.configured : true; // unknown yet — don't grey it out
  };

  // PaddleOCR is configured but nothing is listening — almost always "the local
  // server isn't running". Worth saying BEFORE a scan burns 3 seconds failing,
  // and worth saying in the words that name the actual fix.
  const paddleOffline =
    engineReady("paddle") && engineInfo?.paddle?.reachable?.checked === true &&
    engineInfo.paddle.reachable.reachable === false;

  // Re-check liveness — used after the user says they've started the server.
  // ?live=1 pings Model 2's local server. Only ever called while the user is on Model 2.
  const recheckEngines = async () => {
    try {
      const res = await fetch("/api/ocr?live=1", { cache: "no-store" });
      const data = await res.json();
      if (data?.engines) setEngineInfo(data);
    } catch {}
  };

  // Selecting Model 2 is what earns the liveness check — not merely opening the Studio.
  useEffect(() => {
    if (engine !== "paddle") return;
    recheckEngines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const reset = () => {
    setFile(null); setPages([]); setStatus("idle"); setItems(null); setSlides(null); setDocId(null); setError("");
    regionsRef.current = [];
  };

  // Upload size, per attempt. A PDF page is rasterised at scale 2.4 (~1700x2400) and the old
  // code then RE-encoded it at 2048px / q0.95 — which INFLATES a q0.90 source into a 2-3 MB
  // JPEG, ~3-4 MB once base64'd. That upload is what was stalling and timing out, not the OCR.
  // 1600px is ~190 DPI for A4, which is comfortably above what PaddleOCR-VL uses internally,
  // and it cuts the payload roughly 6x. Each retry shrinks further, so a marginal connection
  // still gets a page through.
  // Upload size, per attempt (per engine — see ENGINE_META). A PDF page is
  // rasterised at scale 2.4 (~1700x2400) and re-encoding it at 2048px / q0.95
  // INFLATES a q0.90 source into a 2-3 MB JPEG, ~3-4 MB once base64'd — that
  // upload is what used to stall, not the OCR. Each retry shrinks further, so a
  // marginal connection still gets a page through.

  // OCR a single page with retries (handles transient rate-limits / timeouts on big jobs).
  const ocrImage = async (image, tries = null, engineId = engineRef.current) => {
    const meta = engineMeta(engineId);
    const sizes = meta.sizes;
    if (tries == null) tries = meta.tries ?? 2;
    let lastErr;
    for (let attempt = 0; attempt <= tries; attempt++) {
      const size = sizes[Math.min(attempt, sizes.length - 1)];
      const small = await downscaleDataUrl(image, size.maxDim, size.quality);
      try {
        const res = await fetch("/api/ocr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: small, engine: engineId }) });
        let data = {};
        try { data = await res.json(); } catch {}
        if (res.ok && data.ok) return { title: data.title, sections: data.sections || [] };
        lastErr = new Error(data.error || data.detail || `OCR failed (HTTP ${res.status})`);
        // Config / bad-request errors won't fix themselves on retry — stop immediately so the real reason surfaces.
        const cfg = res.status === 400 || res.status === 401 || /not configured|api key|invalid|quota|billing/i.test(data.error || data.detail || "");
        if (cfg) break;
      } catch (e) { lastErr = e; }
      // Backoff between attempts. The server already backs off internally on a busy queue,
      // so these waits are about giving the upstream real breathing room, not milliseconds.
      if (attempt < tries) await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
    }
    throw lastErr || new Error("OCR failed");
  };

  // Run an async fn over items with a max concurrency (avoids hammering the OCR API on big PDFs).
  async function mapLimit(arr, limit, fn) {
    const out = new Array(arr.length);
    let i = 0;
    const work = async () => { while (i < arr.length) { const idx = i++; out[idx] = await fn(arr[idx], idx); } };
    await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, work));
    return out;
  }

  // Single place that decides whether a page count is allowed for this profile.
  // Returns null when OK, or { pages, allowed } when it should be blocked.
  const checkPageLimit = (count) => {
    const allowed = maxPagesFor(profile);
    return count > allowed ? { pages: count, allowed } : null;
  };

  // Runs the first two steps (OCR -> split) on the given page images, then shows preview.
  // Built to survive heavy multi-page PDFs: bounded concurrency, per-page retry,
  // tolerant of a failed page, and chunked analysis so long papers aren't truncated.
  const runPipelineOn = async (imgs, id, name) => {
    if (!imgs?.length) return;

    // Re-check here too — this function is also called by the "Try scan again" button,
    // which must never bypass the cap.
    const over = checkPageLimit(imgs.length);
    if (over) {
      setPageLimit(over);
      setStatus("idle");
      return;
    }

    setError(""); setStatus("scanning"); setProg({ done: 0, total: imgs.length });
    try {
      // Read each page as ONE whole image first (best for normal single-column pages).
      // Only if a page clearly came back thin do we retry it as column tiles — this avoids
      // slicing single-column questions in half (which drops options and duplicates fragments).
      const failed = new Set();
      let firstErr = null;
      let done = 0;
      const total = imgs.length;
      setProg({ done: 0, total });

      // OCR concurrency is 1 on purpose. PaddleOCR's hosted tier limits how many jobs can be
      // queued at once and answers "submission queue is full" when several pages are submitted
      // together — which the server can only partly absorb, since on Vercel parallel requests can
      // land on different instances. One page at a time is slightly slower but reliable.
      const eng = engineRef.current;
      const meta = engineMeta(eng);
      const pageResults = await mapLimit(imgs.map((img, i) => ({ img, i })), meta.concurrency, async ({ img, i }) => {
        let sections = [];
        let title = "";
        try {
          const whole = await ocrImage(img, null, eng);
          title = whole.title || "";
          sections = whole.sections || [];
        } catch (e) { if (!firstErr) firstErr = e; }

        // Fallback: if the whole-page read looks incomplete, try 2 column tiles (in parallel) and
        // keep whichever is richer.
        if (meta.tiles && sections.length && looksThin(sections)) {
          try {
            const tiles = await tilePageImage(img, 2, 0.08);
            const tileResults = await mapLimit(tiles, meta.tileConcurrency, async (t) => {   // same queue limit as above
              try { const r = await ocrImage(t, 1, eng); return r.sections || []; } catch { return []; }
            });
            const tileSecs = tileResults.flat();
            const merged = dedupeSections(tileSecs);
            // prefer tiles only if they genuinely recovered more complete questions
            if (totalOptionCount(merged) > totalOptionCount(sections)) sections = merged;
          } catch {}
        }
        if (!sections.length) failed.add(i + 1);
        done += 1; setProg({ done, total });
        return { i, title, sections };
      });

      const good = pageResults.filter((x) => x.sections.length).sort((a, b) => a.i - b.i);
      if (!good.length) throw new Error(firstErr ? `Scan failed: ${firstErr.message}` : "Couldn't read any page. Please try a clearer scan.");

      const title = good[0]?.title || name || "Document";
      let sections = [];
      good.forEach((x) => { sections = sections.concat(x.sections); });
      sections = dedupeSections(sections);
      const failedArr = [...failed];
      if (user && id) touchDocument(user.uid, id, { status: "extracted" });

      // Chunk the splitter so very long papers don't hit the output-token ceiling, and run the
      // chunks concurrently instead of one-at-a-time — a 40-page paper can produce 6-8 chunks,
      // and running those in sequence added a second, separate multi-minute wait after OCR was
      // already done. mapLimit keeps them in original order via the indexed output array.
      setStatus("scanning"); setProg(null);
      const SEC_BATCH = 14;
      const chunks = [];
      for (let s = 0; s < sections.length; s += SEC_BATCH) chunks.push(sections.slice(s, s + SEC_BATCH));

      let analyzeErr = null;
      // /api/analyze is local JavaScript now (no upstream service), so this stays parallel.
      const chunkResults = await mapLimit(chunks, meta.analyzeConcurrency, async (chunk) => {
        try {
          const res = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, sections: chunk, engine: eng }) });
          let data = {};
          try { data = await res.json(); } catch {}
          if (res.ok && data.ok) return data.items || [];
          if (!analyzeErr) analyzeErr = data.error || data.detail || `HTTP ${res.status}`;
          return [];
        } catch (e) {
          if (!analyzeErr) analyzeErr = e.message || String(e);
          return [];
        }
      });
      const its = chunkResults.flat();
      if (!its.length) throw new Error(analyzeErr ? `Couldn't structure the content: ${analyzeErr}` : "Couldn't structure the content. Please try again.");

      const slideCheck = canCreateSlides(profile, its.length);
      if (!slideCheck.ok) {
        setError(`This document would create ${its.length} slides, which exceeds your plan limit of ${slideCheck.maxSlidesPerDoc} slides per document. Upgrade your plan to continue.`);
        setPayOpen(true);
        setStatus("idle");
        return;
      }

      const sl = await buildFittedSlides(its);
      setItems(its); setSlides(sl); setStatus("preview");
      // Count this successfully-processed document against the user's allowance (free tier = 2).
      if (user) { const cr = await consume(user.uid, profile, "doc"); if (cr.ok) mergeProfile(cr.patch); }
      if (failedArr.length) setError(`Note: ${failedArr.length} page(s) had a section that couldn't be read clearly (page ${failedArr.join(", ")}).`);
      // AWAITED on purpose. This used to be fire-and-forget, which meant it was still
      // writing chunks when "Open as Slides" fired a second write into the same document.
      // Two interleaved chunk streams produced unparseable JSON and the document could
      // never be opened again. Awaiting also means a real failure is shown, not logged.
      if (user && id) {
        try {
          await updateDocument(user.uid, id, { name: title, status: "generated", slides: sl, format: "slides" });
          savedRef.current = { docId: id, format: "slides" };
        } catch (e) {
          console.error("[SlideBaba] could not store generated slides:", e);
          setError(`Your slides were created but could not be saved: ${e?.message || e}. They are still open here — download them before leaving this page.`);
        }
      }
    } catch (e) {
      setError(e.message || "Pipeline failed."); setStatus("idle");
    } finally {
      setProg(null);
    }
  };

  const onPick = async (f) => {
    if (!f) return;
    if (!user) { router.push("/register"); return; }
    // Don't let an upload start while the profile is still loading — otherwise the
    // plan reads as "free" and everyone gets capped at 25 pages.
    if (authLoading || !profile) { setError("Still loading your plan — try again in a second."); return; }
    if (remaining(profile).docsLeft <= 0) { setPayOpen(true); return; }
    setError(""); setItems(null); setSlides(null); setFile(f); setStatus("loading");

    try {
      let imgs = [];

      if (f.type.startsWith("image/")) {
        imgs = [await fileToDataUrl(f)];
      } else if (f.type === "application/pdf") {
        imgs = await pdfToPageImages(f);
      } else {
        setError("Unsupported file. Upload a PDF or image.");
        setFile(null); setStatus("idle");
        return;
      }

      // Hard page-count gate (per plan) BEFORE any Firestore write or OCR call,
      // so we never create a document record or pay to scan pages we won't use.
      const over = checkPageLimit(imgs.length);
      if (over) {
        setPageLimit(over);
        setFile(null); setPages([]); setDocId(null); setStatus("idle");
        if (inputRef.current) inputRef.current.value = ""; // allow re-picking the same file
        return;
      }

      setPages(imgs);

      let id = null;
      // A failed create used to leave id === null, which silently skipped every later save
      // — the purest form of "my documents were never saved". Now it is reported.
      const ref = await saveDocument(user.uid, { name: f.name, status: "processing", mode, engine })
        .catch((e) => { console.error("[SlideBaba] could not create the document:", e); return null; });
      id = ref?.id || null;
      setDocId(id);
      if (!id) setError("Heads up: this document could not be created in your account, so it won't appear in My Documents. Your scan will still run — download the result before leaving.");

      // Pipeline mode: auto-run the scan + split immediately. Snippet mode waits for boxes.
      if (mode === "pipeline") {
        await runPipelineOn(imgs, id, f.name);
      } else {
        setStatus("idle");
      }
    } catch (e) {
      setError("Couldn't read that file. Make sure it's a valid PDF or image. (" + (e?.message || "error") + ")");
      setFile(null); setPages([]); setStatus("idle");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const extractSnippets = async () => {
    const regions = regionsRef.current;
    if (!regions.length) { setError("Draw at least one box around a question first."); return; }
    setError(""); setStatus("scanning");
    try {
      const its = await Promise.all(
        regions.map(async (r, i) => {
          const src = pages[r.page];
          const { width, height } = await imageSize(src);
          const cropped = await cropImage(src, { x: r.fx * width, y: r.fy * height, w: r.fw * width, h: r.fh * height });
          const ocr = await ocrImage(cropped, null, engineRef.current);
          const text = ocr.sections.map((s) => `${s.heading ? s.heading + " " : ""}${s.body}`).join("\n").trim();
          return { title: `Snippet ${i + 1}`, text: text || ocr.title || "" };
        })
      );

      const slideCheck = canCreateSlides(profile, its.length);
      if (!slideCheck.ok) {
        setError(`This selection would create ${its.length} slides, which exceeds your plan limit of ${slideCheck.maxSlidesPerDoc} slides per document. Upgrade your plan to continue.`);
        setPayOpen(true);
        setStatus("idle");
        return;
      }

      if (user) {
        const cr = await consume(user.uid, profile, "snip");
        if (!cr.ok) { if (cr.reason === "limit") { setPayOpen(true); } else { setError("Couldn't update your credits — try again."); } setStatus("idle"); return; }
        mergeProfile(cr.patch);
      }

      const sl = await buildFittedSlides(its);
      setItems(its); setSlides(sl); setStatus("preview");
      if (user && docId) updateDocument(user.uid, docId, { status: "generated", slides: sl, format: "slides" }).catch((e) => console.error("[SlideBaba] could not store generated slides:", e));
    } catch (e) {
      setError(e.message || "Snippet extraction failed."); setStatus("idle");
    }
  };

  // Opening no longer re-saves. runPipelineOn already stored this exact deck, and a second
  // concurrent chunk write into the same document is what corrupted documents beyond
  // recovery. The editor's own autosave owns every change from here on.
  const openSlides = async () => {
    if (!slides) return;
    const t = file?.name || "Untitled";
    try {
      if (user && docId && savedRef.current?.docId !== docId) {
        await updateDocument(user.uid, docId, { name: t, status: "generated", slides, format: "slides" });
        savedRef.current = { docId, format: "slides" };
      }
    } catch (e) {
      setError(`Couldn't save before opening: ${e?.message || e}`);
      return;
    }
    saveHandoff({ title: t, format: "slides", slides, docId });
    router.push("/editor");
  };

  // Notes used to persist NOTHING here — touchDocument wrote only `format: "notes"`, and
  // the items lived solely in the in-memory handoff. If the user closed the tab before the
  // notes editor's 1.5s debounced autosave fired, the document existed in "My Documents"
  // with zero content and reopened blank. This awaits a real write of the notes payload.
  const openNotes = async () => {
    if (!items) return;
    const t = file?.name || "Untitled Notes";
    setNotesBusy(true);
    try {
      if (user && docId) {
        await updateDocument(user.uid, docId, {
          name: t,
          status: "generated",
          format: "notes",
          items,
        });
        savedRef.current = { docId, format: "notes" };
      }
    } catch (e) {
      setNotesBusy(false);
      setError(`Couldn't save your notes: ${e?.message || e}`);
      return;
    }
    setNotesBusy(false);
    saveHandoff({ title: t, format: "notes", items, docId });
    router.push("/notes");
  };

  const onRegions = useCallback((r) => { regionsRef.current = r; }, []);
  const busy = status === "scanning" || status === "loading";

  const hasSlidePreview = Boolean(slides && slides.length);
  const previewEntries = hasSlidePreview
    ? slides.map((sl, idx) => {
        const textItems = (sl.elements || []).filter((el) => el.type === "text" || !el.type).map((el) => String(el.content || "").trim());
        return { title: textItems[0] || `Slide ${idx + 1}`, text: textItems.slice(1).join("\n\n") };
      })
    : items;
  const previewLabel = hasSlidePreview ? "Rendered slide preview" : "OCR preview";

  const steps = [
    { t: "Upload Complete", d: file ? file.name : "Awaiting file…", done: !!file, active: status === "loading" },
    { t: "OCR Scanning", d: `Reading text & formulas with ${engineMeta(engine).label}…`, done: status === "preview", active: status === "scanning" },
    { t: "Splitting by question", d: "One question per slide…", done: status === "preview", active: false },
  ];

  return (
    <div className="space-y-5">
      {/* mode toggle */}
      <div className="mx-auto flex w-fit items-center gap-1 rounded-2xl bg-ink-800/80 p-1.5 ring-1 ring-inset ring-white/10">
        <button onClick={() => { setMode("pipeline"); reset(); }} className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition ${mode === "pipeline" ? "bg-gradient-to-r from-emerald-500 to-cyan-500 text-white shadow-soft" : "text-slate-400 hover:text-white"}`}>
          <Cpu className="h-4 w-4" /> SlideBaba Pipeline
        </button>
        <button onClick={() => { setMode("snippet"); reset(); }} className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition ${mode === "snippet" ? "bg-gradient-to-r from-emerald-500 to-cyan-500 text-white shadow-soft" : "text-slate-400 hover:text-white"}`}>
          <Scissors className="h-4 w-4" /> Snippet Extractor
        </button>
      </div>

      {/* OCR engine picker. Both models feed the same structurer server-side, so the
          choice changes who reads the page and nothing else about the result. */}
      {status !== "preview" && (
      <div className="mx-auto w-fit">
        <div className="flex items-center gap-1 rounded-2xl bg-ink-800/80 p-1.5 ring-1 ring-inset ring-white/10">
          {ENGINE_ORDER.map((id) => {
            const m = engineMeta(id);
            const active = engine === id;
            const ready = engineReady(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => ready && !busy && pickEngine(id)}
                disabled={busy || !ready}
                aria-pressed={active}
                title={ready ? m.sub : `${m.sub} is not set up on the server yet`}
                className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition disabled:cursor-not-allowed ${
                  active
                    ? "bg-gradient-to-r from-emerald-500 to-cyan-500 text-white shadow-soft"
                    : "text-slate-400 hover:text-white"
                } ${!ready ? "opacity-40" : ""}`}
              >
                <m.Icon className="h-4 w-4" /> {m.label}
              </button>
            );
          })}
        </div>

        {engine === "paddle" && paddleOffline && (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2 rounded-xl bg-accent-600/15 px-3 py-2 text-[11.5px] leading-snug text-accent-300 ring-1 ring-inset ring-accent-500/30">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>Model 2 server isn&apos;t running — start <code className="rounded bg-black/25 px-1">start-paddleocr.bat</code>.</span>
            <button type="button" onClick={recheckEngines} className="rounded-lg bg-white/10 px-2.5 py-1 font-bold text-white transition hover:bg-white/20">
              Check again
            </button>
          </div>
        )}
      </div>
      )}

      <input ref={inputRef} type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => onPick(e.target.files?.[0])} />
      {error && <div className="rounded-xl bg-accent-600/15 px-4 py-3 text-sm text-accent-300 ring-1 ring-inset ring-accent-500/30">{error}</div>}

      {status === "preview" && previewEntries ? (
        /* ---------- PREVIEW: single white page ---------- */
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg font-bold text-white">{previewLabel} — {previewEntries.length} item{previewEntries.length !== 1 ? "s" : ""}</h2>
            <div className="flex flex-wrap gap-2">
              <button onClick={reset} className="btn-ghost">Start over</button>
              <button onClick={openNotes} disabled={notesBusy} className="btn bg-ink-700 text-white hover:bg-ink-600 disabled:opacity-60"><FileText className="h-4 w-4" /> {notesBusy ? "Saving…" : "Open as A4 Notes"}</button>
              <button onClick={openSlides} disabled={notesBusy} className="btn-primary disabled:opacity-60"><Presentation className="h-4 w-4" /> Open as Slides <ArrowRight className="h-4 w-4" /></button>
            </div>
          </div>

          <div className="mx-auto max-w-3xl rounded-2xl bg-white p-8 text-ink-900 shadow-card ring-1 ring-black/10 sm:p-12">
            {previewEntries.map((it, i) => (
              <div key={i} className={i ? "mt-7 border-t border-slate-200 pt-7" : ""}>
                <p className="mb-1.5 text-sm font-extrabold text-brand-700">{it.title || `Item ${i + 1}`}</p>
                <div className="kx whitespace-pre-wrap text-[15px] leading-relaxed text-slate-800" dangerouslySetInnerHTML={{ __html: renderMixed(it.text || "") }} />
              </div>
            ))}
          </div>
          <p className="text-center text-xs text-slate-500">This preview is generated from the same slide content used for downloads.</p>
        </div>
      ) : mode === "pipeline" ? (
        /* ---------- PIPELINE: two-panel layout, auto-runs on upload ---------- */
        <div className="grid gap-5 lg:grid-cols-2">
          {/* LEFT: upload + steps */}
          <div className="min-w-0 space-y-5">
            <button onClick={() => inputRef.current?.click()} disabled={busy} className="grid min-h-[320px] w-full place-items-center rounded-3xl border-2 border-dashed border-white/15 bg-ink-850/40 p-8 text-center transition hover:border-emerald-400/50 hover:bg-ink-850 disabled:cursor-not-allowed disabled:opacity-70">
              {file && pages.length ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={pages[0]} alt="doc" className="max-h-40 max-w-full rounded-xl object-contain shadow-soft" />
                  <p className="mt-4 max-w-xs truncate font-display text-lg font-bold text-white">{file.name}</p>
                  <p className="mt-1 text-sm text-slate-500">{busy ? "Working…" : "Tap to choose another file"}</p>
                </>
              ) : (
                <>
                  <span className="grid h-16 w-16 place-items-center rounded-2xl bg-sky-500/15 text-sky-300 shadow-soft"><FileUp className="h-8 w-8" /></span>
                  <p className="mt-4 font-display text-2xl font-extrabold text-white">Upload Document</p>
                  <p className="mt-1 text-sm text-slate-500">PDF, JPG, PNG — up to {maxPagesFor(profile)} pages on your plan</p>
                </>
              )}
            </button>

            <div className="rounded-3xl bg-ink-850/70 p-5 ring-1 ring-white/10">
              <h3 className="flex items-center gap-2 font-display text-base font-bold text-white"><Cpu className="h-4 w-4 text-brand-400" /> SlideBaba Pipeline</h3>
              <div className="mt-4 space-y-2.5">
                {steps.map((s) => (
                  <div key={s.t} className="flex items-center gap-3 rounded-2xl bg-ink-800/60 p-3.5 ring-1 ring-inset ring-white/5">
                    {s.done ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" /> : s.active ? <Loader2 className="h-5 w-5 shrink-0 animate-spin text-emerald-400" /> : <Circle className="h-5 w-5 shrink-0 text-slate-600" />}
                    <div className="min-w-0"><p className="text-sm font-bold text-white">{s.t}</p><p className="truncate text-xs text-slate-500">{s.d}</p></div>
                  </div>
                ))}
              </div>
              {busy ? (
                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-center gap-2 rounded-xl bg-ink-800/60 px-4 py-3 text-sm font-semibold text-emerald-300 ring-1 ring-inset ring-white/5">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {status === "loading" ? "Reading file…" : "Scanning & building…"}
                    {status === "scanning" && <span className="tabular-nums text-slate-400">{fmtElapsed(elapsed)}</span>}
                  </div>
                  {serverNote && (
                    <p className="rounded-xl bg-sky-500/10 px-3 py-2.5 text-[11.5px] leading-snug text-sky-200 ring-1 ring-inset ring-sky-400/25">{serverNote}</p>
                  )}
                  {status === "scanning" && elapsed > 90 && engine === "openai" && (
                    <p className="rounded-xl bg-ink-800/60 px-3 py-2.5 text-[11.5px] leading-snug text-slate-400 ring-1 ring-inset ring-white/5">
                      Dense pages with a lot of formulas take a while — Model 1 writes out every
                      equation as LaTeX, and that is a long answer per page.
                    </p>
                  )}
                </div>
              ) : error && pages.length ? (
                <button onClick={() => runPipelineOn(pages, docId, file?.name)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-4 py-3 text-sm font-bold text-white shadow-soft transition hover:brightness-110">
                  <RefreshCw className="h-4 w-4" /> Try scan again
                </button>
              ) : (
                <p className="mt-4 text-center text-xs text-slate-500">Drop a file above and the first two steps run on their own.</p>
              )}
            </div>
          </div>

          {/* RIGHT: document scan */}
          <div className="min-w-0 rounded-3xl bg-ink-850/40 p-5 ring-1 ring-white/10">
            <h3 className="mb-4 flex items-center gap-2 text-sm font-extrabold uppercase tracking-widest text-white"><Crosshair className="h-4 w-4 text-brand-400" /> Document Scan</h3>
            <div className="relative grid min-h-[360px] place-items-center overflow-hidden rounded-2xl border-2 border-dashed border-white/10 bg-ink-900/40 p-3">
              {status === "loading" && !pages.length ? (
                <div className="flex items-center gap-2 text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /> Rendering file…</div>
              ) : pages.length ? (
                <div className="relative w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={pages[0]} alt="scan" className={`mx-auto block max-h-[420px] w-full max-w-full rounded-lg object-contain transition ${status === "scanning" ? "" : "opacity-90"}`} />
                  {status === "scanning" && <div className="scan-overlay"><div className="scan-line" /></div>}
                  {status === "scanning" && prog && (
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink-950/80 px-3 py-1 text-xs font-semibold text-brand-100 ring-1 ring-inset ring-brand-500/40">
                      Reading page {prog.done}/{prog.total}…
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center text-slate-600">
                  <Scan className="h-12 w-12" strokeWidth={1.5} />
                  <p className="mt-4 text-xs font-bold uppercase tracking-[0.3em] text-slate-600">Full Document Scan</p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* ---------- SNIPPET ---------- */
        <div className="space-y-5">
          <div className="card flex min-w-0 flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-500/15 text-brand-300 ring-1 ring-inset ring-brand-500/30"><Scissors className="h-5 w-5" /></span>
              <div>
                <h2 className="font-display text-base font-bold text-white">Snippet Extractor</h2>
                <p className="text-sm text-slate-400">Upload, draw boxes around each question, then extract.</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => inputRef.current?.click()} className="btn bg-sky-600 text-white hover:bg-sky-500"><Upload className="h-4 w-4" /> Upload File</button>
              <button onClick={extractSnippets} disabled={!pages.length || busy} className="btn bg-emerald-600 text-white hover:bg-emerald-500">{status === "scanning" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />} Extract</button>
              <button onClick={reset} className="btn bg-accent-600/90 text-white hover:bg-accent-600"><Trash2 className="h-4 w-4" /> Clear All</button>
            </div>
          </div>

          {status === "loading" ? (
            <div className="grid min-h-[300px] place-items-center rounded-2xl bg-ink-850 text-slate-400 ring-1 ring-white/10"><Loader2 className="h-6 w-6 animate-spin" /><span className="ml-2">Rendering PDF…</span></div>
          ) : !pages.length ? (
            <button onClick={() => inputRef.current?.click()} className="grid min-h-[380px] w-full place-items-center rounded-2xl border-2 border-dashed border-white/15 bg-ink-850/40 text-center transition hover:border-brand-500/50">
              <span className="grid h-16 w-16 place-items-center rounded-2xl bg-sky-500/10 text-sky-300"><FileUp className="h-8 w-8" /></span>
              <p className="mt-4 font-display text-xl font-bold text-white">No Document Loaded</p>
              <p className="mt-1 text-sm text-slate-500">Upload a PDF or Image to get started (max {maxPagesFor(profile)} pages).</p>
            </button>
          ) : (
            <div className="relative">
              <RegionSelector pages={pages} onChange={onRegions} />
              {status === "scanning" && (
                <div className="absolute inset-0 grid place-items-center rounded-2xl bg-ink-950/60 backdrop-blur-sm">
                  <div className="rounded-xl bg-brand-500/20 px-4 py-2 text-sm font-semibold text-brand-100 ring-1 ring-inset ring-brand-500/40"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Extracting your snippets…</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <PlanModal open={payOpen} onClose={() => setPayOpen(false)} profile={profile} uid={user?.uid} onApplied={(patch) => { mergeProfile(patch); setPayOpen(false); }} />

      {pageLimit && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-ink-950/70 p-4 backdrop-blur-sm" onMouseDown={() => setPageLimit(null)}>
          <div className="w-full max-w-md rounded-2xl bg-ink-900 p-6 text-center ring-1 ring-white/10 shadow-glow" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-rose-500 to-orange-500 text-white shadow-soft">
              <FileText className="h-7 w-7" />
            </div>
            <h3 className="mt-4 font-display text-xl font-extrabold text-white">PDF is above your page limit</h3>
            <p className="mt-2 text-sm text-slate-400">
              This PDF has <b className="text-white">{pageLimit.pages} pages</b>, but your <b className="text-white capitalize">{profile?.plan || "free"}</b> plan allows up to <b className="text-white">{pageLimit.allowed} pages</b> per document. Please upload a PDF under {pageLimit.allowed} pages.
            </p>
            <p className="mt-1 text-xs text-slate-500">Nothing was scanned and no credits were used. Upgrade for a higher page limit, or split the PDF and try again.</p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <button onClick={() => { setPageLimit(null); setPayOpen(true); }} className="flex-1 rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-bold text-white hover:brightness-110">Upgrade plan</button>
              <button onClick={() => setPageLimit(null)} className="flex-1 rounded-xl bg-ink-800 px-4 py-2.5 text-sm font-bold text-slate-200 ring-1 ring-inset ring-white/10 hover:text-white">Close</button>
            </div>
            <p className="mt-4 text-[11px] text-slate-600">
              {Object.entries(PLANS).map(([k, p]) => `${p.label} ${p.maxPages.m}`).join(" · ")} pages per document
            </p>
          </div>
        </div>
      )}
    </div>
  );
}