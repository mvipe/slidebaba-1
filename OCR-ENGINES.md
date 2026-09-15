# SlideBaba — two OCR engines, one pipeline

SlideBaba can scan a page with either engine, and the user picks in the Studio:

| | **PaddleOCR** | **ChatGPT** |
| --- | --- | --- |
| Cost | **Free** — no key, no per-page charge | Paid, billed to your OpenAI account |
| Runs | On your own machine | OpenAI's servers |
| Privacy | No page ever leaves the computer | Pages are uploaded |
| Limits | None | Rate limits + your credit balance |
| Speed (A4, CPU) | ~2–6 s/page after warm-up | ~4–10 s/page |
| Model | PP-StructureV3 (a transcription model) | GPT-4o vision (a language model) |
| Needs | `paddleocr-server` running | `OPENAI_API_KEY` |

The important design point: **the engine only decides who reads the pixels.**
Everything after that is the same code.

```
                       ┌──────────────────────────┐
  page image  ────────▶│  PaddleOCR   or  ChatGPT │
                       └────────────┬─────────────┘
                                    │  {markdown, blocks, lines}   ← same shape
                                    ▼
                     lib/ocrStructure.js  buildDocument()           ← same function
                                    │  {title, sections}
                                    ▼
                        /api/analyze  →  one item per question
                                    ▼
                        slide layout · editor · export              ← untouched
```

Because both adapters return the identical normalized payload and `/api/ocr`
calls the identical `buildDocument()` on it, switching engines is a genuine A/B
comparison of *reading accuracy*. Section splitting, option grouping, LaTeX
handling, titles, slide fitting and export cannot differ between them, because
there is only one copy of that code.

---

## Files

| File | Role |
| --- | --- |
| `lib/paddleocr.js` | PaddleOCR adapter. Local server, self-hosted, AI Studio deployment, or Baidu's hosted job API — auto-detected. |
| `lib/openaiOcr.js` | **new** — ChatGPT adapter. GPT-4o vision transcription + the GPT question splitter. A deliberate mirror of `paddleocr.js`. |
| `lib/ocrEngine.js` | **new** — the engine registry. One place that knows which engines exist, which are configured, and how `engine: "..."` resolves. |
| `lib/ocrStructure.js` | Turns either engine's output into `{title, sections}` and into one slide per question. Pure JS, no model, no network. **Shared.** |
| `app/api/ocr/route.js` | Routes a page to the chosen engine, then structures it. Health + probe for both engines. |
| `app/api/analyze/route.js` | Splits sections into slides — local rules for Paddle, ChatGPT (with a local safety net) for OpenAI. |
| `components/studio/Studio.js` | The engine toggle, per-engine tuning, and the `engine` field on every request. |
| `paddleocr-server/` | `server.py` + `start-paddleocr.bat` — run PaddleOCR on your own machine. See its README. |

---

## The toggle

It sits above the upload box in the Studio, shows which engine is free, and
remembers the choice in `localStorage` (`slidebaba.ocrEngine`).

On mount the Studio calls `GET /api/ocr`, which reports which engines the server
can actually run. An engine with no key/URL is greyed out with *"Not configured on
the server yet"* rather than being offered and then failing on page 1. If the
stored choice is an engine the server cannot run, the Studio silently moves to one
it can.

The choice travels as `engine: "paddle" | "openai"` on every `/api/ocr` and
`/api/analyze` call, so it is honoured per request — no server restart, no
per-account setting, and two people can use different engines at once.

### Per-engine tuning (`ENGINE_META` in `Studio.js`)

Not cosmetic — this is what makes both engines feel the same:

| | PaddleOCR | ChatGPT |
| --- | --- | --- |
| Pages in flight | 1 | 4 |
| Column tiles in flight | 1 | 3 |
| `/api/analyze` chunks in flight | 4 (local, free) | 3 (real GPT calls) |
| Upload size, 1st try | 1600px / q0.82 | 1600px / q0.82 |
| Retry sizes | 1400, 1150 | 1400, 1150 |
| Vision output ceiling | n/a | 16000 tokens, then continuation |

PaddleOCR holds one model in memory and is fastest when it is not fighting itself
for CPU, so one page at a time. The OpenAI API is happy with several pages in
flight — four at once (was two) roughly halves the wall-clock time of a multi-page
PDF, which is the main reason Model 1 used to feel slow. Any rate-limit (429) still
backs off and retries on its own, so four is safe on a normal tier; lower
`OPENAI_CONCURRENCY` if your account hits limits.

**Vision output ceiling + continuation (the accuracy fix).** A dense page — say 20
questions with options and LaTeX — can need more output tokens than one completion
is allowed. The old 8000-token ceiling was often hit, the model stopped with
`finish_reason: "length"`, and the *last several questions were silently dropped*
(the "20 in, 12–16 out" bug). The ceiling is now 16000, and if a page still
truncates, `lib/openaiOcr.js` asks the model to **continue from exactly where it
stopped** (it can still see the same image) and stitches the pieces together,
de-duplicating the seam — up to `OPENAI_MAX_CONTINUATIONS` times, always within the
request budget. Ordinary pages finish in one call and pay nothing extra; only a
genuinely oversized page makes a follow-up call.

---

## Setup

### PaddleOCR (free)

1. Double-click `paddleocr-server/start-paddleocr.bat`. It reuses the venv at
   `C:\Users\DELL\paddleocr-test\venv`.
2. **First time only**, it needs `pip install paddlepaddle paddleocr pillow`
   (~200 MB) and then downloads ~1 GB of models on the first scan. The script
   offers to do the pip install for you. Everything is offline after that.
3. `.env.local` already has:
   ```env
   PADDLE_OCR_BASE_URL=http://127.0.0.1:8080
   PADDLE_OCR_MODE=self
   ```
4. Leave the server window open while you scan.

`paddleocr-server/README.md` has every setting, the language/script fallback, and
the deployment caveat.

### ChatGPT (paid)

`OPENAI_API_KEY` in `.env.local` — that is all. Optional overrides:

```env
OPENAI_VISION_MODEL=gpt-4o        # page transcription
OPENAI_SPLIT_MODEL=gpt-4o-mini    # question splitting
OPENAI_VISION_DETAIL=high         # low | high | auto
OPENAI_MAX_TOKENS=16000           # output ceiling per page — high so dense pages aren't cut off
OPENAI_MAX_CONTINUATIONS=4        # extra "continue where you stopped" calls for a truncated page
OPENAI_CONCURRENCY=4              # pages read in parallel — higher = faster PDFs, more rate-limit risk
```

Leaving `OPENAI_API_KEY` empty hides the ChatGPT option in the Studio entirely.

### Which is the default

```env
OCR_ENGINE_DEFAULT=paddle
NEXT_PUBLIC_OCR_ENGINE_DEFAULT=paddle
```

`paddle` on purpose: an install that has not been configured should never
silently start billing someone. On a deployed site (see the Vercel caveat in
`paddleocr-server/README.md`), set this to `openai`.

---

## Diagnosing

| URL | What it does |
| --- | --- |
| `/api/ocr` | which engines exist, which are configured, and the full config of each — never a key or token |
| `/api/ocr?probe=1` | runs a **real OCR** on a ~1 KB built-in image using the default engine, with per-stage timings |
| `/api/ocr?probe=1&engine=openai` | the same on a named engine |
| `/api/ocr?probe=all` | **both engines side by side** — the fastest way to see which is actually slow |
| `/api/analyze` | which splitter each engine would use right now |
| `http://127.0.0.1:8080/health` | the local PaddleOCR server's own status, and whether warm-up finished |

The probe image is deliberately tiny, so it separates *"the upload is slow"* from
*"the service is slow"* from *"the queue is full"*:

```json
"trace": [{ "stage": "layout-parsing", "status": 200, "ms": 340, "timeout": false }]
```

---

## Failure classes

Both adapters classify failures the same four ways, because they need opposite
handling and because reporting the wrong one sends you debugging the wrong thing:

| Class | PaddleOCR | ChatGPT | What happens |
| --- | --- | --- | --- |
| `throttle` | shared queue full (`任务提交队列已满`) | HTTP 429 rate limit | exponential backoff + jitter, then the next backend/model |
| `timeout` | no answer in budget | no answer in budget | retried **once**, then reports the stage and elapsed time |
| `quota` | daily 3,000 pages gone | `insufficient_quota` — no credit | never retried; reported immediately |
| `fatal` | bad token, bad request | bad key (401), bad request (400) | reported immediately, never retried |

A timeout is **not** a queue-full. Retryable failures come back as
`HTTP 200 + ok:false + retryable:true`, so the client's own retry-with-backoff
gets another set of attempts; configuration and credential errors come back as
`400`, which is the client's signal to stop.

---

## Splitting (`/api/analyze`)

**PaddleOCR → the local rules splitter.** Plain JavaScript in
`lib/ocrStructure.js`: no model, no network, no output-token ceiling. A
40-question paper produces 40 items, always, in milliseconds, for free.

**ChatGPT → GPT splits, with the local splitter standing by.** A language model
handles ragged, unlabelled or narrative pages better than regexes do. But it can
rate-limit, and it can run out of output tokens mid-array, which silently drops
the last questions. So the route refuses a GPT answer when:

- `finish_reason` is `"length"` — the JSON was cut off,
- the returned items contain **less than 75 % of the source text** — the model
  summarised or dropped options,
- the call failed for any other reason.

In each case it falls back to the local splitter and returns
`splitter: "local-rules", fellBack: true, note: "..."`. **ChatGPT mode is
therefore never less complete than PaddleOCR mode** — the worst case is that it
costs a call and gives you the free result anyway.

### How the local splitter works

1. **Layout first.** PaddleOCR's `parsing_res_list` blocks carry semantic labels:
   `doc_title` becomes the document title, `paragraph_title` forces a section
   boundary, `formula` is wrapped in `$$…$$`, tables are kept verbatim, and
   running heads / footers / page numbers are dropped. Blocks are ordered
   top-to-bottom and column-aware. If blocks are missing or thin, the markdown is
   used instead; if that is missing too, the raw recognised lines are. (ChatGPT
   returns markdown, so it enters at the second step — the same code path.)
2. **Rules.** A script-aware pass splits into one section per question or
   sub-question: `प्रश्न 1`, `प्रश्न 1 (क)`, `Q2`, `Question 70`, `12.`, `سوال 1`.
3. **Options stay with their question.** `(A)(B)(C)(D)`, `(क)(ख)(ग)(घ)`,
   `(i)(ii)(iii)(iv)`, `(1)(2)(3)(4)` and `(अ)(ब)(स)(द)` are detected as an
   *ascending run in one family with a consistent bracket style*. That is what
   separates the question number `1.` from the `(A)` under it, and why option
   `(D)` can never be dropped. Options printed on one line are split onto their
   own lines; an options-only fragment is merged back into the question above it.
4. **Sub-questions are not options.** A short labelled run under one stem is
   options; long labelled paragraphs each with their own stem become their own
   slides, titled `प्रश्न 3 (क)`.

Everything is verbatim. Nothing is summarised, reworded, translated or capped.

---

## Accuracy — what each engine is actually good at

**PaddleOCR**

- **It is a transcription model, not a chat model.** It detects layout, reads
  text, and emits maths as LaTeX and tables as markup in one pass. Because no
  language model writes the output, text cannot be paraphrased, translated,
  "corrected" or hallucinated.
- **All languages, no flag.** 100+ languages with per-block script detection:
  Hindi, Sanskrit, English, Urdu, Bengali, Tamil, Telugu, Gujarati, Marathi,
  Arabic, CJK — including mixed pages. Devanagari conjuncts, matras, nukta and
  Devanagari digits come back as printed. The local server reads each page in
  `PADDLE_LANG` and re-reads it in `PADDLE_FALLBACK_LANG` when confidence is
  poor, keeping the better result.
- **Scan-tolerant.** Document-orientation and text-line-orientation correction
  are on by default, so rotated phone photos read correctly. `PADDLE_UNWARP=1`
  for curved or hand-held pages.
- Weaker on messy handwriting and on very low-contrast photocopies.

**ChatGPT**

- Better on **handwriting**, smudged photocopies, and pages whose structure is
  implied rather than printed.
- The prompt in `lib/openaiOcr.js` is written to suppress the failure mode of a
  language model doing OCR: temperature 0, and explicit rules against
  translating, correcting, summarising, answering, or dropping options. Output is
  markdown, so it enters the shared structurer at exactly the point PaddleOCR's
  markdown does.
- Refusals and "I can't read this" answers are detected and reported as an
  unreadable page rather than being passed downstream as slide text.
- Still a language model: it *can* quietly normalise a spelling. If verbatim
  fidelity matters more than handwriting, PaddleOCR is the safer engine.

---

## Cost

PaddleOCR: **₹0.** Electricity.

ChatGPT: one GPT-4o vision call per page at `detail: "high"` (roughly 1–2k input
tokens for the image plus the transcription tokens out), and one `gpt-4o-mini`
call per 14-section analyze chunk. Check current pricing at
<https://openai.com/api/pricing> — it changes, and a 40-page paper is 40 vision
calls, not one.

A page dense enough to truncate makes one or more **continuation** calls on top of
its first read (each re-sends the image, so it costs like another page). This only
happens on genuinely oversized pages, and it is the deliberate trade: a few extra
tokens on the hardest pages, in exchange for never dropping their last questions.
Cap it with `OPENAI_MAX_CONTINUATIONS`.
