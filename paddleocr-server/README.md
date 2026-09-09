# SlideBaba — local PaddleOCR server

This folder makes SlideBaba's **PaddleOCR** engine free: OCR runs on your own
machine, nothing is billed, there is no queue and no daily cap, and no page image
ever leaves the computer.

It serves the same HTTP contract as PaddleX / Baidu AI Studio, so `lib/paddleocr.js`
talks to it with no special case:

| Endpoint | What it does |
| --- | --- |
| `POST /layout-parsing` | PP-StructureV3: layout + text + formulas (LaTeX) + tables. This is what SlideBaba uses. |
| `POST /ocr` | Recognition only, no layout. The adapter's fallback path. |
| `GET /health` | What is loaded, whether it is warm, pages served, average ms. |

---

## 1. Start it

Double-click **`start-paddleocr.bat`**.

It reuses the virtualenv at `C:\Users\DELL\paddleocr-test\venv`. If yours is
somewhere else, edit the `PADDLE_VENV` line at the top of the `.bat`.

If PaddleOCR is not installed in that venv, the script says so and offers to
install it for you. **This is the one download you need**, and it is worth knowing
what it costs before you say yes:

```
pip install paddlepaddle paddleocr pillow
```

- `paddlepaddle` — the inference engine, ~200 MB
- `paddleocr` — the pipeline code, small
- the **models** are downloaded separately on first use, ~1 GB, once, into
  `%USERPROFILE%\.paddlex`. After that everything runs offline.

Leave the window open while you scan. Close it when you are done.

## 2. Point SlideBaba at it

In `.env.local`:

```env
PADDLE_OCR_BASE_URL=http://127.0.0.1:8080
PADDLE_OCR_MODE=self
PADDLE_OCR_TIMEOUT_MS=180000
PADDLE_OCR_MAX_WAIT_MS=240000
```

Restart `npm run dev`, open the Studio, and pick **PaddleOCR** in the engine
toggle. `http://localhost:3000/api/ocr` should show `paddle.configured: true`.

## 3. Check it works

| URL | What it tells you |
| --- | --- |
| `http://127.0.0.1:8080/health` | the server's own status — which pipelines are loaded, whether warm-up finished |
| `http://localhost:3000/api/ocr` | what SlideBaba thinks is configured, for both engines |
| `http://localhost:3000/api/ocr?probe=1` | a real OCR of a ~1 KB built-in image, with per-stage timings |
| `http://localhost:3000/api/ocr?probe=all` | the same probe on **both** engines, so you can compare them directly |

The probe image is tiny on purpose: it separates *"my upload is slow"* from
*"the service is slow"*.

---

## Speed

Three things in `server.py` exist purely so that PaddleOCR feels as quick as the
hosted ChatGPT engine, and they are worth knowing about because two of them are
the usual reasons a local install feels sluggish:

1. **Warm-up on boot.** The pipeline is built and run once against a tiny image
   while you are still choosing a file. Without it, page 1 pays the model-load
   cost (tens of seconds on a cold CPU) and pages 2..n take a second or two —
   which feels like the scan hanging and then racing. Set `PADDLE_WARMUP=0` to
   skip it if you want the window to be usable a few seconds sooner.
2. **One prediction at a time.** PaddleOCR's predictors are not thread-safe, and
   two concurrent inferences on one CPU are *slower* than the same two in
   sequence. The Studio sends one page at a time to match.
3. **Input capped at 4 megapixels** (`PADDLE_MAX_PIXELS`). A 25 MP phone photo
   costs several times more and reads no better — PP-StructureV3 resizes
   internally anyway.

Rough CPU figures for a dense A4 exam page: **2–6 s per page** after warm-up on a
modern laptop, single-digit seconds with formulas and tables on. A GPU build cuts
that to well under a second.

To use a GPU: install `paddlepaddle-gpu` for your CUDA version from
<https://www.paddlepaddle.org.cn/en> and set `PADDLE_DEVICE=gpu`.

## Languages

PP-OCRv5 ships **one recognition model per script family**, so no single model is
best at both Latin and Devanagari. The server therefore reads each page in
`PADDLE_LANG`, and when that read looks weak (low mean confidence, or almost no
text) it reads it again in `PADDLE_FALLBACK_LANG` and keeps the better result.
That is what makes mixed Hindi + English papers come out right without anyone
choosing a language.

Defaults are `PADDLE_LANG=en` and `PADDLE_FALLBACK_LANG=devanagari`. If your
papers are mostly Hindi, swap them — the primary script is the fast path:

```env
PADDLE_LANG=devanagari
PADDLE_FALLBACK_LANG=en
```

## All settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PADDLE_HOST` | `127.0.0.1` | `0.0.0.0` to let other machines on your LAN use it |
| `PADDLE_PORT` | `8080` | |
| `PADDLE_LANG` | `en` | primary recognition script |
| `PADDLE_FALLBACK_LANG` | `devanagari` | second try when the first read is poor |
| `PADDLE_FALLBACK_MIN_CONF` | `0.80` | below this mean confidence, try the fallback |
| `PADDLE_DEVICE` | `cpu` | `gpu` with a paddlepaddle-gpu build |
| `PADDLE_USE_FORMULA` | `1` | maths as LaTeX |
| `PADDLE_USE_TABLE` | `1` | tables as HTML |
| `PADDLE_USE_CHART` | `0` | chart-to-table; accurate but slow |
| `PADDLE_UNWARP` | `0` | for curved / hand-held pages |
| `PADDLE_ORIENTATION` | `1` | rotated phone photos |
| `PADDLE_MAX_PIXELS` | `4000000` | downscale bigger uploads first |
| `PADDLE_WARMUP` | `1` | load + exercise the models at startup |
| `PADDLE_TOKEN` | *(empty)* | if set, requests must send `Authorization: token <value>` |

Set any of them before launching, or add them to the top of `start-paddleocr.bat`.

---

## Deploying SlideBaba (the Vercel caveat)

`127.0.0.1` means *"the machine the code is running on"*. A SlideBaba deployed to
Vercel cannot reach a server on your desk, so on a deployed site the PaddleOCR
engine will fail with a connection error while ChatGPT keeps working. Three ways
round it:

1. **Run SlideBaba locally** (`npm run dev`) whenever you want free OCR. Simplest.
2. **Expose this server** on a public URL — a tunnel (Cloudflare Tunnel, ngrok) or
   a small VPS — set `PADDLE_TOKEN` to a long random string, and point
   `PADDLE_OCR_BASE_URL` at that URL. Set the same token as
   `PADDLE_AISTUDIO_TOKEN` in `.env.local` so the adapter sends it.
3. **Deploy PaddleOCR on Baidu AI Studio** and point `PADDLE_OCR_BASE_URL` at your
   own deployment — your own queue, no shared throttle.

On a deployed site, set `OCR_ENGINE_DEFAULT=openai` so visitors get an engine that
actually works, and keep PaddleOCR as the choice you use locally.
