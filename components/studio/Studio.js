"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Cpu, Scissors, Loader2, Trash2, CheckCircle2, Circle,
  ArrowRight, FileUp, Crosshair, Scan, RefreshCw, FileText, Presentation,
  Laptop, Bot, AlertTriangle, Target, Zap,
} from "lucide-react";
import { renderMixed } from "@/components/Katex";
import RegionSelector from "@/components/studio/RegionSelector";
import { useAuth } from "@/context/AuthContext";
import { saveHandoff } from "@/lib/slideStore";
import { buildFittedSlides } from "@/lib/slideLayout";
import { saveDocument, updateDocument, touchDocument } from "@/lib/docs";
import { checkDocumentLimits, consume, remaining, maxPagesFor, maxSlidesFor, PLANS } from "@/lib/plan";
import PlanModal from "@/components/subscription/PlanModal";
import {
  openPdf, pdfToPageImages, fileToDataUrl, imageSize, cropImage, downscaleDataUrl,
  tilePageImage, sliceForAccuracy, analyzePageLayout, makeThumb,
} from "@/lib/imageCrop";

/* ============================================================================
 * SlideBaba Studio — scan pipeline
 * ============================================================================
 * Two things were wrong here and both are fixed in this file.
 *
 * A) "TRY AGAIN" ON BIG PDFs.  Every page of the PDF was rendered up front and
 *    kept in a React state array as a full-resolution JPEG data URL. Data URLs
 *    are JavaScript strings (2 bytes per character), so a 100-page paper meant
 *    ~160 MB of live strings plus every canvas backing store, held for the whole
 *    scan. Somewhere past 50 pages Chrome starts refusing canvas allocations,
 *    the render throws, everything lands in the catch block and the user sees
 *    "Couldn't read that file… Try again". It was never a plan limit — it just
 *    looked like one, which is exactly why it was reported as one.
 *
 *    Now pages are rendered in a small WINDOW (PAGE_WINDOW at a time), scanned,
 *    and dropped. Peak memory is a handful of pages whether the PDF is 5 pages
 *    or 200, so the page allowance on the plan is the only thing that can stop a
 *    scan. The plan gate also runs BEFORE any rendering, using the PDF's own page
 *    count, so an over-limit file costs nothing at all.
 *
 * B) ACCURACY.  Model 1 read each page as ONE image. A vision model spends a
 *    fixed pixel budget per image, so a whole A4 page leaves a Devanagari matra
 *    one or two pixels tall — which is why "बताइए" came back as "बताइये" and why
 *    options went missing. Every page is now ALSO read as overlapping
 *    high-resolution slices (columns when the page really has two columns, bands
 *    otherwise — decided from the pixels, not from the aspect ratio), and the
 *    slice reading, which sees each glyph at 2–3x the resolution, replaces the
 *    whole-page reading wherever it is more complete. The whole-page pass stays
 *    as the spine that fixes the reading order.
 * ========================================================================== */

/** Pages rendered, scanned and released as one batch. Peak memory ~ this many pages. */
const PAGE_WINDOW = 8;
/**
 * Long edge of a rendered page, in pixels.
 *
 * 1800, not 2400. This is ~215 DPI for A4, still two and a half times the effective
 * resolution of the old path (which squeezed the page to 768px on its shortest side),
 * but a 2400px image costs roughly 1.8x the image tokens of an 1800px one — paid on
 * EVERY call, and image tokens are what the model has to chew through before it writes
 * its first character. The accuracy difference between 1800 and 2400 is not measurable
 * on printed exam paper; the latency difference is.
 */
const PAGE_MAX_DIM = 1800;
const PAGE_QUALITY = 0.92;

/** Where the scan sits on the speed/accuracy dial. Remembered per browser. */
const ACCURACY_STORAGE_KEY = "slidebaba.accuracy.v1";
/** Snippet mode still shows every page, so it renders smaller and caps the count. */
const SNIPPET_MAX_DIM = 1700;
const SNIPPET_MAX_PAGES = 40;

/* -------------------------------------------------------------------------- */
/* section helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Comparison key for a section: letters and digits only, so punctuation noise cannot split a match. */
const normKey = (t) => String(t || "").replace(/\s+/g, "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
const secKey = (s) => normKey(`${s?.heading || ""}${s?.body || ""}`);
const secWeight = (s) => secKey(s).length;

// Matches an option marker in EITHER script Indian exam papers use: Latin/roman "(A)" "(iii)"
// or Devanagari "(क)" "(अ)" — papers OCR'd correctly in Hindi almost never carry Latin letters,
// so counting only A-D was undercounting (effectively to zero) on every Hindi MCQ page.
const OPTION_RE = /\([A-Da-divxIVX]+\)|\([क-ह]{1,3}\)/g;

/** Count option markers in one section. */
function optionCount(sec) {
  return (String(sec?.body || "").match(OPTION_RE) || []).length;
}

/** Count total multiple-choice options across sections — a good proxy for how complete a read is. */
function totalOptionCount(sections) {
  let n = 0;
  for (const sec of sections || []) n += optionCount(sec);
  return n;
}

/** How many sections show at least one option-like marker — i.e. look like MCQ questions. */
function mcqSectionCount(sections) {
  let n = 0;
  for (const sec of sections || []) {
    OPTION_RE.lastIndex = 0;
    if (OPTION_RE.test(String(sec?.body || ""))) n++;
  }
  return n;
}

/**
 * A whole-page read "looks thin" only when it shows signs of an MCQ page with options
 * actually missing (e.g. (A)(B)(C) found but not (D)). We deliberately do NOT flag a page
 * as thin just because it has zero options overall — plain theory/descriptive questions
 * legitimately have none.
 */
function looksThin(sections) {
  if (!sections || !sections.length) return true;
  const mcq = mcqSectionCount(sections);
  if (!mcq) return false; // no MCQ signal on this page — trust the whole-page read
  const opts = totalOptionCount(sections);
  return opts < mcq * 3; // MCQ sections should show ~4 options each; well under that = suspicious
}

/** Remove near-duplicate sections that appear twice because slices overlap. */
function dedupeSections(sections) {
  const seen = new Set();
  const out = [];
  for (const sec of sections || []) {
    const key = secKey(sec).slice(0, 90);
    if (key.length < 8) { out.push(sec); continue; } // too short to judge — keep
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sec);
  }
  return out;
}

/**
 * Merge the high-resolution SLICE reading into the whole-page reading.
 *
 * The whole-page pass gets the reading order right; the slice pass gets the characters
 * right. So the whole page is the spine, and every slice section either
 *   - replaces its counterpart when it carries strictly more text (and no fewer
 *     options — a "longer" answer that lost an option is not an improvement), or
 *   - is inserted next to its neighbour when the whole-page pass missed it entirely, or
 *   - is dropped when it is just a fragment of something already present (which is what
 *     the seam between two overlapping slices produces).
 */
function mergeSectionSets(base, extra) {
  const out = (base || []).map((s) => ({ ...s }));
  const keys = out.map(secKey);
  let haystack = keys.join("|");

  /**
   * How much of the front of two keys agrees. Matras are already stripped by normKey,
   * so this compares the consonant skeleton — stable across two reads of the same text.
   */
  const sharedPrefix = (a, b) => {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  };

  /**
   * Same question, read twice? A plain "first 28 characters agree" test is not safe on an
   * Indian MCQ paper, where a dozen questions all begin "निम्नलिखित में से कौन सा…" — it
   * would overwrite question 5 with question 7. So the agreement has to cover most of the
   * SHORTER key: a partial read of a question is a prefix of the full read of the same
   * question, while two different questions diverge well before that.
   */
  const findMatch = (k) => {
    if (k.length < 12) return -1;
    let fuzzy = -1;
    for (let i = 0; i < keys.length; i++) {
      const kk = keys[i];
      if (!kk || kk.length < 12) continue;
      if (kk === k) return i;
      if (fuzzy >= 0) continue;
      const shortest = Math.min(kk.length, k.length);
      const need = Math.max(24, Math.floor(shortest * 0.8));
      if (sharedPrefix(kk, k) >= Math.min(need, shortest)) fuzzy = i;
    }
    return fuzzy;
  };

  let lastHit = -1;
  for (const s of extra || []) {
    const k = secKey(s);
    if (k.length < 4) continue;

    const hit = findMatch(k);
    if (hit >= 0) {
      const cur = out[hit];
      if (secWeight(s) > secWeight(cur) * 1.04 && optionCount(s) >= optionCount(cur)) {
        out[hit] = { ...s };
        keys[hit] = k;
        haystack = keys.join("|");
      }
      lastHit = hit;
      continue;
    }

    // Not matched, but already contained in something we have. This is what the overlap
    // between two neighbouring slices produces: the tail of one slice is the head of the
    // next. It is not new content, so it must not become a second section — and it can be
    // a SUFFIX ("(B) 16 (C) 18 (D) 20") as easily as a prefix, so the whole key is probed
    // when it is short rather than only its first characters.
    const probe = k.length > 70 ? k.slice(0, 70) : k;
    if (haystack.includes(probe)) continue;

    const at = lastHit >= 0 ? Math.min(out.length, lastHit + 1) : out.length;
    out.splice(at, 0, { ...s });
    keys.splice(at, 0, k);
    haystack = keys.join("|");
    lastHit = at;
  }
  return out;
}

/* --------------------------------------------------------------------------
 * OCR engines
 *
 * "openai"  ChatGPT vision — hosted, paid per page. DEFAULT.
 * "paddle"  PaddleOCR running on your own machine — free, unlimited, offline.
 *
 * The server routes both through the SAME structurer, so the choice only changes
 * who reads the pixels. Everything after that — question splitting, options,
 * LaTeX, slide layout, export — is identical, which is what makes this a real
 * A/B toggle rather than two different pipelines.
 *
 * The per-engine numbers below are not cosmetic:
 *   slice        read every page again as overlapping high-res slices (Model 1 only —
 *                it is the accuracy fix, and it costs ~2-3 calls per page).
 *   tiles        the older "retry a thin page as column tiles" fallback (Model 2 only —
 *                PaddleOCR is local and slow, so it only re-reads a page that looks wrong).
 *   concurrency  PAGES in flight. Model 1 is 2 because one page is now ~3 API calls.
 *   sizes        upload size per attempt; a slice is already at the right size, so the
 *                first entry must be large enough not to shrink it back down.
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
    // 6 PAGES in flight in Fast mode (see ACCURACY_META below for the Max override).
    // The server gate (OPENAI_CONCURRENCY, now 12) is the real ceiling; this just has
    // to keep it fed. At 2 pages in flight the pipe was never full and every page was
    // effectively waiting its turn.
    concurrency: 6,
    sliceConcurrency: 3,
    analyzeConcurrency: 4,
    // ONE attempt in Fast mode. A retry on a hosted model is 30+ seconds and the
    // failures that retries fix are rare; the ones they do not fix are config errors.
    tries: 1,
    slice: false,
    maxSlices: 2,
    // No column-tile fallback: the slice pass supersedes it and does the job properly.
    tiles: false,
    // The page is rendered at PAGE_MAX_DIM, so the first entry leaves it untouched —
    // no second lossy re-encode. The smaller entries only apply to a retry on a bad connection.
    sizes: [
      { maxDim: 1800, quality: 0.92 },
      { maxDim: 1500, quality: 0.85 },
      { maxDim: 1200, quality: 0.75 },
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
    sliceConcurrency: 1,
    analyzeConcurrency: 4,
    // ONE retry, not three. The local server already retries internally, and each attempt
    // can burn the full PADDLE_OCR_MAX_WAIT_MS (240s) — four attempts meant a failing page
    // took ~16 MINUTES to report anything at all.
    tries: 1,
    // Local and slow: 3 calls per page would be ~12 minutes a page. Model 2 keeps the
    // cheaper "only re-read a page that came back thin" fallback.
    slice: false,
    maxSlices: 2,
    tiles: true,
    sizes: [
      { maxDim: 1600, quality: 0.85 },
      { maxDim: 1400, quality: 0.78 },
      { maxDim: 1150, quality: 0.68 },
    ],
  },
};

const ENGINE_ORDER = ["openai", "paddle"];
/** Fallback when the server has not answered yet — Model 1, matching lib/ocrEngine.js. */
const FALLBACK_ENGINE = "openai";

/* --------------------------------------------------------------------------
 * The speed/accuracy dial
 *
 * "fast" is the default and it is ONE API call per page. That is the honest
 * default: a 100-page scan that finishes in six minutes and is 98% right beats
 * one that is 99.5% right and takes two hours, because nobody waits two hours.
 *
 * "max" adds the high-resolution slice pass — each page read again in 2 (or 3)
 * overlapping pieces so every glyph gets several times more pixels. It is ~3x the
 * calls and ~3x the cost, and it is worth it on a dense Hindi paper where the
 * matras matter. It is one click away, per scan.
 * ------------------------------------------------------------------------ */
const ACCURACY_META = {
  fast: {
    id: "fast",
    label: "Fast",
    hint: "One read per page",
    slice: false,
    tries: 1,
    // Pages in flight. Each page is 1 call here, so this is also calls in flight.
    concurrency: 6,
  },
  max: {
    id: "max",
    label: "Max accuracy",
    hint: "Each page re-read in high-resolution slices — ~3x slower",
    slice: true,
    tries: 2,
    // Each page is ~3 calls here, so 3 pages keeps ~9 calls moving without
    // overshooting the server gate.
    concurrency: 3,
  },
};
const ACCURACY_ORDER = ["fast", "max"];

const engineMeta = (id) => ENGINE_META[id] || ENGINE_META.openai;

/** Engine settings with the accuracy dial's overrides applied. */
function scanMeta(engineId, accuracyId) {
  const base = engineMeta(engineId);
  // Model 2 is local and slow; 3 calls per page there would be ~12 minutes a page.
  // It keeps its own cheaper behaviour whatever the dial says.
  if (engineId !== "openai") return base;
  const acc = ACCURACY_META[accuracyId] || ACCURACY_META.fast;
  return { ...base, slice: acc.slice, tries: acc.tries, concurrency: acc.concurrency, accuracy: acc.id };
}

/** Run an async fn over items with a max concurrency (avoids hammering the OCR API on big PDFs). */
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  const work = async () => { while (i < arr.length) { const idx = i++; out[idx] = await fn(arr[idx], idx); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, arr.length)) }, work));
  return out;
}

const range = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);

/** "3:07" */
const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.max(0, Math.round(sec % 60))).padStart(2, "0")}`;


export default function Studio() {
  const router = useRouter();
  const { user, profile, loading: authLoading, mergeProfile } = useAuth();
  const [payOpen, setPayOpen] = useState(false);
  // Structured block from checkDocumentLimits() — knows WHICH limit fired.
  const [limitBlock, setLimitBlock] = useState(null);
  const inputRef = useRef(null);
  const regionsRef = useRef([]);

  const [mode, setMode] = useState("pipeline");
  const [file, setFile] = useState(null);
  const [pageCount, setPageCount] = useState(0);
  const [thumb, setThumb] = useState("");         // small preview only — never the full page
  const [pages, setPages] = useState([]);         // snippet mode only
  const [status, setStatus] = useState("idle");   // idle | loading | scanning | preview
  const [items, setItems] = useState(null);
  const [slides, setSlides] = useState(null);
  const [docId, setDocId] = useState(null);
  const [error, setError] = useState("");
  const [prog, setProg] = useState(null);         // { done, total, etaSec }

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

  // Speed/accuracy dial. Fast by default — see ACCURACY_META.
  const [accuracy, setAccuracy] = useState("fast");
  const accuracyRef = useRef("fast");
  accuracyRef.current = accuracy;
  // Which model actually answered, so a slow scan can be diagnosed without the server log.
  const [modelSeen, setModelSeen] = useState("");

  // Set when the user starts over mid-scan, so the in-flight pipeline stops cleanly
  // instead of writing its result over a document the user has already abandoned.
  const runRef = useRef(0);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(ACCURACY_STORAGE_KEY);
      if (saved && ACCURACY_ORDER.includes(saved)) setAccuracy(saved);
    } catch {}
  }, []);

  const pickAccuracy = (id) => {
    setAccuracy(id);
    try { window.localStorage.setItem(ACCURACY_STORAGE_KEY, id); } catch {}
  };

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
   * indistinguishable from a hang. Three cheap signals fix that: a running clock, a
   * live ETA, and — for Model 2 — what its local server says it is doing. */

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (status !== "scanning") { setElapsed(0); return undefined; }
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [status]);

  // A long scan that the user navigates away from is a wasted document credit.
  useEffect(() => {
    if (status !== "scanning" && status !== "loading") return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; return ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
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
    runRef.current += 1;              // abandon anything still in flight
    setFile(null); setPages([]); setPageCount(0); setThumb("");
    setStatus("idle"); setItems(null); setSlides(null); setDocId(null);
    setError(""); setProg(null); setLimitBlock(null);
    regionsRef.current = [];
    savedRef.current = null;
  };

  /* ------------------------------------------------------------------------ */
  /* OCR                                                                       */
  /* ------------------------------------------------------------------------ */

  /**
   * OCR one image with retries (handles transient rate-limits / timeouts on big jobs).
   * `part` tells the server this image is one slice of a page, so the prompt can stop
   * the model inventing the half it cannot see.
   */
  const ocrImage = async (image, tries = null, engineId = engineRef.current, part = null) => {
    const meta = scanMeta(engineId, accuracyRef.current);
    const sizes = meta.sizes;
    if (tries == null) tries = meta.tries ?? 1;
    const fast = accuracyRef.current !== "max";
    let lastErr;
    for (let attempt = 0; attempt <= tries; attempt++) {
      const size = sizes[Math.min(attempt, sizes.length - 1)];
      const small = await downscaleDataUrl(image, size.maxDim, size.quality);
      try {
        const res = await fetch("/api/ocr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: small, engine: engineId, fast, part: part || undefined }),
        });
        let data = {};
        try { data = await res.json(); } catch {}
        if (res.ok && data.ok) {
          if (data.model) setModelSeen(data.model);
          return { title: data.title, sections: data.sections || [] };
        }
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

  /**
   * Read ONE page as accurately as this engine can.
   *
   * Model 1: whole page (reading order) + overlapping high-resolution slices
   * (character accuracy), merged. Model 2: whole page, with the older column-tile
   * retry only when the page comes back looking thin.
   */
  const ocrPage = async (img, engineId) => {
    const meta = scanMeta(engineId, accuracyRef.current);

    let sections = [];
    let title = "";
    let pageErr = null;
    try {
      const whole = await ocrImage(img, null, engineId);
      title = whole.title || "";
      sections = whole.sections || [];
    } catch (e) { pageErr = e; }

    /* ---- Model 1: always-on high-resolution slice pass ---- */
    if (meta.slice) {
      try {
        const layout = await analyzePageLayout(img);
        const slices = await sliceForAccuracy(img, { layout, maxSlices: meta.maxSlices, quality: PAGE_QUALITY });
        if (slices.length) {
          const sliceSecs = await mapLimit(slices, meta.sliceConcurrency, async (s) => {
            try { const r = await ocrImage(s.image, 1, engineId, s.part); return r.sections || []; }
            catch { return []; }
          });
          const enriched = dedupeSections(sliceSecs.flat());
          if (enriched.length) {
            // The whole-page read failed outright: the slices ARE the page.
            sections = sections.length ? mergeSectionSets(sections, enriched) : enriched;
            pageErr = null;
          }
        }
      } catch { /* slicing is an enhancement — never let it fail a page */ }
    }

    /* ---- Model 2: cheaper fallback, only when the page looks incomplete ---- */
    if (meta.tiles && sections.length && looksThin(sections)) {
      try {
        const tiles = await tilePageImage(img, 2, 0.08);
        const tileResults = await mapLimit(tiles, meta.sliceConcurrency, async (t) => {
          try { const r = await ocrImage(t, 1, engineId); return r.sections || []; } catch { return []; }
        });
        const merged = dedupeSections(tileResults.flat());
        // prefer tiles only if they genuinely recovered more complete questions
        if (totalOptionCount(merged) > totalOptionCount(sections)) sections = merged;
      } catch {}
    }

    if (!sections.length && pageErr) throw pageErr;
    return { title, sections };
  };

  /* ------------------------------------------------------------------------ */
  /* page source — the memory fix                                              */
  /* ------------------------------------------------------------------------ */

  /**
   * A uniform "give me page i" handle over either a PDF or a single image.
   *
   * For a PDF nothing is rasterised until it is asked for, and the caller throws each
   * page away as soon as it has been scanned — which is what stops a 200-page document
   * from filling the tab's memory and failing with "Try again".
   */
  const makePageSource = async (f) => {
    if (f.type.startsWith("image/")) {
      const url = await fileToDataUrl(f);
      const sized = await downscaleDataUrl(url, PAGE_MAX_DIM, PAGE_QUALITY);
      return { total: 1, get: async () => sized, destroy: () => {} };
    }
    if (f.type === "application/pdf" || /\.pdf$/i.test(f.name || "")) {
      const doc = await openPdf(f);
      return {
        total: doc.numPages,
        get: (i) => doc.renderPage(i + 1, { maxDim: PAGE_MAX_DIM, quality: PAGE_QUALITY }),
        destroy: () => doc.destroy(),
      };
    }
    throw new Error("Unsupported file. Upload a PDF or an image.");
  };

  /* ------------------------------------------------------------------------ */
  /* the pipeline                                                              */
  /* ------------------------------------------------------------------------ */

  /**
   * Runs OCR -> split on `f`, a window of pages at a time, then shows the preview.
   * Built to survive heavy multi-page PDFs: bounded memory, bounded concurrency,
   * per-page retry, tolerant of a failed page, and chunked analysis so long papers
   * are never truncated.
   */
  const runPipeline = async (f, existingDocId = null) => {
    if (!f) return;
    const runId = ++runRef.current;
    const alive = () => runRef.current === runId;

    const eng = engineRef.current;
    const meta = scanMeta(eng, accuracyRef.current);
    const name = f.name || "Document";

    setError(""); setItems(null); setSlides(null); setStatus("loading"); setProg(null);

    let src = null;
    let id = existingDocId;

    try {
      src = await makePageSource(f);
      const total = src.total;
      if (!alive()) return;
      setPageCount(total);

      // ---- PLAN GATE, before a single page is rendered -----------------------
      // Costs nothing, touches no Firestore document, spends no credit. The PDF's own
      // page count is enough to answer it.
      const gate = checkDocumentLimits(profile, { pages: total });
      if (!gate.ok) {
        setLimitBlock(gate);
        setStatus("idle"); setFile(null); setPageCount(0); setThumb("");
        if (inputRef.current) inputRef.current.value = "";
        return;
      }

      // ---- first page doubles as the on-screen preview -----------------------
      const firstPage = await src.get(0);
      if (!alive()) return;
      setThumb(await makeThumb(firstPage, 620, 0.72));

      // ---- document record ---------------------------------------------------
      if (!id) {
        // A failed create used to leave id === null, which silently skipped every later
        // save — the purest form of "my documents were never saved". Now it is reported.
        const ref = await saveDocument(user.uid, { name, status: "processing", mode, engine: eng, pages: total })
          .catch((e) => { console.error("[SlideBaba] could not create the document:", e); return null; });
        id = ref?.id || null;
        setDocId(id);
        if (!id) setError("Heads up: this document could not be created in your account, so it won't appear in My Documents. Your scan will still run — download the result before leaving.");
      }

      // ---- scan, one window of pages at a time -------------------------------
      setStatus("scanning");
      setProg({ done: 0, total, etaSec: 0 });

      const failed = [];
      const perPage = [];
      let firstErr = null;
      let done = 0;
      const startedAt = Date.now();

      /** Rasterise one window of pages. Page 0 is already in hand. */
      const renderWindow = async (idxs) => {
        const imgs = [];
        for (const i of idxs) {
          if (!alive()) return imgs;
          // eslint-disable-next-line no-await-in-loop
          imgs.push(i === 0 ? firstPage : await src.get(i));
        }
        return imgs;
      };

      const scanOne = async ({ img, i }) => {
        try {
          const r = await ocrPage(img, eng);
          if (!r.sections.length) failed.push(i + 1);
          return { i, title: r.title, sections: r.sections };
        } catch (e) {
          if (!firstErr) firstErr = e;
          failed.push(i + 1);
          return { i, title: "", sections: [] };
        } finally {
          done += 1;
          const perPageMs = (Date.now() - startedAt) / Math.max(1, done);
          setProg({
            done,
            total,
            etaSec: Math.round((perPageMs * (total - done)) / 1000),
            secPerPage: Math.round(perPageMs / 100) / 10,
          });
        }
      };

      // Render the NEXT window while the current one is being scanned.
      //
      // Rasterising a page is ~300ms and scanning it is tens of seconds, so rendering is
      // never the bottleneck — but doing it between windows still left the API pipe empty
      // for a second or two on every window boundary, which over 25 windows is real time.
      // One window of lookahead keeps the pipe permanently full and costs one extra
      // window's worth of memory.
      let pending = renderWindow(range(0, Math.min(total, PAGE_WINDOW)));

      for (let from = 0; from < total; from += PAGE_WINDOW) {
        if (!alive()) return;
        const to = Math.min(total, from + PAGE_WINDOW);
        const idxs = range(from, to);

        // eslint-disable-next-line no-await-in-loop
        let imgs = await pending;
        if (!alive()) return;

        // Kick off the next window's rendering before we start waiting on the network.
        const nextFrom = to;
        pending = nextFrom < total
          ? renderWindow(range(nextFrom, Math.min(total, nextFrom + PAGE_WINDOW)))
          : Promise.resolve([]);

        // eslint-disable-next-line no-await-in-loop
        const results = await mapLimit(imgs.map((img, k) => ({ img, i: idxs[k] })), meta.concurrency, scanOne);
        perPage.push(...results);

        // Drop this window's images NOW. This is the difference between a 200-page PDF
        // working and the tab running out of image memory at ~50.
        imgs.length = 0;
        imgs = null;
        // Give the browser a tick to actually reclaim them.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }
      // If the loop exited early, make sure the lookahead is not left dangling.
      try { await pending; } catch {}

      if (!alive()) return;

      const good = perPage.filter((x) => x.sections.length).sort((a, b) => a.i - b.i);
      if (!good.length) {
        throw new Error(firstErr ? `Scan failed: ${firstErr.message}` : "Couldn't read any page. Please try a clearer scan.");
      }

      const title = good.find((x) => x.title)?.title || name || "Document";
      let sections = [];
      good.forEach((x) => { sections = sections.concat(x.sections); });
      sections = dedupeSections(sections);
      if (user && id) touchDocument(user.uid, id, { status: "extracted" });

      // ---- split into one item per question ----------------------------------
      // Chunked so very long papers cannot hit an output ceiling, and the chunks run
      // concurrently — a 100-page paper produces dozens of chunks and running those in
      // sequence added a second, separate multi-minute wait after OCR was already done.
      setProg(null);
      const SEC_BATCH = 14;
      const chunks = [];
      for (let s = 0; s < sections.length; s += SEC_BATCH) chunks.push(sections.slice(s, s + SEC_BATCH));

      let analyzeErr = null;
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
      if (!alive()) return;

      const its = chunkResults.flat();
      if (!its.length) throw new Error(analyzeErr ? `Couldn't structure the content: ${analyzeErr}` : "Couldn't structure the content. Please try again.");

      // ---- slide-count gate --------------------------------------------------
      const slideGate = checkDocumentLimits(profile, { slides: its.length });
      if (!slideGate.ok) {
        setLimitBlock({ ...slideGate, pages: total });
        setStatus("idle");
        return;
      }

      const sl = await buildFittedSlides(its);
      if (!alive()) return;
      setItems(its); setSlides(sl); setStatus("preview");

      // Count this successfully-processed document against the user's allowance.
      if (user) { const cr = await consume(user.uid, profile, "doc"); if (cr.ok) mergeProfile(cr.patch); }

      if (failed.length) {
        const shown = failed.slice(0, 12).sort((a, b) => a - b).join(", ");
        setError(`Note: ${failed.length} page(s) couldn't be read clearly (page ${shown}${failed.length > 12 ? "…" : ""}). Everything else is here.`);
      }

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
      if (!alive()) return;
      setError(e?.message || "Pipeline failed.");
      setStatus("idle");
    } finally {
      try { src?.destroy(); } catch {}
      if (runRef.current === runId) setProg(null);
    }
  };

  /* ------------------------------------------------------------------------ */
  /* file picking                                                              */
  /* ------------------------------------------------------------------------ */

  const onPick = async (f) => {
    if (!f) return;
    if (!user) { router.push("/register"); return; }
    // Don't let an upload start while the profile is still loading — otherwise the
    // plan reads as "free" and everyone gets capped at the free page limit.
    if (authLoading || !profile) { setError("Still loading your plan — try again in a second."); return; }

    const credits = checkDocumentLimits(profile, {});
    if (!credits.ok) { setLimitBlock(credits); return; }

    setError(""); setLimitBlock(null); setItems(null); setSlides(null);
    setFile(f); setDocId(null); setPages([]); setThumb(""); setPageCount(0);

    if (mode === "pipeline") {
      await runPipeline(f);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    /* ---- snippet mode still needs every page on screen ---- */
    setStatus("loading");
    try {
      let imgs = [];
      if (f.type.startsWith("image/")) {
        imgs = [await downscaleDataUrl(await fileToDataUrl(f), SNIPPET_MAX_DIM, 0.92)];
      } else {
        const count = await (async () => { const d = await openPdf(f); const n = d.numPages; d.destroy(); return n; })();
        const gate = checkDocumentLimits(profile, { pages: count });
        if (!gate.ok) { setLimitBlock(gate); setFile(null); setStatus("idle"); return; }
        if (count > SNIPPET_MAX_PAGES) {
          setError(`Snippet mode shows every page at once, so it is limited to ${SNIPPET_MAX_PAGES} pages. Use the SlideBaba Pipeline for a ${count}-page document.`);
          setFile(null); setStatus("idle");
          return;
        }
        imgs = await pdfToPageImages(f, { maxDim: SNIPPET_MAX_DIM, quality: 0.9 });
      }
      setPages(imgs);
      setPageCount(imgs.length);
      setThumb(await makeThumb(imgs[0], 620, 0.72));

      const ref = await saveDocument(user.uid, { name: f.name, status: "processing", mode, engine })
        .catch((e) => { console.error("[SlideBaba] could not create the document:", e); return null; });
      setDocId(ref?.id || null);
      setStatus("idle");
    } catch (e) {
      setError(`Couldn't read that file. Make sure it's a valid PDF or image. (${e?.message || "error"})`);
      setFile(null); setPages([]); setStatus("idle");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  /** "Try scan again" — re-runs from the original file, reusing the same document record. */
  const retryScan = () => { if (file) runPipeline(file, docId); };

  /* ------------------------------------------------------------------------ */
  /* snippet extraction                                                        */
  /* ------------------------------------------------------------------------ */

  const extractSnippets = async () => {
    const regions = regionsRef.current;
    if (!regions.length) { setError("Draw at least one box around a question first."); return; }
    setError(""); setStatus("scanning");
    try {
      const its = await mapLimit(regions, scanMeta(engineRef.current, accuracyRef.current).concurrency, async (r, i) => {
        const src = pages[r.page];
        const { width, height } = await imageSize(src);
        const cropped = await cropImage(src, { x: r.fx * width, y: r.fy * height, w: r.fw * width, h: r.fh * height });
        const ocr = await ocrImage(cropped, null, engineRef.current);
        const text = ocr.sections.map((s) => `${s.heading ? s.heading + " " : ""}${s.body}`).join("\n").trim();
        return { title: `Snippet ${i + 1}`, text: text || ocr.title || "" };
      });

      const slideGate = checkDocumentLimits(profile, { slides: its.length });
      if (!slideGate.ok) { setLimitBlock(slideGate); setStatus("idle"); return; }

      if (user) {
        const cr = await consume(user.uid, profile, "snip");
        if (!cr.ok) {
          if (cr.reason === "limit") setLimitBlock({ ok: false, kind: "credits", planLabel: PLANS[profile?.plan || "free"].label, message: "You have used all the AI credits on your plan for this cycle." });
          else setError("Couldn't update your credits — try again.");
          setStatus("idle");
          return;
        }
        mergeProfile(cr.patch);
      }

      const sl = await buildFittedSlides(its);
      setItems(its); setSlides(sl); setStatus("preview");
      if (user && docId) updateDocument(user.uid, docId, { status: "generated", slides: sl, format: "slides" }).catch((e) => console.error("[SlideBaba] could not store generated slides:", e));
    } catch (e) {
      setError(e.message || "Snippet extraction failed."); setStatus("idle");
    }
  };

  /* ------------------------------------------------------------------------ */
  /* handoff                                                                   */
  /* ------------------------------------------------------------------------ */

  // Opening no longer re-saves. runPipeline already stored this exact deck, and a second
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
        await updateDocument(user.uid, docId, { name: t, status: "generated", format: "notes", items });
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
  const hasDoc = Boolean(file && (pageCount > 0 || pages.length));

  const hasSlidePreview = Boolean(slides && slides.length);
  const previewEntries = hasSlidePreview
    ? slides.map((sl, idx) => {
        const textItems = (sl.elements || []).filter((el) => el.type === "text" || !el.type).map((el) => String(el.content || "").trim());
        return { title: textItems[0] || `Slide ${idx + 1}`, text: textItems.slice(1).join("\n\n") };
      })
    : items;
  const previewLabel = hasSlidePreview ? "Rendered slide preview" : "OCR preview";

  const steps = [
    { t: "Upload Complete", d: file ? file.name : "Awaiting file…", done: hasDoc, active: status === "loading" },
    { t: "OCR Scanning", d: `Reading text & formulas with ${engineMeta(engine).label}…`, done: status === "preview", active: status === "scanning" },
    { t: "Splitting by question", d: "One question per slide…", done: status === "preview", active: false },
  ];

  const planPages = maxPagesFor(profile);
  const planSlides = maxSlidesFor(profile);

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

        {/* Speed / accuracy dial. Fast is the default and is ONE read per page. */}
        {engine === "openai" && (
          <div className="mt-2 flex flex-col items-center gap-1.5">
            <div className="flex items-center gap-1 rounded-xl bg-ink-800/60 p-1 ring-1 ring-inset ring-white/10">
              {ACCURACY_ORDER.map((id) => {
                const a = ACCURACY_META[id];
                const active = accuracy === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => !busy && pickAccuracy(id)}
                    disabled={busy}
                    aria-pressed={active}
                    title={a.hint}
                    className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-bold transition disabled:cursor-not-allowed ${
                      active ? "bg-white/10 text-white" : "text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {id === "fast" ? <Zap className="h-3.5 w-3.5" /> : <Target className="h-3.5 w-3.5" />}
                    {a.label}
                  </button>
                );
              })}
            </div>
            <p className="text-center text-[11.5px] text-slate-500">{ACCURACY_META[accuracy].hint}</p>
          </div>
        )}

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
              {file && thumb ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumb} alt="doc" className="max-h-40 max-w-full rounded-xl object-contain shadow-soft" />
                  <p className="mt-4 max-w-xs truncate font-display text-lg font-bold text-white">{file.name}</p>
                  <p className="mt-1 text-sm text-slate-500">{busy ? `Working… ${pageCount} page${pageCount === 1 ? "" : "s"}` : "Tap to choose another file"}</p>
                </>
              ) : (
                <>
                  <span className="grid h-16 w-16 place-items-center rounded-2xl bg-sky-500/15 text-sky-300 shadow-soft"><FileUp className="h-8 w-8" /></span>
                  <p className="mt-4 font-display text-2xl font-extrabold text-white">Upload Document</p>
                  <p className="mt-1 text-sm text-slate-500">PDF, JPG, PNG — up to {planPages} pages on your plan</p>
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
                  <div className="flex flex-wrap items-center justify-center gap-2 rounded-xl bg-ink-800/60 px-4 py-3 text-sm font-semibold text-emerald-300 ring-1 ring-inset ring-white/5">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {status === "loading" ? "Opening file…" : "Scanning & building…"}
                    {status === "scanning" && <span className="tabular-nums text-slate-400">{fmtClock(elapsed)}</span>}
                  </div>
                  {prog && prog.total > 0 && (
                    <div className="rounded-xl bg-ink-800/60 px-3 py-2.5 ring-1 ring-inset ring-white/5">
                      <div className="flex items-center justify-between text-[11.5px] font-semibold text-slate-300">
                        <span>Page {prog.done} of {prog.total}</span>
                        {prog.done > 0 && prog.done < prog.total && <span className="tabular-nums text-slate-500">about {fmtClock(prog.etaSec)} left</span>}
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-950">
                        <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400 transition-all" style={{ width: `${Math.round((prog.done / prog.total) * 100)}%` }} />
                      </div>
                      {/* The measured rate and the model that actually answered. If a scan is
                          slow, these two numbers say why without opening the server log. */}
                      {prog.secPerPage > 0 && (
                        <p className="mt-2 truncate text-[10.5px] text-slate-600">
                          {prog.secPerPage}s per page{modelSeen ? ` · ${modelSeen}` : ""}{accuracy === "max" ? " · max accuracy" : ""}
                        </p>
                      )}
                    </div>
                  )}
                  {serverNote && (
                    <p className="rounded-xl bg-sky-500/10 px-3 py-2.5 text-[11.5px] leading-snug text-sky-200 ring-1 ring-inset ring-sky-400/25">{serverNote}</p>
                  )}
                  {status === "scanning" && engine === "openai" && accuracy === "max" && (
                    <p className="rounded-xl bg-ink-800/60 px-3 py-2.5 text-[11.5px] leading-snug text-slate-400 ring-1 ring-inset ring-white/5">
                      Max accuracy reads each page more than once — whole, then in
                      high-resolution slices. Switch to Fast for a quicker run.
                    </p>
                  )}
                </div>
              ) : error && file ? (
                <button onClick={retryScan} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-4 py-3 text-sm font-bold text-white shadow-soft transition hover:brightness-110">
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
              {status === "loading" && !thumb ? (
                <div className="flex items-center gap-2 text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /> Opening file…</div>
              ) : thumb ? (
                <div className="relative w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumb} alt="scan" className={`mx-auto block max-h-[420px] w-full max-w-full rounded-lg object-contain transition ${status === "scanning" ? "" : "opacity-90"}`} />
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
            <p className="mt-3 text-center text-[11px] text-slate-500">
              Your plan: up to {planPages} pages and {planSlides.toLocaleString("en-IN")} slides per document.
            </p>
          </div>
        </div>
      ) : (
        /* ---------- SNIPPET: pick regions ---------- */
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-lg font-bold text-white">Snippet Extractor</h3>
              <p className="text-sm text-slate-500">Draw a box around each question, then Extract.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => inputRef.current?.click()} disabled={busy} className="btn bg-ink-700 text-white hover:bg-ink-600 disabled:opacity-60"><FileUp className="h-4 w-4" /> {pages.length ? "Change file" : "Upload"}</button>
              {pages.length ? <button onClick={reset} className="btn-ghost"><Trash2 className="h-4 w-4" /> Clear</button> : null}
              <button onClick={extractSnippets} disabled={!pages.length || busy} className="btn bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-60">{status === "scanning" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />} Extract</button>
            </div>
          </div>

          {status === "loading" ? (
            <div className="grid min-h-[300px] place-items-center rounded-2xl bg-ink-850 text-slate-400 ring-1 ring-white/10"><Loader2 className="h-6 w-6 animate-spin" /><span className="ml-2">Rendering PDF…</span></div>
          ) : !pages.length ? (
            <button onClick={() => inputRef.current?.click()} className="grid min-h-[380px] w-full place-items-center rounded-2xl border-2 border-dashed border-white/15 bg-ink-850/40 text-center transition hover:border-brand-500/50">
              <span className="grid h-16 w-16 place-items-center rounded-2xl bg-sky-500/10 text-sky-300"><FileUp className="h-8 w-8" /></span>
              <p className="mt-4 font-display text-xl font-bold text-white">No Document Loaded</p>
              <p className="mt-1 text-sm text-slate-500">Upload a PDF or Image to get started (max {Math.min(planPages, SNIPPET_MAX_PAGES)} pages in this mode).</p>
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

      {/* ONE modal for every plan limit, and it always names the limit that actually
          fired. The old version could only ever say "page limit", so a slide-count
          block or an exhausted credit read as a page problem. */}
      {limitBlock && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-ink-950/70 p-4 backdrop-blur-sm" onMouseDown={() => setLimitBlock(null)}>
          <div className="w-full max-w-md rounded-2xl bg-ink-900 p-6 text-center ring-1 ring-white/10 shadow-glow" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-rose-500 to-orange-500 text-white shadow-soft">
              <FileText className="h-7 w-7" />
            </div>
            <h3 className="mt-4 font-display text-xl font-extrabold text-white">
              {limitBlock.kind === "pages" ? "PDF is above your page limit"
                : limitBlock.kind === "slides" ? "Document is above your slide limit"
                : "You're out of documents"}
            </h3>
            <p className="mt-2 text-sm text-slate-400">{limitBlock.message}</p>
            <p className="mt-1 text-xs text-slate-500">
              {limitBlock.kind === "credits"
                ? "Upgrade or wait for your next cycle to continue."
                : "Nothing was scanned and no credits were used. Upgrade for a higher limit, or split the file and try again."}
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <button onClick={() => { setLimitBlock(null); setPayOpen(true); }} className="flex-1 rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-bold text-white hover:brightness-110">Upgrade plan</button>
              <button onClick={() => setLimitBlock(null)} className="flex-1 rounded-xl bg-ink-800 px-4 py-2.5 text-sm font-bold text-slate-200 ring-1 ring-inset ring-white/10 hover:text-white">Close</button>
            </div>
            <p className="mt-4 text-[11px] text-slate-600">
              {Object.entries(PLANS).map(([, p]) => `${p.label} ${p.maxPages.m}`).join(" · ")} pages per document
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
