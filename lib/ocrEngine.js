/**
 * SlideBaba — OCR engine registry.
 *
 * One place that knows which engines exist, which are actually usable on this
 * server, and how a request's `engine` field maps onto them. Both /api/ocr and
 * /api/analyze import from here so the two routes can never disagree about what
 * "paddle" or "openai" means.
 *
 * Engines
 * -------
 *   "paddle"  PaddleOCR — free, runs on your own machine (PP-StructureV3).
 *             No per-page cost, no data leaves the machine, no rate limit.
 *   "openai"  ChatGPT — GPT-4o vision. Paid, hosted, rate-limited.
 *
 * Both produce the identical `{markdown, blocks, lines}` shape that
 * lib/ocrStructure.js consumes, so switching engines changes who reads the
 * pixels and nothing else.
 *
 * Selection order for one request:
 *   1. the `engine` field in the request body (what the Studio toggle sends)
 *   2. OCR_ENGINE_DEFAULT / NEXT_PUBLIC_OCR_ENGINE_DEFAULT
 *   3. "openai" — Model 1. It is hosted, so it works the moment the key is set, with
 *      no local server to start. Defaulting to Model 2 meant every new visitor landed
 *      on an engine that silently required a process running on the developer's own
 *      machine.
 *
 * "auto" means "the default engine, but fall through to the other one if the
 * default is not configured". A concrete engine name never falls through — if
 * you asked for ChatGPT you get ChatGPT or a clear error, not a silent swap.
 */

import { getPaddleConfig, isPaddleConfigured, paddleHealth, paddleReachable } from "@/lib/paddleocr";
import { getOpenAIConfig, isOpenAIConfigured, openaiHealth } from "@/lib/openaiOcr";

export const ENGINES = ["paddle", "openai"];

/* The names the UI shows. "Model 1" / "Model 2" are what the user picks between in the
   Studio, so server-side error messages use the same words — being told "PaddleOCR failed"
   when the button says "Model 2" is a needless puzzle. The technical name stays in the
   detail of each message, where it is useful for debugging. */
export const ENGINE_LABEL = {
  paddle: "Model 2 - Testing",
  openai: "Model 1",
};

/** Which underlying engine each model is, for messages that need to be specific. */
export const ENGINE_TECH = {
  paddle: "PaddleOCR",
  openai: "ChatGPT",
};

const ALIASES = {
  paddle: "paddle",
  paddleocr: "paddle",
  "paddle-ocr": "paddle",
  pp: "paddle",
  local: "paddle",
  free: "paddle",
  openai: "openai",
  chatgpt: "openai",
  gpt: "openai",
  "gpt-4o": "openai",
  gpt4o: "openai",
  chat: "openai",
};

/** Map anything the client might send onto a known engine id, or "" if unknown. */
export function normalizeEngine(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  if (v === "auto") return "auto";
  return ALIASES[v] || (ENGINES.includes(v) ? v : "");
}

/** The engine used when the request does not name one. */
/** The engine a visitor gets when they have not chosen one. */
export const BUILTIN_DEFAULT_ENGINE = "openai";

export function defaultEngine() {
  const fromEnv = normalizeEngine(
    process.env.OCR_ENGINE_DEFAULT || process.env.NEXT_PUBLIC_OCR_ENGINE_DEFAULT || ""
  );
  return fromEnv && fromEnv !== "auto" ? fromEnv : BUILTIN_DEFAULT_ENGINE;
}

/** Is this engine usable right now (keys / base URL present)? */
export function engineConfigured(engine) {
  if (engine === "paddle") return isPaddleConfigured(getPaddleConfig());
  if (engine === "openai") return isOpenAIConfigured(getOpenAIConfig());
  return false;
}

const NOT_CONFIGURED = {
  paddle:
    "Model 2 (PaddleOCR) is not configured on the server. Start the local server " +
    "(paddleocr-server/start-paddleocr.bat) and set PADDLE_OCR_BASE_URL=http://127.0.0.1:8080 " +
    "in .env.local — or switch to Model 1.",
  openai:
    "Model 1 (ChatGPT) is not configured on the server. Set OPENAI_API_KEY in .env.local, " +
    "or switch to Model 2, which runs on your own machine.",
};

/**
 * Decide which engine handles this request.
 *
 * @param {string} requested value of `engine` from the request body
 * @returns {{ok:true, engine:string, label:string, fellBack:boolean, from:string}
 *        | {ok:false, engine:string, error:string}}
 */
export function resolveEngine(requested) {
  const asked = normalizeEngine(requested);

  // Explicit choice — honour it exactly, or say why it cannot run.
  if (asked && asked !== "auto") {
    if (engineConfigured(asked)) {
      return { ok: true, engine: asked, label: ENGINE_LABEL[asked], fellBack: false, from: "request" };
    }
    return { ok: false, engine: asked, error: NOT_CONFIGURED[asked] };
  }

  // "auto" / unspecified — default first, then the other one.
  const order = [defaultEngine(), ...ENGINES.filter((e) => e !== defaultEngine())];
  for (const e of order) {
    if (engineConfigured(e)) {
      return {
        ok: true,
        engine: e,
        label: ENGINE_LABEL[e],
        fellBack: e !== order[0],
        from: asked === "auto" ? "auto" : "default",
      };
    }
  }

  return {
    ok: false,
    engine: order[0],
    error:
      "No OCR engine is configured. " + NOT_CONFIGURED.paddle + " " + NOT_CONFIGURED.openai,
  };
}

/** Which engines the browser may offer. Used by GET /api/ocr so the UI can grey one out. */
export function engineAvailability() {
  return {
    default: defaultEngine(),
    engines: ENGINES.map((id) => ({
      id,
      label: ENGINE_LABEL[id],
      configured: engineConfigured(id),
      free: id === "paddle",
    })),
  };
}

/** Full health for both engines (no secrets). */
export function enginesHealth() {
  return {
    ...engineAvailability(),
    paddle: paddleHealth(),
    openai: openaiHealth(),
  };
}

/**
 * Health plus a live "is anything actually listening?" check on the PaddleOCR URL.
 *
 * `configured` only means the .env values are present. That is not the question
 * people are usually asking when a scan fails — they want to know whether the
 * local server is UP. This answers that in about 2.5s without running an OCR.
 */
export async function enginesHealthLive() {
  const health = enginesHealth();
  let reachable = null;
  try { reachable = await paddleReachable(getPaddleConfig()); }
  catch (err) { reachable = { checked: true, reachable: false, reason: String(err?.message || err) }; }

  const paddleUp = !reachable?.checked || reachable?.reachable === true;
  return {
    ...health,
    paddle: { ...health.paddle, reachable },
    engines: health.engines.map((e) =>
      e.id === "paddle" ? { ...e, ready: e.configured && paddleUp } : { ...e, ready: e.configured }
    ),
  };
}
