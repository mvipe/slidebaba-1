# PaddleOCR in SlideBaba

> **This file has been superseded by [`OCR-ENGINES.md`](./OCR-ENGINES.md).**
>
> SlideBaba is no longer PaddleOCR-only. It now ships **two OCR engines** and the
> user picks between them in the Studio:
>
> | | PaddleOCR | ChatGPT |
> | --- | --- | --- |
> | Cost | **Free**, runs on your own machine | Paid, billed to your OpenAI account |
> | Setup | `paddleocr-server/start-paddleocr.bat` | `OPENAI_API_KEY` in `.env.local` |
>
> Both engines feed the **same** structurer, so the choice only changes who reads
> the pixels — question splitting, options, LaTeX and export are identical.
>
> Read **[`OCR-ENGINES.md`](./OCR-ENGINES.md)** for the toggle, setup, tuning,
> diagnostics and failure classes, and **[`paddleocr-server/README.md`](./paddleocr-server/README.md)**
> for running PaddleOCR locally.

## Quick start (PaddleOCR, free)

1. Double-click `paddleocr-server/start-paddleocr.bat` — it reuses the venv at
   `C:\Users\DELL\paddleocr-test\venv` and offers to install PaddleOCR if it is
   missing.
2. `.env.local` already contains:
   ```env
   PADDLE_OCR_BASE_URL=http://127.0.0.1:8080
   PADDLE_OCR_MODE=self
   ```
3. Open the Studio and pick **PaddleOCR** in the engine toggle.

Check it with `http://127.0.0.1:8080/health` and `http://localhost:3000/api/ocr?probe=all`.
