/**
 * SlideBaba — OpenAI (ChatGPT) OCR + splitting engine.
 *
 * This is the ChatGPT half of SlideBaba's dual-engine OCR. It is a deliberate
 * counterpart of lib/paddleocr.js (no code is shared between them):
 *
 *   paddleOcr(image, cfg)   ->  { ok, result:{markdown, blocks, lines}, ... }
 *   openaiOcr(image, cfg)   ->  { ok, result:{markdown, blocks, lines}, ... }
 *
 * Both return the SAME normalized shape, so lib/ocrStructure.js `buildDocument()`
 * turns either one into `{title, sections}` with exactly the same code path. That
 * is what makes the two engines interchangeable: the only thing that differs is
 * who read the pixels. Everything downstream — structuring, option grouping,
 * slide layout, export — is byte-identical.
 *
 * Failure classes are the same four as PaddleOCR (throttle / timeout / quota /
 * fatal) so /api/ocr can report and retry them with one shared code path.
 *
 * Environment
 * -----------
 *   OPENAI_API_KEY            required for this engine
 *   OPENAI_BASE_URL           default: https://api.openai.com/v1  (set for Azure/proxy)
 *   OPENAI_ORG                optional  OpenAI-Organization header
 *   OPENAI_PROJECT            optional  OpenAI-Project header
 *   OPENAI_VISION_MODEL       default: gpt-4o          (page transcription)
 *   OPENAI_SPLIT_MODEL        default: gpt-4o-mini     (question splitting)
 *   OPENAI_VISION_DETAIL      low|high|auto            (default: high)
 *   OPENAI_MAX_TOKENS         default: 16000           (per vision call — high enough that a
 *                                                       dense 20-question page is not truncated)
 *   OPENAI_TIMEOUT_MS         default: 90000
 *   OPENAI_MAX_WAIT_MS        default: 150000
 *   OPENAI_CONCURRENCY        default: 4               (pages in flight — higher = faster PDFs)
 *   OPENAI_MAX_CONTINUATIONS  default: 4               (extra calls to finish a truncated page)
 *   OPENAI_RETRIES            default: 4               (429 / 5xx backoff)
 *   OPENAI_TIMEOUT_RETRIES    default: 1
 *   OPENAI_DEBUG              1|0
 *
 * Diagnostics: GET /api/ocr?probe=1&engine=openai
 */

// Deliberately NOT from "@/lib/paddleocr". Model 1 must not depend on the PaddleOCR
// engine in any way — not even for a pure helper.
import { readImageInput } from "@/lib/imageInput";

const DEFAULT_BASE = "https://api.openai.com/v1";

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

export function getOpenAIConfig() {
  const timeoutMs = num("OPENAI_TIMEOUT_MS", 90000, 15000);
  return {
    apiKey: pickEnv("OPENAI_API_KEY", "OPENAI_KEY"),
    baseUrl: (pickEnv("OPENAI_BASE_URL", "OPENAI_API_BASE") || DEFAULT_BASE).replace(/\/+$/, ""),
    org: pickEnv("OPENAI_ORG", "OPENAI_ORGANIZATION"),
    project: pickEnv("OPENAI_PROJECT"),
    visionModel: pickEnv("OPENAI_VISION_MODEL", "OPENAI_MODEL") || "gpt-4o",
    splitModel: pickEnv("OPENAI_SPLIT_MODEL") || "gpt-4o-mini",
    detail: (pickEnv("OPENAI_VISION_DETAIL") || "high").toLowerCase(),
    // 16000, not 8000. A page with ~20 questions plus options and LaTeX can need well over
    // 8000 output tokens to transcribe in full. When the old ceiling was hit the model
    // stopped with finish_reason:"length" and the LAST several questions were silently
    // dropped — the "20 questions in, only 12–16 out" bug. gpt-4o allows up to 16384.
    maxTokens: num("OPENAI_MAX_TOKENS", 16000, 1000),
    timeoutMs,
    maxWaitMs: Math.max(timeoutMs, num("OPENAI_MAX_WAIT_MS", 150000, 20000)),
    // 4 pages in flight (was 2). The main lever on how long a multi-page PDF takes: the
    // per-page time is unchanged, but four pages read at once instead of two roughly
    // halves the wall-clock again. Comfortably inside a normal OpenAI rate limit; 429s
    // still back off and retry on their own.
    concurrency: num("OPENAI_CONCURRENCY", 4, 1),
    // How many extra "continue from where you stopped" calls a single truncated page may
    // make before we accept whatever we have.
    maxContinuations: num("OPENAI_MAX_CONTINUATIONS", 4, 1),
    retries: num("OPENAI_RETRIES", 4, 0),
    timeoutRetries: num("OPENAI_TIMEOUT_RETRIES", 1, 0),
    debug: flag("OPENAI_DEBUG", false),
  };
}

/** True when the server has enough config to attempt a ChatGPT call. */
export function isOpenAIConfigured(cfg = getOpenAIConfig()) {
  return Boolean(cfg.apiKey);
}

const log = (cfg, ...args) => { if (cfg.debug) console.log("[SlideBaba/openai]", ...args); };
const secs = (ms) => `${Math.round(ms / 100) / 10}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* http                                                                        */
/* -------------------------------------------------------------------------- */

/** Never throws. Returns { ok, status, json, text, timeout, elapsedMs, retryAfterMs }. */
async function httpJson(url, init, timeoutMs) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, cache: "no-store" });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    const ra = Number(res.headers.get("retry-after"));
    return {
      ok: res.ok,
      status: res.status,
      json,
      text,
      timeout: false,
      elapsedMs: Date.now() - started,
      retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0,
    };
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 408 : 0,
      json: null,
      text: String(e?.message || e),
      timeout: aborted,
      networkError: !aborted,
      elapsedMs: Date.now() - started,
      retryAfterMs: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* failure classification — same four classes as PaddleOCR                     */
/* -------------------------------------------------------------------------- */

const FAIL = { THROTTLE: "throttle", TIMEOUT: "timeout", QUOTA: "quota", FATAL: "fatal", TRANSIENT: "transient" };
const RETRYABLE = new Set([FAIL.THROTTLE, FAIL.TIMEOUT, FAIL.TRANSIENT]);

const errText = (r) => {
  const j = r.json;
  const m = j?.error?.message || j?.message || j?.error?.code;
  if (m) return String(m).slice(0, 400);
  return String(r.text || `HTTP ${r.status}`).replace(/\s+/g, " ").slice(0, 400);
};

function classify(r, detail) {
  if (r.timeout) return FAIL.TIMEOUT;
  if (r.networkError) return FAIL.TRANSIENT;
  const code = r.json?.error?.code || r.json?.error?.type || "";
  // Billing exhausted / hard quota — retrying costs time and never succeeds.
  if (/insufficient_quota|billing_hard_limit|exceeded_current_quota/i.test(`${code} ${detail}`)) return FAIL.QUOTA;
  if (r.status === 429) return FAIL.THROTTLE;                 // rate limit — backoff works
  if (r.status === 401 || r.status === 403) return FAIL.FATAL; // bad key / no access
  if (r.status === 400 || r.status === 404 || r.status === 422) return FAIL.FATAL;
  if (r.status >= 500) return FAIL.TRANSIENT;
  return FAIL.TRANSIENT;
}

const backoffMs = (attempt) => Math.round((1400 * Math.pow(1.9, attempt)) * (0.75 + Math.random() * 0.5));

/* -------------------------------------------------------------------------- */
/* concurrency gate (per server process)                                       */
/* -------------------------------------------------------------------------- */

let gateActive = 0;
const gateQueue = [];
const GATE_MAX_WAIT_MS = 45000;

async function withGate(limit, fn) {
  if (limit <= 1 && gateActive === 0) {
    gateActive++;
    try { return await fn(); } finally { gateActive--; releaseGate(); }
  }
  if (gateActive < limit) {
    gateActive++;
    try { return await fn(); } finally { gateActive--; releaseGate(); }
  }
  const got = await new Promise((resolve) => {
    const entry = { resolve, done: false };
    gateQueue.push(entry);
    setTimeout(() => { if (!entry.done) { entry.done = true; resolve(false); } }, GATE_MAX_WAIT_MS);
  });
  if (!got) {
    // Waiting for a slot must never eat the whole request budget — go anyway.
    gateActive++;
    try { return await fn(); } finally { gateActive--; releaseGate(); }
  }
  gateActive++;
  try { return await fn(); } finally { gateActive--; releaseGate(); }
}

function releaseGate() {
  const next = gateQueue.shift();
  if (next && !next.done) { next.done = true; next.resolve(true); }
}

/* -------------------------------------------------------------------------- */
/* prompts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The transcription prompt. Every line here exists to stop a *language* model from
 * behaving like one: no translating, no fixing, no summarising, no answering.
 * The output contract is markdown, which lib/ocrStructure.js already consumes as
 * PaddleOCR's markdown branch — so the two engines converge on one structurer.
 */
const VISION_SYSTEM = `You are a document transcription engine, not an assistant.
You receive one page of a scanned exam paper, textbook or worksheet and you output that page's text VERBATIM as markdown.

ABSOLUTE RULES
1. Transcribe only. Never translate, never correct spelling or grammar, never modernise, never summarise, never explain, never answer a question you read, never add commentary.
2. Keep the ORIGINAL SCRIPT and language exactly. Urdu stays Urdu. English stays English. Mixed pages stay mixed.
3. Reproduce EVERY answer option. If a question shows (A) (B) (C) (D) or (क) (ख) (ग) (घ) or (i) (ii) (iii) (iv) or (1) (2) (3) (4), all of them must appear, each on ITS OWN LINE, with the original bracket style.
3a. NEVER drop the question text. Every question has a STEM — the actual sentence being asked (e.g. "3. मंगम्मा किस भाषा की कहानी है?"). Transcribe the full stem, even when it is coloured, highlighted, underlined, circled or has handwriting over it. A slide that shows only the number and the options, with the question sentence missing, is a FAILURE. Options without their stem are worthless.
4. Mathematics -> LaTeX. Inline maths as $...$, display maths as $$...$$. Never describe a formula in words. Keep superscripts, subscripts, fractions, roots, integrals, matrices.
5. Tables -> an HTML <table>...</table> with the original cells. Do not flatten a table into prose.
6. Diagrams, photographs and figures: output nothing for the picture itself, but DO transcribe any labels or caption text printed on or under it.
7. Drop running headers, running footers, page numbers, watermarks and printer marks.
8. Keep the printed reading order. For a two-column page, read the full left column first, then the full right column.

SCRIPT FIDELITY — the most common way this task is failed
Read this twice. Getting the characters right matters more than anything else here.
- If the page is printed in Devanagari, your output MUST be Devanagari characters. Writing Hindi in Latin letters is a transliteration, and a transliteration is WRONG. "प्रश्न" is correct; "prashn", "prashna" and "Question" are all wrong.
- Never translate Hindi into English. Never translate English into Hindi. Never "helpfully" provide both.
- Reproduce matras (ि ी ु ू े ै ो ौ), conjuncts (क्ष त्र ज्ञ द्व श्र), anusvara/chandrabindu (ं ँ), visarga (ः), nukta (क़ ज़ फ़ ड़ ढ़) and halant (्) exactly as printed. Do not "regularise" an unusual spelling.
- Devanagari digits stay Devanagari (१२३), Latin digits stay Latin (123). Do not convert between them.
- Devanagari question labels keep their own form: प्रश्न, प्र., सवाल. Devanagari option letters keep theirs: (क) (ख) (ग) (घ) and (अ) (ब) (स) (द).
- The danda "।" and double danda "॥" are punctuation — keep them, do not replace them with a full stop.
- The same rules apply to every other non-Latin script on the page: Bengali, Tamil, Telugu, Gujarati, Punjabi, Odia, Kannada, Malayalam, Urdu, Arabic.

OUTPUT FORMAT
- Plain markdown. No code fences around the whole answer, no preamble, no "Here is the transcription".
- The page's main title (only if the page really has one) as a single "# Title" line.
- Section headings printed on the page as "## Heading".
- Each question starts on its own line, beginning with its printed label AND its full stem on that same line, exactly as printed ("प्रश्न 3. मंगम्मा किस भाषा की कहानी है?", "Q7 ...", "12. ..."). Do NOT put a question number on a line by itself, and do NOT turn a question into a "#"/"##" heading — a question is body text, never a heading, even when it is large, coloured or underlined.
- Each answer option on its own line directly under its question.
- A blank line between separate questions.
- If the page is blank or unreadable, output nothing at all.`;

const SPLIT_SYSTEM = `You split already-transcribed exam/worksheet text into one slide per question.

You will be given a JSON array of sections. Return JSON only:
{"items":[{"title":"...","text":"..."}]}

RULES
1. VERBATIM. "text" must reproduce the source characters exactly — same script, same language, same LaTeX, same tables. Never translate, reword, summarise, shorten, fix or answer anything.
2. ONE item per question. A sub-question that has its own stem (e.g. "प्रश्न 3 (क)", "5 (b)") becomes its own item; a sub-question that is just an answer option does NOT.
3. Answer options stay INSIDE their question's "text", one option per line, in printed order, with the original bracket style. Never drop an option, never split options into their own item.
4. "title" is the printed question label, short ("प्रश्न 3", "Q7", "12."). If a section has no label, use the first few words of its text.
5. Preserve the original order. Never merge two different questions. Never invent an item.
6. Output EVERY question you are given — no cap, no truncation, no "..." continuation.
7. Text that is not a question (an instruction block, a passage, a heading) becomes its own item, kept whole.`;

/* -------------------------------------------------------------------------- */
/* chat completions                                                            */
/* -------------------------------------------------------------------------- */

function headers(cfg) {
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` };
  if (cfg.org) h["OpenAI-Organization"] = cfg.org;
  if (cfg.project) h["OpenAI-Project"] = cfg.project;
  return h;
}

/**
 * One chat/completions call with retry + backoff, bounded by `deadline`.
 * Returns { ok:true, content, model, finishReason } or a classified failure.
 */
async function chat(cfg, body, stage, deadline, trace) {
  const url = `${cfg.baseUrl}/chat/completions`;
  const MIN_CALL_MS = 8000;
  let last = null;
  let timeouts = 0;

  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_CALL_MS) break;

    const r = await httpJson(
      url,
      { method: "POST", headers: headers(cfg), body: JSON.stringify(body) },
      Math.min(cfg.timeoutMs, remaining)
    );
    trace?.push({ stage, status: r.status, ms: r.elapsedMs, timeout: !!r.timeout });

    if (r.ok) {
      const choice = r.json?.choices?.[0];
      const content = choice?.message?.content;
      const text = Array.isArray(content)
        ? content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("")
        : String(content || "");
      return {
        ok: true,
        content: text,
        model: r.json?.model || body.model,
        finishReason: choice?.finish_reason || "",
        usage: r.json?.usage || null,
      };
    }

    const detail = errText(r);
    const kind = classify(r, detail);
    last = { ok: false, kind, stage, status: r.status, detail, elapsedMs: r.elapsedMs };
    if (!RETRYABLE.has(kind)) return last;

    if (kind === FAIL.TIMEOUT && ++timeouts > cfg.timeoutRetries) break;
    if (kind !== FAIL.TIMEOUT && attempt >= cfg.retries) break;

    const wait = Math.max(r.retryAfterMs || 0, kind === FAIL.TIMEOUT ? 1500 : backoffMs(attempt));
    if (Date.now() + wait + MIN_CALL_MS > deadline) break;
    log(cfg, `${stage} ${kind} (${r.status}) — retrying in ${wait}ms:`, detail);
    await sleep(wait);
  }

  return last || { ok: false, kind: FAIL.TIMEOUT, stage, status: 408, detail: "Ran out of time before ChatGPT answered." };
}

/* -------------------------------------------------------------------------- */
/* output cleanup                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Models sometimes wrap the whole page in ```markdown fences, or open with
 * "Here is the transcription:". Strip both — the structurer must see the page.
 */
function cleanTranscript(raw) {
  let t = String(raw || "").replace(/\r\n?/g, "\n").trim();

  // Whole answer wrapped in one fence.
  const fence = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();

  // Leading chatter before the real content.
  t = t.replace(
    /^(?:here (?:is|are)[^\n]*|sure[,!][^\n]*|transcription[^\n]*|the page (?:reads|contains)[^\n]*)\n+/i,
    ""
  );

  // \( \) and \[ \] -> $ $ and $$ $$ so KaTeX renders them, matching the Paddle path.
  t = t.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => `$$${inner.trim()}$$`);
  t = t.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => `$${inner.trim()}$`);

  return t.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Join a continuation onto the transcript so far without duplicating the seam.
 *
 * When a page is transcribed across more than one call (see the continuation loop in
 * openaiOcr), the model is asked NOT to repeat what it already wrote — but it sometimes
 * echoes the last line or two anyway. This finds the longest suffix of what we have that
 * the addition starts with, and drops that overlap, so a question can never appear twice
 * and none is lost at the join.
 */
function stitchTranscript(soFar, addition) {
  const prev = String(soFar || "");
  let add = String(addition || "").trim();
  if (!prev) return add;
  if (!add) return prev;

  // Common ways a model prefaces a continuation — strip them before matching.
  add = add.replace(/^(?:\.\.\.|…|\(?continued\)?:?|continuing:?)\s*/i, "");

  const maxOverlap = Math.min(600, prev.length, add.length);
  for (let len = maxOverlap; len >= 20; len--) {
    if (prev.slice(-len) === add.slice(0, len)) {
      add = add.slice(len);
      break;
    }
  }

  return `${prev.replace(/\s+$/, "")}\n\n${add.replace(/^\s+/, "")}`.trim();
}

/* -------------------------------------------------------------------------- */
/* script fidelity                                                            */
/* -------------------------------------------------------------------------- */

const DEVANAGARI_RE = /[\u0900-\u097F]/g;

/**
 * Hindi words that a model produces when it transliterates instead of transcribing.
 * These are Latin spellings that essentially never occur in a genuinely English page,
 * which is what makes them a usable signal rather than a guess.
 */
const ROMANISED_HINDI_RE =
  /\b(prashn|prasht|prashna|nimnalikhit|nimn|likhit|uttar|vikalp|kaun|kaunsa|kya|kyaa|hai|hain|karen|kijiye|kijie|sahi|galat|adhyay|paath|shabd|vakya|vaakya|ganit|sankhya|bhasha|vigyan|itihas|bharat|nirdesh|ankit|diya|gaya|lekhan|abhyas)\b/gi;

const countMatches = (text, re) => (String(text || "").match(re) || []).length;

/**
 * True when the answer looks like romanised Hindi rather than Devanagari.
 *
 * The check is deliberately conservative: it fires only when there is almost NO Devanagari
 * AND several unmistakably-Hindi Latin words. A genuinely English page trips neither
 * condition, so a correct transcription is never re-run.
 */
function looksTransliterated(text) {
  const t = String(text || "");
  const dev = countMatches(t, DEVANAGARI_RE);
  if (dev > 5) return false;                  // real Devanagari is present — nothing to fix

  // A retry costs a whole second vision call, and on a dense page that is a minute or
  // more. Only spend it where the payoff is real: a long transcript that came back in
  // Latin is far more likely to be a genuinely English page than a romanised Hindi one,
  // and re-asking would just burn time and money.
  if (t.length > 6000) return false;

  return countMatches(t, ROMANISED_HINDI_RE) >= 3;
}

/** A refusal or an "I can't read this" is not a transcription — treat it as empty. */
const REFUSAL_RE = /^(i'?m sorry|i cannot|i can'?t|unable to (?:read|transcribe|assist)|sorry, )/i;

function transcriptIsUseless(t) {
  const s = String(t || "").trim();
  if (!s) return true;
  if (s.length < 12 && !/[0-9\p{L}]/u.test(s)) return true;
  if (REFUSAL_RE.test(s) && s.length < 300) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* error wording                                                               */
/* -------------------------------------------------------------------------- */

const STAGE_LABEL = {
  vision: "reading the page",
  split: "splitting the questions",
};

function describe(last, elapsedMs) {
  const stage = STAGE_LABEL[last?.stage] || "talking to ChatGPT";
  const detail = last?.detail || "request failed";

  switch (last?.kind) {
    case FAIL.THROTTLE:
      return `ChatGPT rate-limited this request (${detail}). Your OpenAI account allows only so many requests per minute — waiting a moment and retrying usually clears it, or switch the engine to PaddleOCR, which runs locally with no limit.`;
    case FAIL.QUOTA:
      return `Your OpenAI account has no credit left (${detail}). Add billing at https://platform.openai.com/account/billing, or switch the engine to PaddleOCR, which is free and runs on your own machine.`;
    case FAIL.TIMEOUT:
      return `ChatGPT did not respond while ${stage} — gave up after ${secs(elapsedMs)}. Check /api/ocr?probe=1&engine=openai for per-stage timings.`;
    case FAIL.FATAL:
      return last?.status === 401 || last?.status === 403
        ? `OpenAI rejected the API key (${detail}). Check OPENAI_API_KEY in .env.local.`
        : `ChatGPT error while ${stage} (${last?.status || "?"}): ${detail}`;
    default:
      return `ChatGPT error while ${stage} (${last?.status || "?"}): ${detail}`;
  }
}

/* -------------------------------------------------------------------------- */
/* public: OCR                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read one image / page with GPT vision.
 *
 * @returns {Promise<{ok:true, result:{markdown:string, blocks:Array, lines:Array},
 *                    backend:string, model:string, trace:Array, elapsedMs:number}
 *                 | {ok:false, error:string, status:number, retryable:boolean,
 *                    kind:string, stage:string, trace:Array, elapsedMs:number}>}
 */
export async function openaiOcr(image, cfgIn, opts = {}) {
  const cfg = cfgIn || getOpenAIConfig();
  const trace = [];
  const started = Date.now();

  if (!isOpenAIConfigured(cfg)) {
    return {
      ok: false, status: 400, retryable: false, kind: FAIL.FATAL, stage: "vision", trace, elapsedMs: 0,
      error: "ChatGPT engine is not configured. Set OPENAI_API_KEY in .env.local, or switch the engine to PaddleOCR.",
    };
  }

  let input;
  try { input = readImageInput(image); }
  catch (e) {
    return { ok: false, status: 400, retryable: false, kind: FAIL.FATAL, stage: "vision", trace, elapsedMs: 0, error: String(e?.message || e) };
  }
  if (input.fileType === 0) {
    return {
      ok: false, status: 400, retryable: false, kind: FAIL.FATAL, stage: "vision", trace, elapsedMs: 0,
      error: "The ChatGPT engine reads images, not PDFs. SlideBaba rasterises PDF pages before scanning, so this should not happen — please report it.",
    };
  }

  const imageUrl = input.isUrl ? input.url : `data:${input.mime || "image/jpeg"};base64,${input.base64}`;
  const detail = ["low", "high", "auto"].includes(cfg.detail) ? cfg.detail : "high";

  return withGate(cfg.concurrency, async () => {
    const deadline = Date.now() + (opts.maxWaitMs || cfg.maxWaitMs);

    const ask = (extraInstruction) => chat(
      cfg,
      {
        model: cfg.visionModel,
        temperature: 0,
        top_p: 1,
        max_tokens: cfg.maxTokens,
        messages: [
          { role: "system", content: VISION_SYSTEM },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Transcribe this page verbatim as markdown, following every rule above." +
                  (extraInstruction ? `\n\n${extraInstruction}` : ""),
              },
              { type: "image_url", image_url: { url: imageUrl, detail } },
            ],
          },
        ],
      },
      "vision",
      deadline,
      trace
    );

    let r = await ask("");
    let markdown = r.ok ? cleanTranscript(r.content) : "";
    let finishReason = r.finishReason || "";
    let continuations = 0;

    // CONTINUATION ON TRUNCATION — the fix for "20 questions in, only 12–16 out".
    //
    // A dense page (many questions, options, LaTeX) can need more output tokens than one
    // completion is allowed to produce. When that happens the model stops with
    // finish_reason:"length" and the TAIL of the page — the last several questions — is
    // simply absent from the transcript. Nothing downstream can recover text that was
    // never returned, so the slides come up short every time on the same papers.
    //
    // Instead of trusting a cut-off answer, keep asking the model to CONTINUE from exactly
    // where it stopped. It can still see the same image, so it reads on from the next line
    // and we stitch the pieces together (dropping any repeated seam). This runs ONLY when a
    // page actually truncated, so ordinary pages pay nothing — they finish in one call as
    // before. It is bounded by maxContinuations and by the request deadline, and each pass
    // needs comfortable headroom left, so a pathological page can never run away.
    while (
      r.ok &&
      finishReason === "length" &&
      continuations < cfg.maxContinuations &&
      deadline - Date.now() > 15000
    ) {
      continuations += 1;
      const tail = markdown.slice(-1800);
      log(cfg, `page truncated (finish_reason=length) — continuation ${continuations}`);
      const cont = await ask(
        "CONTINUATION: the page is long and your previous answer was cut off before the end. " +
        "Below is the transcription produced SO FAR. Continue transcribing THE SAME page from " +
        "exactly where it stops — the very next line/question after the end of the text below — " +
        "following every rule above. Do NOT repeat anything already transcribed, do NOT start " +
        "over, do NOT summarise, do NOT add any preamble. Output only the remaining content.\n\n" +
        "--- TRANSCRIPTION SO FAR (do not repeat any of this) ---\n" + tail
      );
      if (!cont.ok) {
        // A failed continuation is not a failed page: we already have the earlier part.
        // Keep it, stop continuing, and let the (possibly truncated) result flow on.
        log(cfg, `continuation ${continuations} failed (${cont.kind}) — keeping what we have`);
        break;
      }
      const addition = cleanTranscript(cont.content);
      const before = markdown.length;
      markdown = stitchTranscript(markdown, addition);
      finishReason = cont.finishReason || "";
      r = cont; // so model / usage / the final finish state reflect the last call
      // If a continuation added nothing new, further ones almost certainly won't either.
      if (markdown.length <= before + 4) break;
    }

    // SCRIPT-FIDELITY RETRY.
    // The characteristic ChatGPT failure on an Indian exam paper is romanising Devanagari
    // — "prashn 1" instead of "प्रश्न 1" — which is silently wrong rather than obviously
    // broken, and no amount of downstream structuring can undo it. When the answer looks
    // romanised, ask once more with the rule stated as a correction, and keep whichever
    // attempt actually contains Devanagari. PaddleOCR does not need this: it recognises
    // glyphs and cannot transliterate in the first place.
    // The budget check matters as much as the detector: never start a second long
    // completion unless there is comfortably time for it to finish. Skipped when the page
    // was continued (it is long and already in-script), so the two never fight.
    if (continuations === 0 && r.ok && looksTransliterated(markdown) && deadline - Date.now() > 45000) {
      log(cfg, "answer looks romanised — retrying with an explicit script instruction");
      const retry = await ask(
        "CORRECTION: your previous attempt wrote Hindi words in Latin letters. That is a " +
        "transliteration and it is wrong. This page is printed in Devanagari. Output " +
        "Devanagari characters exactly as they appear on the page — प्रश्न, not \"prashn\". " +
        "Do not translate to English. Do not romanise. Copy the glyphs you see."
      );
      if (retry.ok) {
        const retryMd = cleanTranscript(retry.content);
        if (countMatches(retryMd, DEVANAGARI_RE) > countMatches(markdown, DEVANAGARI_RE)) {
          r = retry;
          markdown = retryMd;
          log(cfg, "retry recovered Devanagari — using it");
        }
      }
    }

    const elapsedMs = Date.now() - started;

    if (!r.ok) {
      return {
        ok: false,
        status: r.status || 502,
        kind: r.kind || FAIL.TRANSIENT,
        stage: r.stage || "vision",
        retryable: RETRYABLE.has(r.kind),
        error: describe(r, elapsedMs),
        detail: r.detail || "",
        trace,
        elapsedMs,
      };
    }

    if (transcriptIsUseless(markdown)) {
      return {
        ok: false, status: 200, kind: FAIL.FATAL, stage: "vision", retryable: false,
        error: "ChatGPT could not read any text on this page. Try a clearer or higher-resolution scan.",
        detail: String(r.content || "").slice(0, 200), trace, elapsedMs,
      };
    }

    // Same normalized shape PaddleOCR returns, so buildDocument() treats both alike.
    return {
      ok: true,
      result: { markdown, blocks: [], lines: [] },
      backend: "openai",
      model: r.model || cfg.visionModel,
      // Only still truncated if we ran out of continuation budget — after a full stitch
      // this is normally false even on the densest pages.
      truncated: finishReason === "length",
      continuations,
      usage: r.usage,
      trace,
      elapsedMs,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* public: splitting                                                           */
/* -------------------------------------------------------------------------- */

/** Pull the first JSON object out of a model answer, fence or no fence. */
function parseJsonLoose(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* keep trying */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* keep trying */ } }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) { try { return JSON.parse(t.slice(first, last + 1)); } catch { /* give up */ } }
  return null;
}

const shortTitle = (s, max = 52) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trim()}…`;
};

/**
 * Split `sections` into one item per question using ChatGPT.
 *
 * Returns { ok:true, items } or a classified failure. `/api/analyze` falls back to
 * the local rules splitter on any failure, so a rate limit degrades to "free and
 * instant" rather than to "the scan failed".
 */
export async function openaiSplit(title, sections, cfgIn, opts = {}) {
  const cfg = cfgIn || getOpenAIConfig();
  const trace = [];
  const started = Date.now();

  if (!isOpenAIConfigured(cfg)) {
    return { ok: false, kind: FAIL.FATAL, stage: "split", status: 400, retryable: false, trace, elapsedMs: 0,
      error: "ChatGPT engine is not configured. Set OPENAI_API_KEY in .env.local." };
  }

  const clean = (Array.isArray(sections) ? sections : [])
    .map((s) => ({ heading: String(s?.heading || "").trim(), body: String(s?.body || "").trim() }))
    .filter((s) => s.heading || s.body);

  if (!clean.length) return { ok: true, items: [], model: cfg.splitModel, trace, elapsedMs: 0 };

  return withGate(cfg.concurrency, async () => {
    const deadline = Date.now() + (opts.maxWaitMs || cfg.maxWaitMs);

    const r = await chat(
      cfg,
      {
        model: cfg.splitModel,
        temperature: 0,
        top_p: 1,
        max_tokens: cfg.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SPLIT_SYSTEM },
          {
            role: "user",
            content:
              `Document title: ${String(title || "Untitled")}\n\n` +
              `Sections:\n${JSON.stringify(clean)}\n\n` +
              `Return {"items":[{"title","text"}]} covering every question, verbatim.`,
          },
        ],
      },
      "split",
      deadline,
      trace
    );

    const elapsedMs = Date.now() - started;

    if (!r.ok) {
      return {
        ok: false,
        status: r.status || 502,
        kind: r.kind || FAIL.TRANSIENT,
        stage: "split",
        retryable: RETRYABLE.has(r.kind),
        error: describe(r, elapsedMs),
        detail: r.detail || "",
        trace,
        elapsedMs,
      };
    }

    // A "length" finish means the JSON was cut off mid-array — the classic GPT
    // splitter failure that silently loses the last questions. Refuse it so the
    // caller falls back to the local splitter, which cannot truncate.
    if (r.finishReason === "length") {
      return { ok: false, status: 200, kind: FAIL.TRANSIENT, stage: "split", retryable: true, trace, elapsedMs,
        error: "ChatGPT's answer hit its output limit and the question list was cut short." };
    }

    const parsed = parseJsonLoose(r.content);
    const rawItems = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : null;
    if (!rawItems) {
      return { ok: false, status: 200, kind: FAIL.TRANSIENT, stage: "split", retryable: true, trace, elapsedMs,
        error: "ChatGPT did not return a usable item list." };
    }

    const items = rawItems
      .map((it) => ({
        title: shortTitle(it?.title || ""),
        text: String(it?.text ?? it?.body ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
      }))
      .filter((it) => it.text || it.title)
      .map((it, i) => ({ title: it.title || shortTitle(it.text.split("\n")[0]) || `Slide ${i + 1}`, text: it.text || it.title }));

    if (!items.length) {
      return { ok: false, status: 200, kind: FAIL.TRANSIENT, stage: "split", retryable: true, trace, elapsedMs,
        error: "ChatGPT returned an empty item list." };
    }

    return { ok: true, items, model: r.model || cfg.splitModel, usage: r.usage, trace, elapsedMs };
  });
}

/* -------------------------------------------------------------------------- */
/* diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

// Same ~1KB probe image the PaddleOCR adapter uses, so the two engines' probe
// timings are directly comparable.
const PROBE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAABgCAAAAABJIPT0AAAD8UlEQVR42u3ab2iVZRgG8Gtu2c6mPKcVc5u2wAUOl5mbNOd29r7HuTWJWR9qkbZmiRFhUFTTD0pQ4JBA+oth5GgVCJ6YqVtDI1S2NSsiqtEH08jhFiem02h7p2e7+vC8+2+jkAjOruvTfT885znw433O4XDuBEK5kcwRgQAFKEABKgIUoAAFqAhQgAIUoCJAAQpQgIoABShAASr/HvDbinB5N4Lo2gsACI6up7jOiiOYvAYADQVFBR8A7+U793cDKa6Tf3L62wTjV5BTs7ybkWqa0XZi8V32lDWSrcWXeKn4+LHwAFvWkIb8ftm0Mye9Ir4yHTDzDK+eoiENf6sqqTW8uLEsdJo05MjiH4vz9pDmxZLQOVuyrINk+9qKL0luuUpDjqTR30Kz6Y3edaF1vbb1D4p3wIaMJ7+gBXzsIzbdzM2d/HU5acjPDz99qi+TTD7ADx+0JbMGSQ5mLfTGHrXWh+hvYXIrNzSycaNt/YPiHZAX99/9sgVc5PFaChc5jnNnjAFnVWL5lX11qWRgiN4CW1rAgYUZPmDAWZ3WS38LU4eZ5dHLsq1/UJwDRtvJ6AILmO5xKMCMQQ6ftJ9u5r593fPJ1Bi9bFtybTvJtorSTnLkcdKQu+vpb6EhMz16Wbb1D4qvTPsWTqjuRl+2rVd/iiaiuAmf1QMAbs35ptobAmItOBi2JV6qu4z+bXXP7BjCgSEAQPlX8LcAQDiCiGvb8YPi+lu4udAt+4Erd9HwXCi0zfB8Zemas2TACYe/3rn00XSPpjZUFbUl+f6KVfkN5Kt5bvXvpCH/zBmm3UJDXqgMVfbY1j8ovpLwH01nBfv1S0T5J0nQfKCeQAEKUICKAAUoQAEqAhSgAAWoCFCAAhSgIsD/B7DJdZNcN5Liuu4eOyfjrwD9mwyA/aF7jmHgEbegGQBaAji+2HV3zF5BXn+QxUyYkxntSt40ZLR0+Kdc7n6NPXeQvFI0n417OYuTNKNu1MP69LHuYMZOoG/rnNv7sCUVXTcB2P7cU+hdoiv8d9kV2twWGusyACD3YUSqcMvcmgfeBdp6qoHe5pL1Z3WFp1zhgOM4Hf6czPh0miHJn/OiJHmohl7hBRo+/zY/Cc/aKzzjZ6A/JzMZ8I+CTnLrNcbS+PFSx0ms+SXG2G2zFnDGKzxxTmbsia19oRC4fAgdS7Ch68SJeY3bj+L0sll7g6/3x3qwH0i5Fyiqb3klkPj6XeODGsF+NDy7EvOOnq8dmftWrl0680RS8js5AlT0S0SAAhSgIkABClCAigAFKEABKgIUoAAFqAhQgAIUoCJAAQpQgIoABShAASoCFKAABagIUIACFKAARXBj+Qv/48Sw2eSa0QAAAABJRU5ErkJggg==";

/** Live end-to-end check with per-stage timings. */
export async function openaiProbe() {
  const cfg = getOpenAIConfig();
  const started = Date.now();
  const r = await openaiOcr(PROBE_PNG, cfg, { maxWaitMs: Math.min(cfg.maxWaitMs, 60000) });
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
    textFound: r.ok ? String(r.result.markdown || "").slice(0, 200) : null,
  };
}

/** Config summary for the /api/ocr GET health check. Never returns the key. */
export function openaiHealth() {
  const cfg = getOpenAIConfig();
  return {
    engine: "ChatGPT",
    configured: isOpenAIConfigured(cfg),
    keyPresent: Boolean(cfg.apiKey),
    keyLength: cfg.apiKey ? cfg.apiKey.length : 0,
    baseUrl: cfg.baseUrl,
    visionModel: cfg.visionModel,
    splitModel: cfg.splitModel,
    detail: cfg.detail,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    maxWaitMs: cfg.maxWaitMs,
    concurrency: cfg.concurrency,
    retries: cfg.retries,
    timeoutRetries: cfg.timeoutRetries,
    inFlight: gateActive,
    cost: "paid — billed per page against your OpenAI account",
    hint: "Add ?probe=1&engine=openai to run a live end-to-end test with per-stage timings.",
  };
}
