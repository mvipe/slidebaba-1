import { NextResponse } from "next/server";
import { splitSectionsIntoItems } from "@/lib/ocrStructure";
import { openaiSplit, getOpenAIConfig } from "@/lib/openaiOcr";
import { resolveEngine, ENGINE_LABEL } from "@/lib/ocrEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/analyze
 *   body: { title, sections:[{heading, body}], engine? }
 *   ->    { ok, items:[{title, text}], engine, splitter }
 *
 * Splits content into DISCRETE items — one question / sub-question per slide —
 * keeping the FULL original text, every answer option, and all LaTeX intact.
 *
 * TWO SPLITTERS
 * -------------
 * engine "paddle"  -> the local rules splitter (lib/ocrStructure.js).
 *   Plain JavaScript, no model, no network. Nothing can be summarised, translated
 *   or invented; there is no output-token ceiling, so a 40-question paper always
 *   produces 40 items; it is instant and free.
 *
 * engine "openai"  -> ChatGPT splits, with the local splitter as a safety net.
 *   A language model handles ragged, unlabelled or narrative pages better than
 *   regexes do. But it can rate-limit, and it can run out of output tokens
 *   mid-array — which silently drops the last questions. So:
 *     - a `finish_reason: "length"` answer is REJECTED rather than trusted,
 *     - any failure falls through to the local splitter,
 *     - an item list that lost more than a quarter of the source text is
 *       rejected too, because a "helpful" summary is worse than no model at all.
 *   The result is that ChatGPT mode is never *less* complete than Paddle mode.
 *
 * Either way the response shape is identical, so components/studio/Studio.js and
 * the editor do not care which ran.
 *
 * Rules used by the local splitter (script-aware — Devanagari, Latin, Urdu, ...):
 *   - ONE item per question or per sub-question that has its own stem
 *     (प्रश्न 1, प्रश्न 1 (क), Q2, Question 70, "12." ...).
 *   - Answer options — (A)(B)(C)(D), (क)(ख)(ग)(घ), (i)(ii)(iii)(iv), (1)(2)(3)(4) —
 *     are detected as a run and kept INSIDE their own question, one per line.
 *   - Options split across a line are re-joined; an options-only fragment is
 *     merged back into the question above it, so option (D) can never be dropped.
 *   - No cap on the number of items, and original order is preserved.
 */

/** Visible characters, ignoring whitespace — used to detect a lossy model answer. */
const weight = (s) => String(s || "").replace(/\s+/g, "").length;

const sourceWeight = (sections) =>
  (Array.isArray(sections) ? sections : []).reduce(
    (n, s) => n + weight(s?.heading) + weight(s?.body),
    0
  );

const itemsWeight = (items) =>
  (Array.isArray(items) ? items : []).reduce((n, it) => n + weight(it?.text), 0);

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const { title = "Untitled", sections = [], engine: requested } = body || {};

  if (!Array.isArray(sections)) {
    return NextResponse.json({ ok: false, error: "'sections' must be an array." }, { status: 400 });
  }

  // The local splitter needs no configuration, so an unconfigured/unknown engine
  // is never a reason to fail this route — it just means "split locally".
  const pick = resolveEngine(requested);
  const engine = pick.ok ? pick.engine : "paddle";

  // ---- local splitter: always computed, both as the answer and as the safety net ----
  let local;
  try {
    local = splitSectionsIntoItems(title, sections);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "Analyze failed", detail: String(err?.message || err) },
      { status: 500 }
    );
  }

  // The local rules splitter is deterministic and complete — it cannot truncate, drop a
  // question, or summarise, and it now handles numbered lists, headings-as-stems and every
  // option style. The GPT splitter can silently lose text, so it is OFF by default and only
  // used when explicitly enabled with OPENAI_USE_GPT_SPLIT=1. Model 1 still uses GPT to READ
  // the page (the vision step); only the splitting into slides is kept local for reliability.
  const useGptSplit = /^(1|true|yes|on)$/i.test(String(process.env.OPENAI_USE_GPT_SPLIT || ""));
  if (engine !== "openai" || !useGptSplit) {
    return NextResponse.json({ ok: true, items: local, engine, splitter: "local-rules" });
  }

  // ---- ChatGPT splitter (opt-in), with the local result standing by ----
  let note = "";
  try {
    const run = await openaiSplit(title, sections, getOpenAIConfig());

    if (run.ok) {
      const src = sourceWeight(sections);
      const got = itemsWeight(run.items);
      // A model that returns a quarter less text than it was given has summarised,
      // dropped options, or truncated. Verbatim is the whole point — reject it.
      if (src > 0 && got < src * 0.75) {
        note = "ChatGPT's split dropped text, so the local splitter was used instead.";
      } else {
        return NextResponse.json({
          ok: true,
          items: run.items,
          engine: "openai",
          engineLabel: ENGINE_LABEL.openai,
          splitter: "chatgpt",
          model: run.model,
          elapsedMs: run.elapsedMs,
        });
      }
    } else {
      note = run.error || "ChatGPT could not split this batch.";
    }
  } catch (err) {
    note = String(err?.message || err);
  }

  // Fall back rather than fail: the user still gets complete, verbatim slides.
  return NextResponse.json({
    ok: true,
    items: local,
    engine: "openai",
    engineLabel: ENGINE_LABEL.openai,
    splitter: "local-rules",
    fellBack: true,
    note,
  });
}

/** GET /api/analyze — which splitter each engine would use right now. */
export async function GET() {
  const openaiReady = resolveEngine("openai").ok;
  return NextResponse.json({
    ok: true,
    splitters: {
      paddle: { splitter: "local-rules", configured: true, free: true },
      openai: { splitter: openaiReady ? "chatgpt" : "local-rules (not configured)", configured: openaiReady, free: false },
    },
    note: "ChatGPT splits always fall back to the local rules splitter on failure or truncation, so items are never lost.",
  });
}
