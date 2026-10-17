/**
 * SlideBaba — Google Gemini OCR engine ("Model 3 - Gemini (Testing)").
 *
 * TESTING ENGINE. Added to compare Gemini Flash against Model 1 on real pages; it is
 * never picked automatically (lib/ocrEngine.js keeps it out of the "auto" fallback).
 *
 *   geminiOcr(image, cfg)   ->  { ok, result:{markdown, blocks, lines}, ... }
 *
 * Same normalized shape as openaiOcr()/paddleOcr(), so buildDocument() structures it
 * with the identical code path. It sends Gemini the SAME transcription rules Model 1
 * uses (VISION_SYSTEM from lib/openaiOcr.js), so a difference in the result is a
 * difference in who read the page, not in what they were told.
 *
 * Environment
 * -----------
 *   GEMINI_API_KEY        required (free key: https://aistudio.google.com -> Get API key)
 *   GEMINI_MODEL          default: gemini-flash-latest  (gemini-2.5-flash is closed to new keys)
 *   GEMINI_MAX_TOKENS     default: 8192
 *   GEMINI_TIMEOUT_MS     default: 90000
 *   GEMINI_DEBUG          1|0
 *
 * Free tier: a few requests per minute and a small daily allowance. A per-minute 429
 * is waited out once (Google says how long); a per-day 429 is reported as "limit
 * reached" and not retried. On the free tier Google may use the pages to improve its
 * products — test with sample papers.
 */

import { readImageInput } from "@/lib/imageInput";
import { VISION_SYSTEM, cleanTranscript, transcriptIsUseless } from "@/lib/openaiOcr";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

const pickEnv = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
};
const num = (name, dflt, min) => {
  const v = Number(pickEnv(name));
  return Number.isFinite(v) && v > 0 ? Math.max(min, v) : dflt;
};

export function getGeminiConfig() {
  return {
    apiKey: pickEnv("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    model: pickEnv("GEMINI_MODEL") || "gemini-flash-latest",
    maxTokens: num("GEMINI_MAX_TOKENS", 8192, 1000),
    timeoutMs: num("GEMINI_TIMEOUT_MS", 90000, 15000),
    debug: /^(1|true|yes|on)$/i.test(pickEnv("GEMINI_DEBUG")),
  };
}

export function isGeminiConfigured(cfg = getGeminiConfig()) {
  return Boolean(cfg.apiKey);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* One page at a time per server process — the free tier allows only a few per minute. */
let busy = Promise.resolve();
function oneAtATime(fn) {
  const run = busy.then(fn, fn);
  busy = run.catch(() => {});
  return run;
}

async function post(cfg, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey },
      body: JSON.stringify(body),
      signal: ac.signal,
      cache: "no-store",
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json, ms: Date.now() - started };
  } catch (e) {
    const timeout = e?.name === "AbortError";
    return { ok: false, status: timeout ? 408 : 0, json: null, timeout, error: String(e?.message || e), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Seconds Google asks us to wait on a per-minute 429, if it says. */
function retryDelayMs(json) {
  const info = (json?.error?.details || []).find((d) => String(d["@type"] || "").includes("RetryInfo"));
  const s = parseFloat(String(info?.retryDelay || "").replace(/s$/, ""));
  return Number.isFinite(s) && s > 0 ? Math.ceil(s * 1000) : 0;
}

const isDailyLimit = (json) => /per ?day|PerDay|daily/i.test(JSON.stringify(json?.error || ""));

const fail = (status, error, retryable, extra = {}) => ({
  ok: false, status, error, retryable, kind: retryable ? "throttle" : "fatal", stage: "vision", trace: [], ...extra,
});

/**
 * Read one page image with Gemini.
 * @returns same contract as openaiOcr().
 */
export async function geminiOcr(image, cfgIn) {
  const cfg = cfgIn || getGeminiConfig();
  const started = Date.now();

  if (!isGeminiConfigured(cfg)) {
    return fail(400, "Model 3 (Gemini) is not configured. Set GEMINI_API_KEY in .env.local.", false);
  }

  let input;
  try { input = readImageInput(image); }
  catch (e) { return fail(400, String(e?.message || e), false); }
  if (input.isUrl || input.fileType === 0) {
    return fail(400, "Model 3 (Gemini) reads page images sent from the Studio, not URLs or PDFs.", false);
  }

  const generationConfig = { temperature: 0, maxOutputTokens: cfg.maxTokens };
  // Flash models "think" by default — slower, and billed as output. Copying text needs
  // little of it: 2.5 takes a token budget, Gemini 3+ (and the *-latest aliases) a level.
  generationConfig.thinkingConfig = /^gemini-2\./i.test(cfg.model)
    ? { thinkingBudget: 0 }
    : { thinkingLevel: "low" };

  const body = {
    systemInstruction: { parts: [{ text: VISION_SYSTEM }] },
    contents: [{
      role: "user",
      parts: [
        { text: "Transcribe this page verbatim as markdown, following every rule above." },
        { inline_data: { mime_type: input.mime || "image/jpeg", data: input.base64 } },
      ],
    }],
    generationConfig,
  };

  return oneAtATime(async () => {
    let r = await post(cfg, body);

    // Per-minute limit: wait the time Google names (once), then try again.
    if (r.status === 429 && !isDailyLimit(r.json)) {
      const wait = Math.min(45000, retryDelayMs(r.json) || 15000);
      if (cfg.debug) console.log(`[SlideBaba/gemini] 429 per-minute — waiting ${wait}ms`);
      await sleep(wait);
      r = await post(cfg, body);
    }

    const elapsedMs = Date.now() - started;
    const trace = [{ stage: "vision", status: r.status, ms: r.ms, timeout: !!r.timeout }];
    const detail = r.json?.error?.message || r.error || `HTTP ${r.status}`;

    if (!r.ok) {
      if (r.status === 429) {
        return isDailyLimit(r.json)
          ? fail(429, "Gemini free daily limit reached. Try again tomorrow, or test with fewer pages.", false, { kind: "quota", trace, elapsedMs })
          : fail(429, `Gemini is busy (rate limit): ${detail}`, true, { trace, elapsedMs });
      }
      if (r.timeout) return fail(408, `Gemini did not answer within ${Math.round(cfg.timeoutMs / 1000)}s.`, true, { kind: "timeout", trace, elapsedMs });
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        return fail(r.status, `Gemini rejected the request (${r.status}): ${detail}. Check GEMINI_API_KEY in .env.local.`, false, { trace, elapsedMs });
      }
      if (r.status === 404) {
        return fail(404, `Gemini model "${cfg.model}" was not found. Set GEMINI_MODEL in .env.local (e.g. gemini-flash-latest).`, false, { trace, elapsedMs });
      }
      return fail(r.status || 502, `Gemini error (${r.status || "network"}): ${detail}`, true, { kind: "transient", trace, elapsedMs });
    }

    const blocked = r.json?.promptFeedback?.blockReason;
    if (blocked) return fail(200, `Gemini refused this page (${blocked}).`, false, { trace, elapsedMs });

    const cand = r.json?.candidates?.[0];
    const raw = (cand?.content?.parts || []).map((p) => p.text || "").join("");
    const markdown = cleanTranscript(raw);
    if (transcriptIsUseless(markdown)) {
      const why = cand?.finishReason && cand.finishReason !== "STOP" ? ` (${cand.finishReason})` : "";
      return fail(200, `Gemini could not read any text on this page${why}. Try a clearer scan.`, false, { trace, elapsedMs });
    }

    if (cfg.debug) console.log(`[SlideBaba/gemini] ok ${elapsedMs}ms`, r.json?.usageMetadata);

    return {
      ok: true,
      result: { markdown, blocks: [], lines: [] },
      backend: "gemini",
      model: r.json?.modelVersion || cfg.model,
      truncated: cand?.finishReason === "MAX_TOKENS",
      usage: r.json?.usageMetadata,
      trace,
      elapsedMs,
    };
  });
}

/** Config summary for GET /api/ocr. Never returns the key. */
export function geminiHealth() {
  const cfg = getGeminiConfig();
  return {
    engine: "Gemini",
    configured: isGeminiConfigured(cfg),
    keyPresent: Boolean(cfg.apiKey),
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    cost: "testing — free tier is rate-limited and Google may use free-tier inputs to improve its products",
  };
}
