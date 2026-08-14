import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/analyze
 * body: { title, sections: [{heading, body}] }
 * Splits content into DISCRETE verbatim items (one question/sub-part/point each),
 * preserving the FULL original text and LaTeX. Returns { items: [{ title, text }] }.
 */
export async function POST(request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY is not configured." }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const { title = "Untitled", sections = [] } = body || {};

  const system = `You are SlideBaba's slide splitter.
Split the provided document content into DISCRETE items so each becomes ONE slide.

CRITICAL — KEEP EVERYTHING, GROUP OPTIONS:
- Output ONE item per QUESTION or per independent SUB-QUESTION that has its own statement/stem (e.g. "प्रश्न 1", "प्रश्न 1 (क)", "Question 69", "Question 70").
- KEEP every question's answer options INSIDE that same item — whether they are labelled (a),(b),(c),(d) or (i),(ii),(iii),(iv). NEVER split a single question's options into separate items, and never drop options.
- Distinguish carefully: an OPTION is a short answer choice that follows a stem (keep it with the question); a SUB-QUESTION has its own statement/stem (make it its own item).
- There is NO limit on the number of items. Never cap the list (do not stop at 5, 10, or any number). If the paper has 40 questions, output 40 items.
- Preserve the FULL original text of each item VERBATIM — the question stem AND all of its options, each option on its own line. Do NOT summarize, shorten, paraphrase, translate, or merge items by topic.
- Keep the original language exactly (Hindi/Devanagari, English, etc.).

MATH:
- Keep ALL mathematics as complete LaTeX wrapped in $...$ (inline) or $$...$$ (display). Use any LaTeX commands/environments inside the delimiters.

FIELDS:
- "title" = a short label using the item's own number/heading when present (e.g. "प्रश्न 1 (क)", "Question 2", "निर्देश (iii)").
- "text" = the complete text of that item exactly as written, options included.
- Preserve original order.

Return ONLY minified JSON: {"items":[{"title":string,"text":string}]}. Include every item — do not truncate the array.`;

  const userContent = `Title: ${title}\n\nContent:\n${sections
    .map((s) => `${s.heading}\n${s.body}`)
    .join("\n\n")}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0,
        max_tokens: 16000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json({ ok: false, error: "OpenAI request failed", detail }, { status: 502 });
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { items: [] };
    }
    return NextResponse.json({ ok: true, items: parsed.items || [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: "Analyze failed", detail: String(err) }, { status: 500 });
  }
}
