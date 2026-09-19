# SlideBaba — accuracy + page-limit fix

Six files changed. Every one is complete and paste-ready; drop them over the
originals, apply `ENV-ACCURACY.txt`, restart.

```
lib/openaiOcr.js            rewritten
lib/imageCrop.js            rewritten
lib/plan.js                 rewritten
components/studio/Studio.js rewritten
context/AuthContext.js      one block changed
app/api/ocr/route.js        two blocks changed
ENV-ACCURACY.txt            new — the .env.local edits
```

Verified with a full `next build` — 23 routes compile, no warnings from the
changed files.

---

## 1. "Above 50 pages it says Try again"

It was never a plan limit. It was the browser running out of image memory.

`pdfToPageImages` rendered **every** page at 2.4x up front and kept each one as
a full-resolution JPEG data URL in a React state array. A data URL is a
JavaScript string, and strings are UTF-16 — 2 bytes per character. A 100-page
paper is ~80 MB of base64, so ~160 MB of live strings, plus every canvas backing
store, held for the entire scan. Somewhere past 50 pages Chrome starts refusing
canvas allocations: `toDataURL` returns a blank image or `render` throws, the
whole upload lands in the catch block, and the user sees
*"Couldn't read that file… Try again"*. It looked exactly like a plan limit,
which is why it got reported as one.

**Fixed:**

- `openPdf()` renders pages **on demand**. The Studio processes them in a window
  of 4, scans them, drops them, moves on. Peak memory is now a handful of pages
  whether the PDF is 5 pages or 200.
- Every canvas is explicitly released (`width = height = 0`). Dropping the
  reference is not enough — the pixel buffer lives outside the JS heap and the GC
  gets to it far too late in a long render loop.
- If a page genuinely cannot be rendered, it now says *"the browser ran out of
  image memory"* instead of a generic failure.

## 2. The plan limits themselves

Two real bugs on top of the memory one.

**a) The slide cap cancelled the page allowance.** `maxSlidesPerDoc` was set
equal to `maxPages` — Basic allowed 100 pages *and* 100 slides. But an exam page
carries 3–8 questions and every question becomes its own slide, so a 25-page
paper already blew past 100 slides and got refused. The advertised page
allowance was unreachable. Slides per document are now sized for what a page
actually yields (~12 per allowed page): Free 150, Basic 1200, Medium 1800,
High 2400. The **page** limit is now the one a user actually meets, exactly as
the pricing page says.

**b) Every new free account had a limit of zero.** Registration wrote
`docsLimit: 0`, and `remaining()` read `profile.docsLimit ?? planDefault` — `??`
keeps a stored zero. So a brand-new user saw the payment modal on their very
first upload, before scanning anything. Registration now writes the free plan's
own allowance, and `remaining()` ignores a stored zero. `maybeRenew()` repairs
existing accounts on their next login.

**c) The block message now names the limit that actually fired.** There is one
gate — `checkDocumentLimits()` — and one modal, and it says *pages*, *slides* or
*documents used up*, with the real numbers. The old modal could only ever say
"page limit", so a slide-count block or an exhausted credit read as a page
problem.

The page gate also runs **before a single page is rendered**, off the PDF's own
page count. An over-limit file now costs nothing: no Firestore document, no
credit, no OCR call.

## 3. OCR accuracy

Three separate things were costing accuracy.

**a) The model.** Pinned to `gpt-4o`. At `detail: "high"` that model shrinks the
page so its **shortest** side is 768px — an A4 page ends up ~768x1086, about
90 DPI. A Devanagari matra is a pixel or two at that size, which is exactly why
Hindi papers came back with wrong matras and missing options. Default is now
`gpt-6-astra`, which accepts the image at its **original dimensions**.

**b) Parameter compatibility, so the model is genuinely swappable.** Newer
models reject `temperature`, `top_p` and `max_tokens`. A hard-coded request body
would 400 on every page. The engine now negotiates: the first rejected parameter
is learned from the API's own error message, remembered per model for the life
of the process, and the call is retried immediately — so it costs one call, once,
ever. And if your key cannot use the configured model, it walks down
`OPENAI_VISION_FALLBACKS` instead of failing the scan.

**c) Resolution — the big one.** Pages were rendered at 2.4x and then re-encoded
**down** to 1600px at quality 0.82: two lossy JPEG passes ending at ~145 DPI.
Now the page is rendered **once**, straight at 2400px, quality 0.95.

And on top of that, **every page is now read more than once**:

- once whole — this gets the reading order right;
- then as overlapping high-resolution slices — these get the *characters* right,
  because each glyph gets 2–3x the pixels.

`analyzePageLayout()` looks at the actual pixel columns to decide how to cut. A
real two-column paper is cut into **columns** (so reading order survives); a
single-column page is cut into horizontal **bands** (so no sentence is cut in
half). Aspect ratio cannot see columns — an A4 sheet is portrait either way —
and guessing wrong is expensive in both directions.

The two readings are merged by `mergeSectionSets()`: the whole-page pass is the
spine, and each slice section either replaces its counterpart when it carries
strictly more text *and no fewer options*, gets inserted when the whole-page pass
missed it entirely, or is dropped when it is just the seam fragment two
overlapping slices always produce.

The match is deliberately strict about shared openings. A loose "first 28
characters agree" test would overwrite question 5 with question 7 on a paper
where a dozen questions all begin *"निम्नलिखित में से कौन सा…"*. Agreement has to
cover most of the shorter key instead.

**d) Prompt.** Tightened on the two failures that actually happen: dropping the
question stem and leaving only the options, and romanising Devanagari
("prashn 1" for "प्रश्न 1"). The script-fidelity retry now covers every Indic
block, not just Devanagari, and the truncation-continuation loop still recovers
the tail of a page that hit the output ceiling.

Model 2 (PaddleOCR) is untouched — it is local and slow, so 3 calls per page
would mean ~12 minutes a page. It keeps its cheaper "only re-read a page that
came back thin" fallback.

## 4. Smaller things fixed along the way

- A blank **slice** is no longer reported as a failed read. It used to burn two
  pointless retries per blank slice — minutes of nothing on a long PDF.
- "Try scan again" re-runs from the original file and reuses the same document
  record, instead of depending on page images that no longer exist.
- Live progress: page *n* of *N*, a progress bar, and an ETA from the real
  measured per-page time.
- A `beforeunload` warning while a scan is running, so a 20-minute job is not
  thrown away by a stray tab close.
- "Start over" mid-scan now actually abandons the in-flight run instead of
  letting it write its result over a document you have moved on from.
- Snippet mode still needs every page on screen at once, so it renders smaller
  and caps at 40 pages, with a message pointing at the Pipeline for bigger files.

---

## What to expect on timing

Max-accuracy mode is ~3 API calls per page. With `OPENAI_CONCURRENCY=6` a
100-page paper is roughly 15–25 minutes end to end. The progress bar and ETA are
there because that is a long time to stare at a spinner.

If a job does not need that, `OPENAI_VISION_MODEL=gpt-4.1` is a cheaper run and
everything else keeps working — the code adapts to whichever model it is given.
