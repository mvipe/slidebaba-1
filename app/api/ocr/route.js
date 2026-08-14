import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/ocr  body: { image }
 * Vision OCR -> { title, sections: [{heading, body}] }
 *
 * Accuracy setup:
 *  - The client sends ONE COLUMN / TILE per request (dense two-column pages are split),
 *    so each character has far more pixels than a whole-page image would.
 *  - Model is configurable: OPENAI_OCR_MODEL (default gpt-4.1, auto-falls back to gpt-4o).
 *  - Optional proof-reading pass: OCR_VERIFY=1 (best accuracy; ~2x cost/time).
 *  - temperature 0 + detail:"high" + strict Devanagari/LaTeX rules + anti-fabrication rules.
 */

const MODELS = [process.env.OPENAI_OCR_MODEL, "gpt-4.1", "gpt-4o"].filter(Boolean);

const SYSTEM = `You are SlideBaba Vision OCR, an expert transcriber of Indian exam papers and textbooks. You transcribe with the care of a proof-reader: the output must match the image CHARACTER FOR CHARACTER. The image is often dense, in Hindi / Sanskrit / English (or a mix), and full of mathematics.

ABSOLUTE RULES
1. TRANSCRIBE, NEVER TRANSLATE, NEVER TRANSLITERATE, NEVER PARAPHRASE, NEVER "CORRECT".
   - Hindi and Sanskrit stay in Devanagari. English stays in Latin. Do not convert between scripts.
   - Do not modernise or fix spelling, grammar, or arithmetic — copy exactly what is printed, mistakes included.
2. NEVER FABRICATE. Transcribe ONLY what is actually printed and legible. If a word, number, option or whole question is unreadable, blurred, or cut off at an edge, transcribe only the readable part — do NOT guess a plausible replacement and do NOT invent a different question. It is better to output a shorter, faithful line than a complete but wrong one.
3. COMPLETENESS (within what is visible): read top to bottom — every instruction, question, sub-part ((क)(ख)(ग)(घ) / (a)(b)(c) / 1,2,3) and EVERY option. Multiple-choice questions almost always have FOUR options (A)(B)(C)(D) — you MUST include ALL FOUR, especially the LAST option (D), which is the one most often dropped. NEVER stop at (C). Also capture any printed answer line like "उत्तर-(B)" and marks like [2]. Never summarise, never write "..." or "and so on".

DEVANAGARI PRECISION (this is where most mistakes happen — slow down)
- Reproduce every conjunct/संयुक्ताक्षर exactly: क्ष त्र ज्ञ श्र द्ध द्व त्त न्न क्त प्र ह्म ट्ट श्च स्त्र etc.
- Reproduce every matra exactly: ा ि ी ु ू ृ े ै ो ौ  (note ि is typed after but reads before its consonant).
- Reproduce halant/virama (्), anusvara (ं), chandrabindu (ँ), visarga (ः), avagraha (ऽ), nukta (क़ ख़ ग़ ज़ ड़ ढ़ फ़), and ॐ.
- Keep dandas: । and ॥. Keep Devanagari digits (०१२३४५६७८९) as Devanagari and Latin digits as Latin — never swap.
- Sanskrit: preserve sandhi, samasa and vedic svara marks as printed; keep ऋ ॠ ऌ.
- Watch look-alike letters carefully: व/ब, घ/ध, भ/म, थ/य, ङ/ड, ऋ/ॠ, प/ष, ट/ठ, इ/ई, उ/ऊ, ए/ऐ, ो/ौ, and क्षेत्रफल vs परिधि (do not swap area/perimeter words).

MATHEMATICS (must be valid, renderable LaTeX)
- Inline math in $...$, display math in $$...$$. EVERY mathematical expression, symbol, fraction, root, power, derivative or option that contains math MUST be wrapped in $...$ — including standalone answer options like "$-\\frac{1}{2\\sqrt{x}}$". Never output bare LaTeX commands (\\frac, \\lim, \\sqrt, ^, _) outside $...$. Mixed lines are normal: keep the Devanagari/English words as plain text and wrap ONLY the math in $...$.
- Subscripts/superscripts are critical — always brace them: A_{12} (never A12 or A_1 2), x^{2}, a_{n+1}, r^{2}, CO_{2}.
- Use real LaTeX: \\frac{a}{b}, \\sqrt{x}, \\sqrt[3]{x}, \\sum_{i=1}^{n}, \\int_{a}^{b}, \\lim_{x \\to 0}, \\alpha \\beta \\theta \\pi, \\sin \\cos \\tan \\log, \\le \\ge \\ne \\approx \\pm \\times \\div \\cdot, \\angle, \\triangle, ^{\\circ}, \\begin{cases}, \\begin{bmatrix}, \\begin{aligned}.
- Disambiguate: multiplication \\times vs variable x vs \\cdot; minus − vs hyphen -; ratio a:b; prime a^{\\prime}; degree ^{\\circ}; keep implicit products (5x, 2ab). Copy equation labels like (1),(2) as plain text.

STRUCTURE
- "title": the paper/document title if present, else a short sensible one.
- "sections": ONE object per question or sub-part so nothing is grouped away — heading like "प्रश्न 1", "प्रश्न 1 (क)", "Q2", "Q2 (iii)".
- In "body", keep the question stem and all its options, each on its own line (use \\n between lines).

Return ONLY minified JSON: {"title": string, "sections": [{"heading": string, "body": string}]}`;

const USER_TEXT = "Transcribe this ENTIRE image into structured JSON exactly as instructed, from the very top to the very bottom — do not stop early. For EVERY multiple-choice question include ALL FOUR options (A)(B)(C)(D); the last option (D) is the one most often missed, so double-check you included it. If part of an edge is cut off, transcribe only what is fully visible and never guess. Copy character for character. Keep Devanagari in Devanagari and all mathematics as valid LaTeX.";

const VERIFY_TEXT = `Below is a first-pass transcription of the SAME image. Proof-read it against the image and return a CORRECTED version in the identical JSON shape.

Check especially:
- FABRICATION: any line that does not actually match the image must be corrected or removed. Do not keep invented questions/options.
- missing questions, sub-parts, options or lines that are clearly visible (add them),
- Devanagari matras, conjuncts, halant, anusvara, nukta and look-alike letters (व/ब, घ/ध, भ/म, ङ/ड; क्षेत्रफल vs परिधि),
- subscripts/superscripts and LaTeX validity,
- digits (Devanagari vs Latin) and punctuation (। ॥).

Do not translate, do not rewrite style, do not add anything not in the image. If the first pass is already correct, return it unchanged.

FIRST PASS:
`;

async function callOpenAI(key, model, messages, maxTokens) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0, top_p: 1, max_tokens: maxTokens, response_format: { type: "json_object" }, messages }),
  });
  if (res.ok) return { ok: true, data: await res.json() };
  let detail = "";
  try { const j = await res.json(); detail = j?.error?.message || JSON.stringify(j?.error || j); }
  catch { try { detail = await res.text(); } catch {} }
  return { ok: false, status: res.status, detail };
}

const isModelMissing = (r) => (r.status === 404 || r.status === 400) && /model|does not exist|not found|unsupported/i.test(r.detail || "");

function parseJson(raw, fallbackTitle = "Untitled Document") {
  try { return JSON.parse(raw || "{}"); }
  catch { return { title: fallbackTitle, sections: [{ heading: "Content", body: String(raw || "") }] }; }
}

export async function POST(request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ ok: false, error: "OPENAI_API_KEY is not configured on the server." }, { status: 200 });

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 }); }

  const { image } = body || {};
  if (!image) return NextResponse.json({ ok: false, error: "Missing 'image' in request." }, { status: 400 });

  const baseMessages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: [
      { type: "text", text: USER_TEXT },
      { type: "image_url", image_url: { url: image, detail: "high" } },
    ] },
  ];

  try {
    let result = null, lastErr = null, used = null;
    for (const model of MODELS) {
      const r = await callOpenAI(key, model, baseMessages, 16000);
      if (r.ok) { result = r.data; used = model; break; }
      lastErr = r;
      if (!isModelMissing(r)) break;
    }
    if (!result) {
      return NextResponse.json({ ok: false, error: `OpenAI error (${lastErr?.status || "?"}): ${lastErr?.detail || "request failed"}` }, { status: 200 });
    }

    let parsed = parseJson(result?.choices?.[0]?.message?.content);

    if (process.env.OCR_VERIFY === "1") {
      const verify = await callOpenAI(key, used, [
        { role: "system", content: SYSTEM },
        { role: "user", content: [
          { type: "text", text: VERIFY_TEXT + JSON.stringify(parsed) },
          { type: "image_url", image_url: { url: image, detail: "high" } },
        ] },
      ], 16000);
      if (verify.ok) {
        const fixed = parseJson(verify.data?.choices?.[0]?.message?.content, parsed.title);
        if (Array.isArray(fixed.sections) && fixed.sections.length) parsed = fixed;
      }
    }

    return NextResponse.json({
      ok: true,
      title: parsed.title || "Untitled Document",
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      model: used,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: "Could not reach OpenAI: " + String(err?.message || err) }, { status: 200 });
  }
}
