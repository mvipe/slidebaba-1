import { NextResponse } from "next/server";
import { paddleOcr, paddleProbe, getPaddleConfig } from "@/lib/paddleocr";
import { openaiOcr, openaiProbe, getOpenAIConfig } from "@/lib/openaiOcr";
import { resolveEngine, enginesHealth, enginesHealthLive, normalizeEngine, ENGINE_LABEL } from "@/lib/ocrEngine";
import { buildDocument } from "@/lib/ocrStructure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300s (was 120). A dense page that truncates now makes one or more short "continue from
// where you stopped" calls to finish transcribing every question, so a single /api/ocr
// request can legitimately need more than two minutes. The per-page work is still bounded
// by OPENAI_MAX_WAIT_MS; this only stops the platform from killing the request first.
// (Hosts cap this to their own maximum — e.g. Vercel by plan tier — so it is a request,
// not a guarantee.)
export const maxDuration = 300;

/**
 * POST /api/ocr
 *   body: { image, name?, engine? }      image: data: URL, base64, or http(s) URL
 *                                        engine: "paddle" | "openai" | "auto"
 *   ->   { ok, title, sections:[{heading, body}], model, backend, engine, engineLabel }
 *
 * TWO ENGINES, ONE CONTRACT
 * -------------------------
 * PaddleOCR (free, local) and ChatGPT (paid, hosted) both return the same
 * normalized `{markdown, blocks, lines}` payload, and both are then structured by
 * the SAME function — `buildDocument()` in lib/ocrStructure.js. So the engine
 * decides who reads the pixels and nothing else: section splitting, option
 * grouping, LaTeX handling, titles, slide layout and export are identical either
 * way. That is what lets the toggle be a genuine A/B switch rather than two
 * different products.
 *
 * PaddleOCR (default)
 *   - PP-StructureV3: layout detection + text recognition + formula (LaTeX) +
 *     tables in one pass. A transcription model, not a chat model, so nothing can
 *     be paraphrased, translated or invented.
 *   - Runs on your own machine via paddleocr-server/. Free, unlimited, offline.
 *   - 100+ languages with per-block script detection (Hindi, Sanskrit, Urdu,
 *     Bengali, Tamil, English, mixed pages) with no language flag.
 *
 * ChatGPT
 *   - GPT-4o vision at temperature 0 with a strict transcription prompt.
 *   - Paid per page and rate-limited; better on messy handwriting, worse on the
 *     "never reword anything" guarantee, because a language model is writing.
 *
 * Failure handling is shared: a busy queue / rate limit / timeout comes back as
 * HTTP 200 + ok:false + retryable:true so the client's own backoff retries;
 * configuration and credential problems come back as 400 so it stops.
 */

const bad = (error, status = 200, extra = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status });

export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return bad("Invalid JSON body.", 400); }

  const { image, name, engine: requested, part, fast } = body || {};
  if (!image) return bad("Missing 'image' in request.", 400);

  const pick = resolveEngine(requested);
  if (!pick.ok) return bad(pick.error, 400, { engine: pick.engine, engineConfigured: false });

  const engine = pick.engine;
  const cfg = engine === "openai" ? getOpenAIConfig() : getPaddleConfig();

  // The Studio reads each page as a whole AND as overlapping high-resolution slices.
  // A slice must be transcribed without the model trying to invent the half it cannot
  // see, so the slice's position is passed through to the prompt. Sanitised here
  // because it goes straight into a prompt.
  const sliceInfo = part && Number.isFinite(Number(part.index)) && Number(part.total) > 1
    ? {
        index: Math.max(0, Math.min(19, Math.floor(Number(part.index)))),
        total: Math.max(2, Math.min(20, Math.floor(Number(part.total)))),
        kind: part.kind === "column" ? "column" : "band",
      }
    : null;

  // Fast lane unless the Studio explicitly asked for the accurate one. Defaulting to
  // fast matters: a scan that never finishes is worth less than a scan that is 98% right.
  const openaiOpts = { fast: fast !== false };
  if (sliceInfo) openaiOpts.part = sliceInfo;

  try {
    const run = engine === "openai"
      ? await openaiOcr(image, cfg, openaiOpts)
      : await paddleOcr(image, cfg);

    if (!run.ok) {
      if (cfg.debug) {
        console.log(`[SlideBaba/ocr:${engine}] failed:`, run.kind, run.stage, JSON.stringify(run.trace));
      }
      return bad(run.error, run.retryable ? 200 : 400, {
        retryable: !!run.retryable,
        kind: run.kind,
        stage: run.stage,
        trace: run.trace,
        engine,
        engineLabel: ENGINE_LABEL[engine],
      });
    }

    // ONE structurer for both engines — see the note above.
    const doc = buildDocument(run.result, name || "Untitled Document");

    if (!doc.sections.length) {
      // A SLICE may legitimately be blank — the bottom band of a half-empty page has
      // nothing on it. Reporting that as a failure made the client burn two pointless
      // retries per blank slice, which on a long PDF is minutes of nothing. A blank
      // whole page is still worth reporting.
      if (sliceInfo) {
        return NextResponse.json({
          ok: true, title: "", sections: [], empty: true,
          engine, engineLabel: ENGINE_LABEL[engine], part: sliceInfo,
        });
      }
      return bad(
        `${ENGINE_LABEL[engine]} could not read any text on this page. Try a clearer or higher-resolution scan.`,
        200,
        { retryable: true, engine, engineLabel: ENGINE_LABEL[engine] }
      );
    }

    return NextResponse.json({
      ok: true,
      title: doc.title || "Untitled Document",
      sections: doc.sections,
      part: sliceInfo,
      model: run.model || ENGINE_LABEL[engine],
      lane: run.lane || null,
      backend: run.backend,
      engine,
      engineLabel: ENGINE_LABEL[engine],
      fellBack: pick.fellBack,
      elapsedMs: run.elapsedMs,
      truncated: !!run.truncated,
    });
  } catch (err) {
    return bad(`Could not reach ${ENGINE_LABEL[engine]}: ` + String(err?.message || err), 200, {
      retryable: true,
      engine,
      engineLabel: ENGINE_LABEL[engine],
    });
  }
}

/**
 * GET /api/ocr                        — which engines exist and which are configured.
 * GET /api/ocr?probe=1                — live end-to-end test on the default engine.
 * GET /api/ocr?probe=1&engine=openai  — ...on a specific engine.
 * GET /api/ocr?probe=all              — both engines, so their timings can be compared.
 *
 * Never returns a key or a token.
 */
export async function GET(request) {
  let probe = null;
  let engineParam = null;
  let live = null;
  try {
    const q = new URL(request?.url || "http://localhost/api/ocr").searchParams;
    probe = q.get("probe");
    engineParam = q.get("engine");
    live = q.get("live");
  } catch { /* no query string */ }

  // Liveness is OPT-IN (?live=1).
  //
  // The liveness check pings PaddleOCR's local server, and when that server is not
  // running the ping costs up to 5 seconds. Doing it on every health call meant a
  // Model 1 user — who has nothing to do with PaddleOCR — paid for PaddleOCR being
  // down. Model 1 must never wait on Model 2 for anything.
  if (!probe) {
    const flag = String(live || "").toLowerCase();
    const wantLive = flag === "1" || flag === "true" || flag === "yes";
    return NextResponse.json({ ok: true, ...(wantLive ? await enginesHealthLive() : enginesHealth()) });
  }

  const health = enginesHealth();

  const runProbe = async (id) => {
    if (!health.engines.find((e) => e.id === id)?.configured) {
      return { ok: false, error: `${ENGINE_LABEL[id]} is not configured.` };
    }
    return id === "openai" ? openaiProbe() : paddleProbe();
  };

  if (String(probe).toLowerCase() === "all") {
    const [paddle, openai] = await Promise.all([runProbe("paddle"), runProbe("openai")]);
    return NextResponse.json({ ok: true, ...health, probe: { paddle, openai } });
  }

  const pick = resolveEngine(normalizeEngine(engineParam) || "auto");
  if (!pick.ok) return NextResponse.json({ ok: false, ...health, probe: { error: pick.error } });

  return NextResponse.json({
    ok: true,
    ...health,
    probeEngine: pick.engine,
    probe: await runProbe(pick.engine),
  });
}
