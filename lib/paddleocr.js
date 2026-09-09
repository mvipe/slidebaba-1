/**
 * SlideBaba — PaddleOCR client (SERVER-ONLY).
 * ---------------------------------------------------------------------------
 * The one place that talks to a PaddleOCR service. Nothing else in the app
 * makes an OCR network call. It is the complete scanning engine for SlideBaba.
 *
 * Three backends are supported and auto-detected, so the same build works
 * whether you use Baidu's hosted API, your own AI Studio deployment, or a
 * PaddleOCR server you run yourself:
 *
 *   1. "cloud"  — PaddleOCR official hosted API (async job + poll)
 *                 POST {base}/api/v2/ocr/jobs   Authorization: bearer <token>
 *                 GET  {base}/api/v2/ocr/jobs/{jobId}
 *                 default base: https://paddleocr.aistudio-app.com
 *                 token: AI Studio access token
 *
 *   2. "hub"    — an AI Studio *deployed* service (synchronous, one POST)
 *                 POST {base}/layout-parsing    Authorization: token <token>
 *                 base looks like https://xxxxxxxx.aistudio-hub.baidu.com
 *
 *   3. "self"   — self-hosted PaddleOCR / PaddleX serving (synchronous)
 *                 POST {base}/layout-parsing  (falls back to {base}/ocr)
 *                 auth optional
 *
 * Language: PaddleOCR-VL auto-detects script per text block and covers 100+
 * languages (Devanagari / Hindi / Sanskrit / Latin / CJK / Arabic ...), so we
 * deliberately send NO language lock — mixed Hindi+English+maths pages are
 * handled natively and correctly.
 *
 * FAILURE CLASSES — these are deliberately kept apart, because they need
 * opposite treatment and because saying the wrong one sends you debugging the
 * wrong thing:
 *   throttle  the shared queue is full ("任务提交队列已满"). Cheap to retry, so
 *             it gets exponential backoff and then a different model.
 *   timeout   the service accepted nothing within the time budget. EXPENSIVE to
 *             retry (each attempt burns the full timeout), so it retries once
 *             and then reports which stage stalled and for how long.
 *   quota     this model's daily allowance is gone (HTTP 429). Never retried on
 *             the same model; the next model in the chain is used instead.
 *   fatal     bad token, bad request. Reported immediately, never retried.
 *
 * Env (all optional except the token for hosted use):
 *   PADDLE_AISTUDIO_TOKEN    AI Studio access token  (aliases: PADDLEOCR_ACCESS_TOKEN,
 *                                                     PADDLE_OCR_TOKEN, PADDLE_TOKEN)
 *   PADDLE_OCR_BASE_URL      override base URL       (aliases: PADDLEOCR_BASE_URL,
 *                                                     PADDLE_AISTUDIO_URL, PADDLE_OCR_URL)
 *   PADDLE_OCR_MODE          auto | cloud | hub | self         (default: auto)
 *   PADDLE_OCR_MODEL         e.g. PaddleOCR-VL-1.6             (default: auto-probe)
 *   PADDLE_OCR_ORIENTATION   1|0  rotation correction          (default: 1)
 *   PADDLE_OCR_UNWARP        1|0  de-warp curved photos        (default: 0, slow)
 *   PADDLE_OCR_CHARTS        1|0  parse charts into tables     (default: 0, slow)
 *   PADDLE_OCR_TIMEOUT_MS    per-HTTP-call timeout             (default: 60000)
 *   PADDLE_OCR_MAX_WAIT_MS   total budget for one page         (default: 100000)
 *   PADDLE_OCR_CONCURRENCY   in-process parallel jobs          (default: 1)
 *   PADDLE_OCR_RETRIES       throttle retries per model        (default: 4)
 *   PADDLE_OCR_TIMEOUT_RETRIES  timeout retries per model      (default: 1)
 *   PADDLE_OCR_DEBUG         1|0  verbose server logs          (default: 0)
 *
 * Diagnostics: GET /api/ocr?probe=1 runs a real request against a tiny built-in
 * image and reports per-stage timings and the raw upstream answer.
 */

const CLOUD_BASE = "https://paddleocr.aistudio-app.com";

// Doc-parsing models, best first. Only used by the hosted job API — a deployed
// or self-hosted service serves whatever model it was started with.
const MODEL_CHAIN = ["PaddleOCR-VL-1.6", "PaddleOCR-VL-1.5", "PaddleOCR-VL", "PP-StructureV3"];

// Never fire a request that cannot plausibly finish — a 4-second call against a
// service that needs 15 is a guaranteed timeout and just burns the budget.
const MIN_CALL_MS = 12000;

const pickEnv = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
};

const flag = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};

const num = (name, dflt, min = 0) => {
  const v = Number(pickEnv(name));
  return Number.isFinite(v) && v > 0 ? Math.max(min, v) : dflt;
};

export function getPaddleConfig() {
  const token = pickEnv(
    "PADDLE_AISTUDIO_TOKEN",
    "PADDLEOCR_ACCESS_TOKEN",
    "PADDLE_OCR_TOKEN",
    "PADDLE_TOKEN",
    "AISTUDIO_ACCESS_TOKEN"
  );
  const baseUrl = pickEnv(
    "PADDLE_OCR_BASE_URL",
    "PADDLEOCR_BASE_URL",
    "PADDLE_AISTUDIO_URL",
    "PADDLE_OCR_URL",
    "PADDLEOCR_SERVER_URL"
  ).replace(/\/+$/, "");

  const timeoutMs = num("PADDLE_OCR_TIMEOUT_MS", 60000, 10000);
  const maxWaitMs = Math.max(timeoutMs, num("PADDLE_OCR_MAX_WAIT_MS", 100000, 20000));

  return {
    token,
    baseUrl,
    mode: (pickEnv("PADDLE_OCR_MODE") || "auto").toLowerCase(),
    model: pickEnv("PADDLE_OCR_MODEL"),
    timeoutMs,
    maxWaitMs,
    concurrency: num("PADDLE_OCR_CONCURRENCY", 1, 1),
    retries: num("PADDLE_OCR_RETRIES", 4, 0),
    timeoutRetries: num("PADDLE_OCR_TIMEOUT_RETRIES", 1, 0),
    debug: flag("PADDLE_OCR_DEBUG", false),
    options: {
      useDocOrientationClassify: flag("PADDLE_OCR_ORIENTATION", true),
      useDocUnwarping: flag("PADDLE_OCR_UNWARP", false),
      useChartRecognition: flag("PADDLE_OCR_CHARTS", false),
      useLayoutDetection: true,
      useTableRecognition: true,
      useFormulaRecognition: true,
      useTextlineOrientation: true,
      prettifyMarkdown: true,
    },
  };
}

/** True when the server has enough config to attempt an OCR call. */
export function isPaddleConfigured(cfg = getPaddleConfig()) {
  return Boolean(cfg.token || cfg.baseUrl);
}

const log = (cfg, ...args) => { if (cfg.debug) console.log("[SlideBaba/paddle]", ...args); };
const secs = (ms) => `${Math.round(ms / 100) / 10}s`;

/* -------------------------------------------------------------------------- */
/* input handling                                                             */
/* -------------------------------------------------------------------------- */

const DATA_URL_RE = /^data:([^;,]*)?(;[^,]*)?,(.*)$/s;

/**
 * Accepts a data: URL, a bare base64 string, or an http(s) URL.
 * Returns { base64, bytes, mime, fileType, isUrl, url }.
 * fileType follows the PaddleOCR API convention: 0 = PDF, 1 = image.
 */
export function readImageInput(image) {
  const raw = String(image || "").trim();
  if (!raw) throw new Error("Missing image data.");

  if (/^https?:\/\//i.test(raw)) {
    const isPdf = /\.pdf(\?|#|$)/i.test(raw);
    return { base64: "", bytes: null, mime: isPdf ? "application/pdf" : "image/*", fileType: isPdf ? 0 : 1, isUrl: true, url: raw };
  }

  let mime = "image/png";
  let b64 = raw;
  const m = raw.match(DATA_URL_RE);
  if (m) {
    mime = (m[1] || "image/png").toLowerCase();
    b64 = m[3] || "";
    if (!/;base64/i.test(m[2] || "")) {
      // Rare: a non-base64 data URL. Re-encode so the API always gets base64.
      b64 = Buffer.from(decodeURIComponent(b64), "utf8").toString("base64");
    }
  }
  b64 = b64.replace(/\s+/g, "");
  if (!b64) throw new Error("Image payload is empty.");

  let bytes;
  try { bytes = Buffer.from(b64, "base64"); }
  catch { throw new Error("Image payload is not valid base64."); }
  if (!bytes.length) throw new Error("Image payload decoded to zero bytes.");

  const isPdf = mime.includes("pdf") || bytes.slice(0, 4).toString("latin1") === "%PDF";
  return { base64: b64, bytes, mime: isPdf ? "application/pdf" : mime, fileType: isPdf ? 0 : 1, isUrl: false, url: "" };
}

const extForMime = (mime) => {
  if (!mime) return "png";
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("bmp")) return "bmp";
  if (mime.includes("tif")) return "tiff";
  return "png";
};

/* -------------------------------------------------------------------------- */
/* http helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Never throws. Returns { ok, status, json, text, timeout, elapsedMs, networkError }.
 * A timeout is reported as data, not an exception, so it can be classified rather
 * than being swallowed into a generic "request failed".
 */
async function httpJson(url, init, timeoutMs) {
  const started = Date.now();
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    const retryAfter = Number(res.headers?.get?.("retry-after")) || 0;
    return { ok: res.ok, status: res.status, json, text, elapsedMs: Date.now() - started, retryAfterMs: retryAfter * 1000 };
  } catch (e) {
    const elapsedMs = Date.now() - started;
    if (timedOut) return { ok: false, status: 0, timeout: true, elapsedMs, text: `No response within ${secs(timeoutMs)}` };
    return { ok: false, status: 0, networkError: true, elapsedMs, text: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const errText = (r, max = 300) => {
  const j = r?.json;
  const msg =
    j?.errorMsg || j?.error_msg || j?.msg || j?.message ||
    j?.error?.message || (typeof j?.error === "string" ? j.error : "") ||
    r?.text || "";
  return String(msg).replace(/\s+/g, " ").slice(0, max) || `HTTP ${r?.status || "?"}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- failure classification ------------------------------------------------ */
// NOTE: timeouts are deliberately NOT in this list. A timeout is not a queue-full,
// and labelling it as one sends you looking at the wrong problem.
const THROTTLE_WORDS = [
  "队列已满",        // 队列已满   queue is full
  "请稍后重试",  // 请稍后重试 please retry later
  "稍后再试",        // 稍后再试
  "排队",                    // 排队       queuing
  "繁忙",                    // 繁忙       busy
  "限流",                    // 限流       throttled
  "并发",                    // 并发       concurrency
  "queue\\s*(is\\s*)?full",
  "too\\s*many\\s*(requests|current)",
  "rate.?limit",
  "throttl",
  "server\\s*busy",
  "service\\s*unavailable",
  "try\\s*again\\s*later",
  "temporarily\\s*unavailable",
];
const THROTTLE_RE = new RegExp(THROTTLE_WORDS.join("|"), "i");

// Daily allowance for this model is gone — retrying will not help, another model may.
const QUOTA_RE = new RegExp(
  ["每日", "额度", "今日", "daily", "per\\s*day", "exceeded\\s*maximum"].join("|"),
  "i"
);

const FAIL = { THROTTLE: "throttle", TIMEOUT: "timeout", QUOTA: "quota", FATAL: "fatal", TRANSIENT: "transient", OFFLINE: "offline" };

/** One place that decides what a failed response actually means. */
function classify(r, detail) {
  if (r?.timeout) return FAIL.TIMEOUT;
  // A refused / unresolvable / reset connection is NOT a timeout. Nothing is
  // listening, so there is no service to be slow — and calling it a timeout sends
  // you tuning timeouts and inspecting upload sizes for a server that is simply
  // not running. This distinction is the whole point of having a class for it.
  if (r?.networkError) return FAIL.OFFLINE;
  const status = r?.status || 0;
  const text = String(detail || "");
  if (status === 401 || status === 403) return FAIL.FATAL;
  if (status === 429 || (QUOTA_RE.test(text) && !THROTTLE_RE.test(text))) return FAIL.QUOTA;
  if (THROTTLE_RE.test(text) || status === 503) return FAIL.THROTTLE;
  if (status === 408 || status === 504) return FAIL.TIMEOUT;
  if (status >= 500) return FAIL.TRANSIENT;
  return FAIL.FATAL;
}

// OFFLINE is deliberately absent: a server that is not running will not start
// itself during a retry loop, and reporting it immediately (as a 400, so the
// client stops too) surfaces the real problem in 3 seconds instead of 30.
const RETRYABLE = new Set([FAIL.THROTTLE, FAIL.TIMEOUT, FAIL.TRANSIENT, FAIL.QUOTA]);

// Backoff for a full queue: seconds, not milliseconds — plus jitter so parallel pages
// of the same PDF do not all wake up and re-submit at the same instant.
const backoffMs = (attempt) => Math.min(15000, Math.round(1600 * Math.pow(1.9, attempt))) + Math.floor(Math.random() * 700);

/* --- in-process concurrency gate ------------------------------------------ */
// The queue-full error is caused by submitting several pages at once. Serialising
// submissions inside this server process removes the self-inflicted half of it.
let gateActive = 0;
const gateWaiters = [];
const GATE_MAX_WAIT_MS = 45000;   // waiting for a slot must never eat the whole function timeout

async function withGate(limit, fn) {
  if (gateActive >= limit) {
    let release;
    const slot = new Promise((resolve) => { release = resolve; gateWaiters.push(resolve); });
    let timer;
    await Promise.race([slot, new Promise((r) => { timer = setTimeout(r, GATE_MAX_WAIT_MS); })]);
    clearTimeout(timer);
    const i = gateWaiters.indexOf(release);
    if (i >= 0) gateWaiters.splice(i, 1);   // timed out — go ahead anyway, backoff handles contention
  }
  gateActive += 1;
  try {
    return await fn();
  } finally {
    gateActive -= 1;
    const next = gateWaiters.shift();
    if (next) next();
  }
}

/* -------------------------------------------------------------------------- */
/* result normalisation                                                        */
/* -------------------------------------------------------------------------- */

// Keys that hold base64 imagery — never walk into them, they are megabytes each.
const IMAGE_KEYS = new Set([
  "images", "inputImage", "input_img", "outputImages", "output_images", "ocrImage",
  "docPreprocessingImage", "doc_preprocessor_image", "block_image", "img", "image",
  "visualize", "vis_image", "layout_det_res_img", "input_image", "preprocessed_img",
]);

const DROP_LABELS = new Set([
  "header", "footer", "page_number", "number", "seal", "stamp",
  "header_image", "footer_image", "aside_text", "vision_footnote",
]);

const IMAGE_LABELS = new Set(["image", "figure", "chart", "img", "picture"]);

/**
 * PaddleOCR responses differ between PP-OCRv5 / PP-StructureV3 / PaddleOCR-VL,
 * between the sync and the async job API, and between versions. Rather than
 * hard-coding one shape we walk the payload and harvest whatever is there:
 *   - markdown text            (markdown.text)
 *   - layout blocks            (parsing_res_list -> label/content/bbox)
 *   - plain recognised lines   (rec_texts)
 * Order of traversal is preserved so multi-page results stay in page order.
 */
export function normalizePaddleResult(payload) {
  const markdownParts = [];
  const blocks = [];
  const lines = [];
  const seen = new WeakSet();
  let depth = 0;

  const pushBlocks = (list) => {
    if (!Array.isArray(list)) return;
    for (const b of list) {
      if (!b || typeof b !== "object") continue;
      const label = String(b.block_label ?? b.label ?? b.type ?? "text").toLowerCase();
      const content = b.block_content ?? b.content ?? b.text ?? b.block_text ?? "";
      const bbox = b.block_bbox ?? b.bbox ?? b.block_box ?? null;
      const str = typeof content === "string" ? content : "";
      if (!str.trim() && !IMAGE_LABELS.has(label)) continue;
      blocks.push({ label, content: str, bbox: Array.isArray(bbox) ? bbox : null });
    }
  };

  const pushLines = (node) => {
    const texts = node.rec_texts || node.recTexts;
    if (!Array.isArray(texts)) return;
    const scores = node.rec_scores || node.recScores || [];
    const boxes = node.rec_boxes || node.rec_polys || node.dt_polys || [];
    texts.forEach((t, i) => {
      const s = typeof t === "string" ? t : "";
      if (!s.trim()) return;
      lines.push({ text: s, score: Number(scores[i] ?? 1) || 1, box: boxes[i] ?? null });
    });
  };

  const walk = (node) => {
    if (!node || typeof node !== "object" || depth > 24) return;
    if (seen.has(node)) return;
    seen.add(node);
    depth += 1;

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      depth -= 1;
      return;
    }

    const md = node.markdown;
    if (md) {
      if (typeof md === "string" && md.trim()) markdownParts.push(md);
      else if (typeof md === "object" && typeof md.text === "string" && md.text.trim()) markdownParts.push(md.text);
    }
    if (typeof node.markdown_text === "string" && node.markdown_text.trim()) markdownParts.push(node.markdown_text);

    pushBlocks(node.parsing_res_list || node.parsingResList || node.layout_parsing_result);
    pushLines(node);

    for (const [k, v] of Object.entries(node)) {
      if (IMAGE_KEYS.has(k)) continue;
      if (k === "markdown" || k === "parsing_res_list" || k === "parsingResList") continue;
      if (typeof v === "string") continue;         // strings never hold nested results
      walk(v);
    }
    depth -= 1;
  };

  walk(payload);

  return {
    markdown: markdownParts.join("\n\n").trim(),
    blocks: blocks.filter((b) => !DROP_LABELS.has(b.label)),
    lines,
  };
}

const resultIsEmpty = (r) => !r || (!r.markdown.trim() && !r.blocks.length && !r.lines.length);

/* -------------------------------------------------------------------------- */
/* backend: synchronous  (AI Studio deployed service / self-hosted PaddleX)     */
/* -------------------------------------------------------------------------- */

function syncPayload(input, cfg) {
  const o = cfg.options;
  return {
    file: input.isUrl ? input.url : input.base64,
    fileType: input.fileType,
    useDocOrientationClassify: o.useDocOrientationClassify,
    useDocUnwarping: o.useDocUnwarping,
    useTextlineOrientation: o.useTextlineOrientation,
    useLayoutDetection: o.useLayoutDetection,
    useTableRecognition: o.useTableRecognition,
    useFormulaRecognition: o.useFormulaRecognition,
    useChartRecognition: o.useChartRecognition,
    visualize: false,
  };
}

async function callSync(base, path, input, cfg, authScheme, deadline, trace) {
  const url = `${base.replace(/\/+$/, "")}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (cfg.token) headers.Authorization = `${authScheme} ${cfg.token}`;

  let last = null;
  let timeouts = 0;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_CALL_MS) break;

    const r = await httpJson(url, { method: "POST", headers, body: JSON.stringify(syncPayload(input, cfg)) }, Math.min(cfg.timeoutMs, remaining));
    trace?.push({ stage: "layout-parsing", status: r.status, ms: r.elapsedMs, timeout: !!r.timeout });

    const code = r.json?.errorCode;
    if (r.ok && (code === 0 || code === undefined || code === null)) {
      const norm = normalizePaddleResult(r.json?.result ?? r.json);
      if (!resultIsEmpty(norm)) return { ok: true, result: norm };
      return { ok: false, kind: FAIL.FATAL, stage: "layout-parsing", status: 200, detail: "PaddleOCR returned no text for this page." };
    }

    const detail = errText(r);
    const kind = classify(r, detail);
    last = { ok: false, kind, stage: "layout-parsing", status: r.status, detail, elapsedMs: r.elapsedMs };
    if (!RETRYABLE.has(kind)) return last;

    if (kind === FAIL.TIMEOUT && ++timeouts > cfg.timeoutRetries) break;
    if (kind !== FAIL.TIMEOUT && attempt >= cfg.retries) break;

    const wait = Math.max(r.retryAfterMs || 0, kind === FAIL.TIMEOUT ? 1500 : backoffMs(attempt));
    if (Date.now() + wait + MIN_CALL_MS > deadline) break;
    log(cfg, `sync ${kind} (${r.status}) — retrying in ${wait}ms:`, detail);
    await sleep(wait);
  }
  return last || { ok: false, kind: FAIL.TIMEOUT, stage: "layout-parsing", status: 408, detail: "Ran out of time before PaddleOCR answered." };
}

/* -------------------------------------------------------------------------- */
/* backend: hosted job API (submit + poll)                                     */
/* -------------------------------------------------------------------------- */

const deepFind = (node, key, depth = 0) => {
  if (!node || typeof node !== "object" || depth > 8) return undefined;
  if (!Array.isArray(node) && node[key] !== undefined) return node[key];
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const hit = deepFind(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

async function submitJob(base, input, cfg, model, deadline, trace) {
  const url = `${base}/api/v2/ocr/jobs`;
  const form = new FormData();

  if (input.isUrl) {
    form.append("fileUrl", input.url);
  } else {
    const blob = new Blob([input.bytes], { type: input.mime || "application/octet-stream" });
    form.append("file", blob, `page.${extForMime(input.mime)}`);
  }
  if (model) form.append("model", model);
  form.append(
    "optionalPayload",
    JSON.stringify({
      useDocOrientationClassify: cfg.options.useDocOrientationClassify,
      useDocUnwarping: cfg.options.useDocUnwarping,
      useChartRecognition: cfg.options.useChartRecognition,
      prettifyMarkdown: true,
    })
  );

  const remaining = deadline - Date.now();
  const r = await httpJson(url, { method: "POST", headers: { Authorization: `bearer ${cfg.token}` }, body: form }, Math.min(cfg.timeoutMs, Math.max(MIN_CALL_MS, remaining)));
  trace?.push({ stage: "submit", model, status: r.status, ms: r.elapsedMs, timeout: !!r.timeout, bytes: input.bytes?.length ?? 0 });

  if (r.ok) {
    const code = r.json?.code;
    if (code === undefined || code === 0 || r.json?.data) {
      const jobId = deepFind(r.json, "jobId") ?? deepFind(r.json, "job_id") ?? deepFind(r.json, "id");
      if (jobId) return { ok: true, jobId: String(jobId) };
      return { ok: false, kind: FAIL.FATAL, stage: "submit", status: 200, detail: "PaddleOCR did not return a job id." };
    }
  }
  const detail = errText(r);
  return { ok: false, kind: classify(r, detail), stage: "submit", status: r.status, detail, elapsedMs: r.elapsedMs, retryAfterMs: r.retryAfterMs };
}

async function pollJob(base, jobId, cfg, deadline, trace) {
  const url = `${base}/api/v2/ocr/jobs/${encodeURIComponent(jobId)}`;
  const headers = { Authorization: `bearer ${cfg.token}` };
  let wait = 900;
  let polls = 0;

  while (Date.now() < deadline) {
    const r = await httpJson(url, { method: "GET", headers }, Math.min(30000, Math.max(8000, deadline - Date.now())));
    polls += 1;

    if (r.ok) {
      const data = r.json?.data ?? r.json ?? {};
      const state = String(deepFind(data, "state") ?? deepFind(data, "status") ?? "").toLowerCase();

      if (state === "failed" || state === "error") {
        const detail = errText(r) || "PaddleOCR job failed.";
        trace?.push({ stage: "poll", polls, state, ms: r.elapsedMs });
        return { ok: false, kind: classify(r, detail), stage: "poll", status: r.status, detail };
      }
      if (state === "done" || state === "succeeded" || state === "success" || state === "finished") {
        const jsonUrl = deepFind(data, "jsonUrl") ?? deepFind(data, "json_url");
        trace?.push({ stage: "poll", polls, state, ms: r.elapsedMs });
        if (jsonUrl) {
          const rr = await httpJson(String(jsonUrl), { method: "GET" }, Math.min(cfg.timeoutMs, Math.max(MIN_CALL_MS, deadline - Date.now())));
          trace?.push({ stage: "download", status: rr.status, ms: rr.elapsedMs, timeout: !!rr.timeout });
          if (!rr.ok || !rr.json) {
            const detail = errText(rr) || "Could not download the PaddleOCR result.";
            return { ok: false, kind: classify(rr, detail), stage: "download", status: rr.status, detail };
          }
          return { ok: true, payload: rr.json };
        }
        return { ok: true, payload: data };
      }
    } else {
      const detail = errText(r);
      const kind = classify(r, detail);
      if (!RETRYABLE.has(kind)) {
        trace?.push({ stage: "poll", polls, status: r.status, ms: r.elapsedMs });
        return { ok: false, kind, stage: "poll", status: r.status, detail };
      }
    }

    if (Date.now() + wait >= deadline) break;
    await sleep(wait);
    wait = Math.min(2500, Math.round(wait * 1.35));
  }
  trace?.push({ stage: "poll", polls, state: "unfinished" });
  return { ok: false, kind: FAIL.TIMEOUT, stage: "poll", status: 408, detail: `Job did not finish within the time budget (${polls} status checks).` };
}

/** One model, retried according to what kind of failure it produced. */
async function attemptModel(base, input, cfg, model, deadline, trace) {
  let last = null;
  let timeouts = 0;

  for (let attempt = 0; ; attempt++) {
    if (deadline - Date.now() < MIN_CALL_MS) break;

    const sub = await submitJob(base, input, cfg, model, deadline, trace);
    if (sub.ok) {
      const res = await pollJob(base, sub.jobId, cfg, deadline, trace);
      if (res.ok) {
        const norm = normalizePaddleResult(res.payload);
        if (resultIsEmpty(norm)) return { ok: false, kind: FAIL.FATAL, stage: "parse", status: 200, detail: "PaddleOCR returned no text for this page." };
        return { ok: true, result: norm, model };
      }
      last = res;
      if (!RETRYABLE.has(res.kind)) return res;
      if (res.kind === FAIL.TIMEOUT && ++timeouts > cfg.timeoutRetries) break;
    } else {
      last = sub;
      if (sub.kind === FAIL.FATAL) return { ...sub, fatal: true };
      if (sub.kind === FAIL.QUOTA) return { ...sub, nextModel: true };
      if (/not\s*(found|exist|support)|unsupported|invalid\s*model/i.test(sub.detail || "")) return { ...sub, nextModel: true };
      if (!RETRYABLE.has(sub.kind)) return sub;
      if (sub.kind === FAIL.TIMEOUT && ++timeouts > cfg.timeoutRetries) break;
    }

    if (last.kind !== FAIL.TIMEOUT && attempt >= cfg.retries) break;
    const wait = Math.max(last.retryAfterMs || 0, last.kind === FAIL.TIMEOUT ? 1500 : backoffMs(attempt));
    if (Date.now() + wait + MIN_CALL_MS > deadline) break;
    log(cfg, `${last.stage} ${last.kind} (${last.status}) — retrying in ${wait}ms:`, last.detail);
    await sleep(wait);
  }

  return last
    ? { ...last, nextModel: last.kind !== FAIL.TIMEOUT }   // a stall is the service, not the model
    : { ok: false, kind: FAIL.TIMEOUT, stage: "submit", status: 408, detail: "Ran out of time before PaddleOCR answered." };
}

/**
 * Baidu's own guidance for a saturated queue / exhausted daily allowance is
 * "use another model or try again later" — so we do both, in that order.
 */
async function callCloud(base, input, cfg, modelChain, deadline, trace) {
  let last = null;
  for (const model of modelChain) {
    if (deadline - Date.now() < MIN_CALL_MS) break;
    const r = await attemptModel(base, input, cfg, model, deadline, trace);
    if (r.ok) return r;
    last = r;
    if (r.fatal || !r.nextModel) return r;
    log(cfg, `model ${model} unavailable/busy — trying the next one`);
  }
  return last || { ok: false, kind: FAIL.TIMEOUT, stage: "submit", status: 408, detail: "PaddleOCR request failed." };
}

/* -------------------------------------------------------------------------- */
/* backend selection                                                           */
/* -------------------------------------------------------------------------- */

function buildBackends(cfg) {
  const list = [];
  const base = cfg.baseUrl;
  const models = cfg.model ? [cfg.model] : MODEL_CHAIN;

  const cloud = (b) => ({ id: "cloud", base: b, run: (i, dl, t) => callCloud(b, i, cfg, models, dl, t) });
  const hub = (b) => ({ id: "hub", base: b, run: (i, dl, t) => callSync(b, "/layout-parsing", i, cfg, "token", dl, t) });
  const hubOcr = (b) => ({ id: "hub:ocr", base: b, run: (i, dl, t) => callSync(b, "/ocr", i, cfg, "token", dl, t) });
  const self = (b) => ({ id: "self", base: b, run: (i, dl, t) => callSync(b, "/layout-parsing", i, cfg, "token", dl, t) });
  const selfOcr = (b) => ({ id: "self:ocr", base: b, run: (i, dl, t) => callSync(b, "/ocr", i, cfg, "token", dl, t) });

  if (cfg.mode === "cloud") return [cloud(base || CLOUD_BASE)];
  if (cfg.mode === "hub") return base ? [hub(base), hubOcr(base)] : [];
  if (cfg.mode === "self") return base ? [self(base), selfOcr(base)] : [];

  // auto
  if (base) {
    if (/aistudio-app\.com/i.test(base) || /\/api\/v2\/ocr\/jobs\/?$/i.test(base)) {
      list.push(cloud(base.replace(/\/api\/v2\/ocr\/jobs\/?$/i, "")));
    } else if (/aistudio-hub\.baidu\.com/i.test(base)) {
      list.push(hub(base), hubOcr(base));
    } else {
      list.push(self(base), selfOcr(base));
    }
  }
  if (cfg.token && !list.some((b) => b.id === "cloud")) list.push(cloud(CLOUD_BASE));
  return list;
}

// Remember the backend that worked so a 40-page PDF probes once, not 40 times.
let stickyBackendKey = null;

/* -------------------------------------------------------------------------- */
/* error wording                                                               */
/* -------------------------------------------------------------------------- */

const STAGE_LABEL = {
  submit: "uploading the page",
  poll: "waiting for the parse to finish",
  download: "downloading the result",
  "layout-parsing": "parsing the page",
  parse: "reading the result",
};

function describe(last, elapsedMs, cfg) {
  const stage = STAGE_LABEL[last?.stage] || "talking to PaddleOCR";
  const detail = last?.detail || "request failed";
  const base = cfg?.baseUrl || "";
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(base);

  switch (last?.kind) {
    case FAIL.OFFLINE:
      return isLocal
        ? `Nothing is listening at ${base} — the local PaddleOCR server is not running. ` +
          `Start it with paddleocr-server\\start-paddleocr.bat and wait for "listening" in that window, ` +
          `then scan again. If the window is open but this keeps happening, open ${base}/health in a browser: ` +
          `no page means it crashed on startup (read that window for the reason), and a page means the port or ` +
          `PADDLE_OCR_BASE_URL in .env.local do not match. Or switch the engine to ChatGPT, which needs no local server. ` +
          `(${detail})`
        : `Could not connect to PaddleOCR at ${base || "the configured address"} — the address is wrong, ` +
          `the service is down, or a firewall is blocking it. This is a connection failure, not a slow response. (${detail})`;
    case FAIL.THROTTLE:
      return `PaddleOCR's shared queue is full right now (${detail}). The free tier limits how many pages can be parsed at once — waiting a minute and retrying usually clears it.`;
    case FAIL.QUOTA:
      return `PaddleOCR's daily allowance is used up for every model (${detail}). It resets each day; a deployed or self-hosted PaddleOCR service has no such cap.`;
    case FAIL.TIMEOUT:
      return `PaddleOCR did not respond while ${stage} — gave up after ${secs(elapsedMs)}. The service is reachable but not answering in time. Check /api/ocr?probe=1 for per-stage timings; if uploads are the slow part, a deployed AI Studio service (PADDLE_OCR_BASE_URL) removes the shared queue entirely.`;
    case FAIL.FATAL:
      return last?.status === 401 || last?.status === 403
        ? `PaddleOCR rejected the token (${detail}). Check PADDLE_AISTUDIO_TOKEN at https://aistudio.baidu.com/account/accessToken.`
        : `PaddleOCR error while ${stage} (${last?.status || "?"}): ${detail}`;
    default:
      return `PaddleOCR error while ${stage} (${last?.status || "?"}): ${detail}`;
  }
}

/* -------------------------------------------------------------------------- */
/* public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run PaddleOCR on one image / PDF page.
 * @returns {Promise<{ok:true, result, backend, model, trace, elapsedMs}
 *                  | {ok:false, error, status, retryable, kind, stage, trace, elapsedMs}>}
 */
export async function paddleOcr(image, cfgIn, opts = {}) {
  const cfg = cfgIn || getPaddleConfig();
  const trace = [];
  const started = Date.now();

  if (!isPaddleConfigured(cfg)) {
    return {
      ok: false, status: 400, retryable: false, kind: FAIL.FATAL, trace,
      error:
        "PaddleOCR is not configured. Set PADDLE_AISTUDIO_TOKEN (AI Studio access token) " +
        "and/or PADDLE_OCR_BASE_URL for a deployed or self-hosted PaddleOCR service.",
    };
  }

  let input;
  try { input = readImageInput(image); }
  catch (e) { return { ok: false, status: 400, retryable: false, kind: FAIL.FATAL, trace, error: String(e?.message || e) }; }

  let backends = buildBackends(cfg);
  if (!backends.length) {
    return { ok: false, status: 400, retryable: false, kind: FAIL.FATAL, trace, error: `PADDLE_OCR_MODE="${cfg.mode}" needs PADDLE_OCR_BASE_URL to be set.` };
  }

  if (stickyBackendKey) {
    const i = backends.findIndex((b) => `${b.id}|${b.base}` === stickyBackendKey);
    if (i > 0) backends = [backends[i], ...backends.slice(0, i), ...backends.slice(i + 1)];
  }

  return withGate(cfg.concurrency, async () => {
    const deadline = Date.now() + (opts.maxWaitMs || cfg.maxWaitMs);
    let last = null;

    for (const backend of backends) {
      if (deadline - Date.now() < MIN_CALL_MS) break;
      log(cfg, "trying backend", backend.id, backend.base);
      let r;
      try { r = await backend.run(input, deadline, trace); }
      catch (e) { r = { ok: false, kind: FAIL.TRANSIENT, stage: "submit", status: 0, detail: String(e?.message || e) }; }

      if (r.ok) {
        stickyBackendKey = `${backend.id}|${backend.base}`;
        log(cfg, "ok via", backend.id, r.model || "");
        return { ok: true, result: r.result, backend: backend.id, model: r.model || cfg.model || "", trace, elapsedMs: Date.now() - started };
      }
      log(cfg, "backend failed", backend.id, r.kind, r.status, r.detail);
      last = r;
      if (r.fatal || r.kind === FAIL.FATAL) break;   // credentials / bad request — no backend fixes it
    }

    const elapsedMs = Date.now() - started;
    return {
      ok: false,
      status: last?.status || 502,
      kind: last?.kind || FAIL.TRANSIENT,
      stage: last?.stage || "submit",
      retryable: RETRYABLE.has(last?.kind),
      error: describe(last, elapsedMs, cfg),
      detail: last?.detail || "",
      trace,
      elapsedMs,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

// 320x96 PNG reading "SlideBaba OCR probe / TEST 12345". ~1KB, so a probe measures
// the service, not the upload.
const PROBE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAABgCAAAAABJIPT0AAAD8UlEQVR42u3ab2iVZRgG8Gtu2c6mPKcVc5u2wAUOl5mbNOd29r7HuTWJWR9qkbZmiRFhUFTTD0pQ4JBA+oth5GgVCJ6YqVtDI1S2NSsiqtEH08jhFiem02h7p2e7+vC8+2+jkAjOruvTfT885znw433O4XDuBEK5kcwRgQAFKEABKgIUoAAFqAhQgAIUoCJAAQpQgIoABShAASr/HvDbinB5N4Lo2gsACI6up7jOiiOYvAYADQVFBR8A7+U793cDKa6Tf3L62wTjV5BTs7ybkWqa0XZi8V32lDWSrcWXeKn4+LHwAFvWkIb8ftm0Mye9Ir4yHTDzDK+eoiENf6sqqTW8uLEsdJo05MjiH4vz9pDmxZLQOVuyrINk+9qKL0luuUpDjqTR30Kz6Y3edaF1vbb1D4p3wIaMJ7+gBXzsIzbdzM2d/HU5acjPDz99qi+TTD7ADx+0JbMGSQ5mLfTGHrXWh+hvYXIrNzSycaNt/YPiHZAX99/9sgVc5PFaChc5jnNnjAFnVWL5lX11qWRgiN4CW1rAgYUZPmDAWZ3WS38LU4eZ5dHLsq1/UJwDRtvJ6AILmO5xKMCMQQ6ftJ9u5r593fPJ1Bi9bFtybTvJtorSTnLkcdKQu+vpb6EhMz16Wbb1D4qvTPsWTqjuRl+2rVd/iiaiuAmf1QMAbs35ptobAmItOBi2JV6qu4z+bXXP7BjCgSEAQPlX8LcAQDiCiGvb8YPi+lu4udAt+4Erd9HwXCi0zfB8Zemas2TACYe/3rn00XSPpjZUFbUl+f6KVfkN5Kt5bvXvpCH/zBmm3UJDXqgMVfbY1j8ovpLwH01nBfv1S0T5J0nQfKCeQAEKUICKAAUoQAEqAhSgAAWoCFCAAhSgIsD/B7DJdZNcN5Liuu4eOyfjrwD9mwyA/aF7jmHgEbegGQBaAji+2HV3zF5BXn+QxUyYkxntSt40ZLR0+Kdc7n6NPXeQvFI0n417OYuTNKNu1MP69LHuYMZOoG/rnNv7sCUVXTcB2P7cU+hdoiv8d9kV2twWGusyACD3YUSqcMvcmgfeBdp6qoHe5pL1Z3WFp1zhgOM4Hf6czPh0miHJn/OiJHmohl7hBRo+/zY/Cc/aKzzjZ6A/JzMZ8I+CTnLrNcbS+PFSx0ms+SXG2G2zFnDGKzxxTmbsia19oRC4fAgdS7Ch68SJeY3bj+L0sll7g6/3x3qwH0i5Fyiqb3klkPj6XeODGsF+NDy7EvOOnq8dmftWrl0680RS8js5AlT0S0SAAhSgIkABClCAigAFKEABKgIUoAAFqAhQgAIUoCJAAQpQgIoABShAASoCFKAABagIUIACFKAARXBj+Qv/48Sw2eSa0QAAAABJRU5ErkJggg==";

/**
 * Live end-to-end check. Sends a ~1KB built-in image and reports what each stage
 * cost, so a failure can be attributed to upload, queue, parse or download
 * instead of guessed at.
 */
export async function paddleProbe() {
  const cfg = getPaddleConfig();
  const started = Date.now();
  const r = await paddleOcr(PROBE_PNG, cfg, { maxWaitMs: Math.min(cfg.maxWaitMs, 60000) });
  return {
    ok: r.ok,
    totalMs: Date.now() - started,
    backend: r.backend || null,
    model: r.model || null,
    kind: r.kind || null,
    stage: r.stage || null,
    error: r.ok ? null : r.error,
    upstreamDetail: r.ok ? null : r.detail || null,
    trace: r.trace,
    textFound: r.ok ? (r.result.markdown || r.result.lines.map((l) => l.text).join(" ")).slice(0, 200) : null,
  };
}

/**
 * Is the configured PaddleOCR service actually answering?
 *
 * This exists because the most common failure by far is "the local server is not
 * running", and a full probe (which uploads an image and waits for inference) is
 * a slow and confusing way to discover that. This is a 2.5s GET: it separates
 * "nothing is listening" from "it is listening but the OCR is failing", which are
 * completely different problems with completely different fixes.
 */
export async function paddleReachable(cfg = getPaddleConfig()) {
  const base = cfg.baseUrl;
  if (!base) return { checked: false, reason: "No PADDLE_OCR_BASE_URL set — using the hosted API." };

  const started = Date.now();
  for (const path of ["/health", "/"]) {
    const r = await httpJson(`${base.replace(/\/+$/, "")}${path}`, { method: "GET" }, 2500);
    if (r.ok || (r.status > 0 && r.status < 500)) {
      return {
        checked: true,
        reachable: true,
        url: base,
        status: r.status,
        ms: Date.now() - started,
        server: r.json || null,     // the local server reports warm/loaded models here
      };
    }
    if (r.timeout) {
      return { checked: true, reachable: false, url: base, ms: Date.now() - started,
        reason: "Something is listening but did not answer within 2.5s." };
    }
  }
  return {
    checked: true,
    reachable: false,
    url: base,
    ms: Date.now() - started,
    reason: `Nothing is listening at ${base}. Start paddleocr-server\\start-paddleocr.bat, or switch the engine to ChatGPT.`,
  };
}

/** Config summary for the /api/ocr GET health check. Never returns secrets. */
export function paddleHealth() {
  const cfg = getPaddleConfig();
  return {
    engine: "PaddleOCR",
    configured: isPaddleConfigured(cfg),
    mode: cfg.mode,
    tokenPresent: Boolean(cfg.token),
    tokenLength: cfg.token ? cfg.token.length : 0,
    baseUrl: cfg.baseUrl || `(default) ${CLOUD_BASE}`,
    model: cfg.model || `auto: ${MODEL_CHAIN.join(" -> ")}`,
    backends: buildBackends(cfg).map((b) => `${b.id} -> ${b.base}`),
    options: cfg.options,
    timeoutMs: cfg.timeoutMs,
    maxWaitMs: cfg.maxWaitMs,
    concurrency: cfg.concurrency,
    retries: cfg.retries,
    timeoutRetries: cfg.timeoutRetries,
    inFlight: gateActive,
    hint: "Add ?probe=1 to run a live end-to-end test with per-stage timings.",
  };
}
