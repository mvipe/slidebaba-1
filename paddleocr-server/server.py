#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SlideBaba — local PaddleOCR server.

Runs PP-StructureV3 (layout detection + text recognition + formula recognition as
LaTeX + table recognition) on this machine and speaks the same HTTP contract that
PaddleX / AI Studio serve, so lib/paddleocr.js talks to it with no special case.

  POST /layout-parsing   the full document-parsing pipeline (what SlideBaba uses)
  POST /ocr              plain text recognition, the adapter's fallback path
  GET  /health           what is loaded, how warm it is, how many pages it has done
  GET  /                 the same as /health

WHY THIS EXISTS
---------------
It makes the PaddleOCR engine free and private: no per-page cost, no API key, no
shared queue, no daily cap, and no page image ever leaves this computer. It also
makes it *fast and consistent*, which is the part people usually get wrong:

  - the pipeline is built and WARMED UP at startup, so page 1 of a PDF costs the
    same as page 40 instead of paying a 20-60s model-load tax on the first request;
  - exactly one prediction runs at a time (`_PREDICT_LOCK`), because PaddleOCR's
    predictors are not thread-safe and two concurrent calls on one CPU are slower
    than the same two calls in sequence, not faster;
  - the models stay resident between requests.

SCRIPTS / LANGUAGES
-------------------
PP-OCRv5 ships one recognition model per script family, so a single model cannot
be simultaneously best at Latin and at Devanagari. This server therefore reads a
page with PADDLE_LANG, and — when that read looks poor (low mean confidence or
very little text) — reads it again with PADDLE_FALLBACK_LANG and keeps whichever
result is better. That is what makes Hindi + English exam papers come out right
without the user picking a language.

ENVIRONMENT
-----------
  PADDLE_HOST              default 127.0.0.1     (0.0.0.0 to expose on the LAN)
  PADDLE_PORT              default 8080
  PADDLE_LANG              default en            primary recognition script
  PADDLE_FALLBACK_LANG     default devanagari    second try when the first is poor
  PADDLE_FALLBACK_MIN_CONF default 0.80          below this, try the fallback script
  PADDLE_DEVICE            cpu | gpu             default cpu
  PADDLE_USE_FORMULA       1|0  default 1        formulas as LaTeX
  PADDLE_USE_TABLE         1|0  default 1        tables as HTML
  PADDLE_USE_CHART         1|0  default 0        chart-to-table (slow)
  PADDLE_UNWARP            1|0  default 0        for curved / hand-held pages
  PADDLE_ORIENTATION       1|0  default 1        rotated phone photos
  PADDLE_TOKEN             optional shared secret; when set, requests must send
                                                 Authorization: token <value>
  PADDLE_WARMUP            1|0  default 1
  PADDLE_MAX_PIXELS        default 4000000       downscale huge uploads first

Run it with paddleocr-server/start-paddleocr.bat (Windows) or:
    python server.py
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------- #
# configuration                                                                #
# --------------------------------------------------------------------------- #


def _env(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    return v.strip() if v and v.strip() else default


def _flag(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or not str(v).strip():
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _num(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


HOST = _env("PADDLE_HOST", "127.0.0.1")
PORT = int(_num("PADDLE_PORT", 8080))
LANG = _env("PADDLE_LANG", "en")
FALLBACK_LANG = _env("PADDLE_FALLBACK_LANG", "devanagari")
FALLBACK_MIN_CONF = _num("PADDLE_FALLBACK_MIN_CONF", 0.80)
DEVICE = _env("PADDLE_DEVICE", "cpu")
USE_FORMULA = _flag("PADDLE_USE_FORMULA", True)
USE_TABLE = _flag("PADDLE_USE_TABLE", True)
USE_CHART = _flag("PADDLE_USE_CHART", False)
UNWARP = _flag("PADDLE_UNWARP", False)
ORIENTATION = _flag("PADDLE_ORIENTATION", True)
TOKEN = _env("PADDLE_TOKEN", "")
WARMUP = _flag("PADDLE_WARMUP", True)
MAX_PIXELS = int(_num("PADDLE_MAX_PIXELS", 4_000_000))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-5s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("slidebaba.paddle")

# Paddle is chatty on stderr; keep our own output readable.
logging.getLogger("ppocr").setLevel(logging.ERROR)
os.environ.setdefault("GLOG_minloglevel", "2")
os.environ.setdefault("FLAGS_call_stack_level", "0")

# --------------------------------------------------------------------------- #
# lazy, cached pipelines                                                       #
# --------------------------------------------------------------------------- #

_PREDICT_LOCK = threading.Lock()   # PaddleOCR predictors are not thread-safe.
_BUILD_LOCK = threading.Lock()
_PIPELINES: Dict[str, Any] = {}    # lang -> PPStructureV3
_OCRS: Dict[str, Any] = {}         # lang -> PaddleOCR
_STATS = {"pages": 0, "ms_total": 0.0, "started": time.time(), "warm": False, "errors": 0}

# PP-StructureV3 needs the "doc-parser" dependency group; plain `pip install
# paddleocr` does NOT include it. When it is missing we fall back to plain
# PP-OCR text recognition rather than refusing to work: layout, LaTeX formulas
# and table markup are lost, but the page is still read, which is the difference
# between a degraded SlideBaba and a broken one. The degradation is reported in
# every response and in /health — a silent quality drop would be worse than the
# error it replaces.
DOC_PARSER_HINT = (
    'PP-StructureV3 is unavailable — install its dependency group with:\n'
    '    python -m pip install "paddleocr[doc-parser]"\n'
    "Until then the server falls back to plain text recognition "
    "(no layout, no LaTeX formulas, no table markup)."
)
_STRUCTURE: Dict[str, Any] = {"available": None, "error": "", "warned": False}


def _build_kwargs(lang: str) -> Dict[str, Any]:
    return {
        "lang": lang,
        "device": DEVICE,
        "use_doc_orientation_classify": ORIENTATION,
        "use_doc_unwarping": UNWARP,
        "use_textline_orientation": ORIENTATION,
        "use_formula_recognition": USE_FORMULA,
        "use_table_recognition": USE_TABLE,
        "use_chart_recognition": USE_CHART,
    }


def _construct(cls, kwargs: Dict[str, Any]):
    """
    Build a pipeline, dropping any keyword this installed version does not accept.

    PaddleOCR's constructor signature has moved between 3.x releases; rather than
    pinning one release and breaking on every other, we retry without whichever
    keyword it rejected. That keeps this file working across versions.
    """
    kw = dict(kwargs)
    for _ in range(len(kwargs) + 1):
        try:
            return cls(**kw)
        except TypeError as exc:
            m = re.search(r"unexpected keyword argument '([^']+)'", str(exc))
            if not m or m.group(1) not in kw:
                raise
            dropped = m.group(1)
            kw.pop(dropped, None)
            log.warning("this PaddleOCR build does not accept %s= — continuing without it", dropped)
    return cls()


def get_pipeline(lang: str):
    """PP-StructureV3 for `lang`, built once and kept in memory."""
    with _BUILD_LOCK:
        if lang in _PIPELINES:
            return _PIPELINES[lang]
        from paddleocr import PPStructureV3  # imported late: it is slow

        t0 = time.time()
        log.info("loading PP-StructureV3 (lang=%s, device=%s) …", lang, DEVICE)
        try:
            _PIPELINES[lang] = _construct(PPStructureV3, _build_kwargs(lang))
        except Exception as exc:  # noqa: BLE001
            # The generic "A dependency error occurred" message names nothing, so
            # log the traceback too — that is where the missing module appears.
            _STRUCTURE["available"] = False
            _STRUCTURE["error"] = f"{type(exc).__name__}: {exc}"
            if not _STRUCTURE["warned"]:
                _STRUCTURE["warned"] = True
                log.error("-" * 66)
                log.error("Could not create PP-StructureV3: %s", exc)
                for line in DOC_PARSER_HINT.split("\n"):
                    log.error("%s", line)
                log.error("Underlying detail:\n%s", traceback.format_exc())
                log.error("-" * 66)
            raise
        _STRUCTURE["available"] = True
        log.info("PP-StructureV3 (%s) ready in %.1fs", lang, time.time() - t0)
        return _PIPELINES[lang]


def get_ocr(lang: str):
    """Plain PaddleOCR for `lang` — the /ocr endpoint and the confidence probe."""
    with _BUILD_LOCK:
        if lang in _OCRS:
            return _OCRS[lang]
        from paddleocr import PaddleOCR

        t0 = time.time()
        log.info("loading PaddleOCR (lang=%s) …", lang)
        _OCRS[lang] = _construct(
            PaddleOCR,
            {
                "lang": lang,
                "device": DEVICE,
                "use_doc_orientation_classify": ORIENTATION,
                "use_doc_unwarping": UNWARP,
                "use_textline_orientation": ORIENTATION,
            },
        )
        log.info("PaddleOCR (%s) ready in %.1fs", lang, time.time() - t0)
        return _OCRS[lang]


# --------------------------------------------------------------------------- #
# input handling                                                               #
# --------------------------------------------------------------------------- #

_DATA_URL = re.compile(r"^data:([^;,]*)?(;[^,]*)?,(.*)$", re.S)


def decode_file(field: Any, file_type: Optional[int]) -> Tuple[bytes, str]:
    """
    Accept a data: URL, a bare base64 string, or an http(s) URL.
    Returns (bytes, suffix) where suffix is ".png" / ".jpg" / ".pdf".
    """
    raw = str(field or "").strip()
    if not raw:
        raise ValueError("Missing 'file' in request.")

    if raw.startswith("http://") or raw.startswith("https://"):
        import urllib.request

        with urllib.request.urlopen(raw, timeout=60) as resp:  # noqa: S310 (explicit, local tool)
            data = resp.read()
        return data, ".pdf" if raw.lower().split("?")[0].endswith(".pdf") else ".png"

    mime = "image/png"
    b64 = raw
    m = _DATA_URL.match(raw)
    if m:
        mime = (m.group(1) or "image/png").lower()
        b64 = m.group(3) or ""

    b64 = re.sub(r"\s+", "", b64)
    try:
        data = base64.b64decode(b64, validate=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"'file' is not valid base64: {exc}") from exc
    if not data:
        raise ValueError("'file' decoded to zero bytes.")

    if data[:4] == b"%PDF" or "pdf" in mime or file_type == 0:
        return data, ".pdf"
    if "jpeg" in mime or "jpg" in mime:
        return data, ".jpg"
    if "webp" in mime:
        return data, ".webp"
    if "bmp" in mime:
        return data, ".bmp"
    return data, ".png"


def shrink_if_huge(data: bytes, suffix: str) -> bytes:
    """
    A 25-megapixel phone photo costs several times more than a 4-megapixel one and
    reads no better — PP-StructureV3 resizes internally anyway. Capping the input
    is the single biggest, safest speed win on this server.
    """
    if suffix == ".pdf" or MAX_PIXELS <= 0:
        return data
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(data))
        w, h = img.size
        if w * h <= MAX_PIXELS:
            return data
        scale = (MAX_PIXELS / float(w * h)) ** 0.5
        img = img.convert("RGB").resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92)
        log.info("downscaled input %dx%d -> %dx%d", w, h, img.size[0], img.size[1])
        return buf.getvalue()
    except Exception:  # noqa: BLE001  Pillow missing or an odd format — use the original
        return data


# --------------------------------------------------------------------------- #
# result extraction                                                            #
# --------------------------------------------------------------------------- #

# Keys that hold base64 imagery. They are megabytes each and the Node side ignores
# them, so stripping them here is pure win on response size and JSON time.
_IMAGE_KEYS = {
    "img", "image", "images", "input_img", "input_image", "output_images",
    "doc_preprocessor_image", "preprocessed_img", "block_image", "ocr_image",
    "vis_image", "visualize", "layout_det_res_img", "formula_res_img",
    "table_res_img", "seal_res_img", "doc_preprocessor_res_img", "overall_ocr_res_img",
}


def prune(node: Any, depth: int = 0) -> Any:
    """Drop image blobs and anything that will not survive json.dumps."""
    if depth > 22:
        return None
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k in _IMAGE_KEYS:
                continue
            if isinstance(v, (bytes, bytearray)):
                continue
            if isinstance(v, str) and len(v) > 200_000:
                continue  # a base64 blob under a key we did not list
            p = prune(v, depth + 1)
            if p is not None or v is None:
                out[k] = p
        return out
    if isinstance(node, (list, tuple)):
        return [prune(v, depth + 1) for v in node]
    if isinstance(node, (str, int, float, bool)) or node is None:
        return node
    # numpy scalars / arrays and anything else exotic
    try:
        import numpy as np

        if isinstance(node, np.ndarray):
            return node.tolist() if node.size <= 20000 else None
        if isinstance(node, np.generic):
            return node.item()
    except Exception:  # noqa: BLE001
        pass
    return None


def result_json(res: Any) -> Dict[str, Any]:
    """`res.json` differs across versions — normalise to a plain dict."""
    data: Any = None
    for attr in ("json", "_json"):
        if hasattr(res, attr):
            try:
                data = getattr(res, attr)
                break
            except Exception:  # noqa: BLE001
                data = None
    if data is None and isinstance(res, dict):
        data = res
    if data is None:
        return {}
    if isinstance(data, dict) and "res" in data and isinstance(data["res"], dict):
        data = data["res"]
    pruned = prune(data)
    return pruned if isinstance(pruned, dict) else {}


def result_markdown(res: Any) -> str:
    """
    Pull the markdown transcription out of one PP-StructureV3 result.

    Depending on the version this is `res.markdown` as a str, as a dict with
    'markdown_texts', or absent entirely (in which case the caller falls back to
    the layout blocks / recognised lines, exactly as the Node adapter does).
    """
    md = getattr(res, "markdown", None)
    if md is None and isinstance(res, dict):
        md = res.get("markdown")
    if isinstance(md, str):
        return md
    if isinstance(md, dict):
        for key in ("markdown_texts", "text", "markdown"):
            v = md.get(key)
            if isinstance(v, str) and v.strip():
                return v
            if isinstance(v, list):
                joined = "\n\n".join(str(x) for x in v if str(x).strip())
                if joined.strip():
                    return joined
    return ""


def mean_confidence(payload: Dict[str, Any]) -> Tuple[float, int]:
    """Mean recognition confidence and character count, used to judge a script guess."""
    scores: List[float] = []
    chars = 0

    def walk(node: Any, depth: int = 0) -> None:
        nonlocal chars
        if depth > 14:
            return
        if isinstance(node, dict):
            s = node.get("rec_scores")
            if isinstance(s, list):
                scores.extend(float(x) for x in s if isinstance(x, (int, float)))
            t = node.get("rec_texts")
            if isinstance(t, list):
                chars += sum(len(str(x)) for x in t)
            for v in node.values():
                walk(v, depth + 1)
        elif isinstance(node, list):
            for v in node:
                walk(v, depth + 1)

    walk(payload)
    return (sum(scores) / len(scores) if scores else 0.0), chars


def run_pipeline(lang: str, path: str) -> Dict[str, Any]:
    """One PP-StructureV3 pass over a file, returned in PaddleX response shape."""
    pipeline = get_pipeline(lang)
    results = pipeline.predict(input=path)
    pages: List[Dict[str, Any]] = []
    for res in results:
        payload = result_json(res)
        md = result_markdown(res)
        if md:
            payload["markdown"] = {"text": md}
        pages.append(payload)
    return {"layoutParsingResults": pages, "lang": lang}


def run_plain(lang: str, path: str) -> Dict[str, Any]:
    """
    Text-only read, used when PP-StructureV3 cannot be built.

    The Node adapter harvests `rec_texts` from whatever shape it is given, and
    lib/ocrStructure.js falls back to raw recognised lines when there are no
    layout blocks and no markdown — so this still produces usable slides. It just
    cannot mark headings, wrap formulas in $$…$$, or keep tables as tables.
    """
    ocr = get_ocr(lang)
    results = ocr.predict(input=path)
    return {"ocrResults": [result_json(r) for r in results], "lang": lang, "degraded": True}


def better(a: Dict[str, Any], b: Dict[str, Any]) -> Dict[str, Any]:
    """
    Pick the better of two script reads.

    More text wins when the confidence is comparable, because a wrong-script model
    typically returns a handful of garbage lines with deceptively high confidence.
    Confidence breaks the tie when both read a similar amount.
    """
    ca, na = mean_confidence(a)
    cb, nb = mean_confidence(b)
    if nb > na * 1.35:
        return b
    if na > nb * 1.35:
        return a
    return b if cb > ca else a


# --------------------------------------------------------------------------- #
# request handling                                                             #
# --------------------------------------------------------------------------- #


def layout_parsing(body: Dict[str, Any]) -> Dict[str, Any]:
    started = time.time()
    data, suffix = decode_file(body.get("file"), body.get("fileType"))
    data = shrink_if_huge(data, suffix)

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(data)
        tmp.close()

        with _PREDICT_LOCK:
            degraded = False
            try:
                primary = run_pipeline(LANG, tmp.name)
            except Exception:  # noqa: BLE001  already logged in full by get_pipeline
                degraded = True
                primary = run_plain(LANG, tmp.name)
            conf, chars = mean_confidence(primary)

            # Second script only when the first read looks unconvincing. This is the
            # difference between "Hindi papers work" and "Hindi papers are garbage",
            # and it costs nothing on the pages that read cleanly the first time.
            used_fallback = False
            if FALLBACK_LANG and FALLBACK_LANG != LANG and (conf < FALLBACK_MIN_CONF or chars < 40):
                log.info("primary read weak (conf=%.2f chars=%d) — retrying in %s", conf, chars, FALLBACK_LANG)
                try:
                    secondary = (run_plain if degraded else run_pipeline)(FALLBACK_LANG, tmp.name)
                    picked = better(primary, secondary)
                    used_fallback = picked is secondary
                    primary = picked
                except Exception as exc:  # noqa: BLE001
                    log.warning("fallback script failed, keeping the primary read: %s", exc)

        ms = int((time.time() - started) * 1000)
        _STATS["pages"] += 1
        _STATS["ms_total"] += ms
        log.info(
            "layout-parsing ok in %dms (lang=%s%s%s)",
            ms, primary.get("lang"),
            ", fallback-script" if used_fallback else "",
            ", DEGRADED text-only" if degraded else "",
        )

        return {
            "errorCode": 0,
            "errorMsg": "Success",
            "result": {
                **primary,
                "elapsedMs": ms,
                "usedFallbackLang": used_fallback,
                "degraded": degraded,
                "degradedReason": DOC_PARSER_HINT if degraded else "",
            },
        }
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def plain_ocr(body: Dict[str, Any]) -> Dict[str, Any]:
    """The adapter's /ocr fallback: recognition only, no layout."""
    started = time.time()
    data, suffix = decode_file(body.get("file"), body.get("fileType"))
    data = shrink_if_huge(data, suffix)

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(data)
        tmp.close()
        with _PREDICT_LOCK:
            results = get_ocr(LANG).predict(input=tmp.name)
            pages = [result_json(r) for r in results]
        ms = int((time.time() - started) * 1000)
        return {"errorCode": 0, "errorMsg": "Success", "result": {"ocrResults": pages, "lang": LANG, "elapsedMs": ms}}
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def health() -> Dict[str, Any]:
    pages = _STATS["pages"]
    return {
        "status": "ok",
        "engine": "PaddleOCR / PP-StructureV3",
        "warm": _STATS["warm"],
        "structureAvailable": _STRUCTURE["available"],
        "structureError": _STRUCTURE["error"],
        "degraded": _STRUCTURE["available"] is False,
        "degradedHint": DOC_PARSER_HINT if _STRUCTURE["available"] is False else "",
        "loadedPipelines": sorted(_PIPELINES.keys()),
        "loadedOcr": sorted(_OCRS.keys()),
        "lang": LANG,
        "fallbackLang": FALLBACK_LANG,
        "device": DEVICE,
        "formula": USE_FORMULA,
        "table": USE_TABLE,
        "chart": USE_CHART,
        "unwarp": UNWARP,
        "orientation": ORIENTATION,
        "maxPixels": MAX_PIXELS,
        "tokenRequired": bool(TOKEN),
        "pagesServed": pages,
        "avgMs": int(_STATS["ms_total"] / pages) if pages else 0,
        "errors": _STATS["errors"],
        "uptimeSec": int(time.time() - _STATS["started"]),
        "endpoints": ["POST /layout-parsing", "POST /ocr", "GET /health"],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "SlideBabaPaddleOCR/1.0"
    protocol_version = "HTTP/1.1"

    # Keep the console readable — we log our own one-liners.
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        return

    # -- helpers ----------------------------------------------------------- #

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self) -> bool:
        if not TOKEN:
            return True
        header = self.headers.get("Authorization", "")
        return header.split(" ")[-1].strip() == TOKEN

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        chunks: List[bytes] = []
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        return json.loads(raw.decode("utf-8")) if raw else {}

    # -- verbs ------------------------------------------------------------- #

    def do_OPTIONS(self) -> None:  # noqa: N802
        # 204 must carry no body: with HTTP/1.1 keep-alive an unexpected body
        # desynchronises the connection and the NEXT request on it appears to hang.
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path in ("/", "/health", "/healthz"):
            self._send(200, health())
        else:
            self._send(404, {"errorCode": 404, "errorMsg": f"No GET {path}. Try /health."})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?")[0].rstrip("/") or "/"
        if not self._authorised():
            self._send(401, {"errorCode": 401, "errorMsg": "Bad or missing token."})
            return
        try:
            body = self._read_json()
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"errorCode": 400, "errorMsg": f"Invalid JSON body: {exc}"})
            return

        try:
            if path in ("/layout-parsing", "/layout_parsing", "/v1/layout-parsing"):
                self._send(200, layout_parsing(body))
            elif path in ("/ocr", "/v1/ocr"):
                self._send(200, plain_ocr(body))
            else:
                self._send(404, {"errorCode": 404, "errorMsg": f"No POST {path}. Try /layout-parsing."})
        except ValueError as exc:
            self._send(400, {"errorCode": 400, "errorMsg": str(exc)})
        except Exception as exc:  # noqa: BLE001
            _STATS["errors"] += 1
            log.error("request failed: %s\n%s", exc, traceback.format_exc())
            self._send(500, {"errorCode": 500, "errorMsg": f"{type(exc).__name__}: {exc}"})


# --------------------------------------------------------------------------- #
# startup                                                                      #
# --------------------------------------------------------------------------- #

# A 320x96 PNG reading "SlideBaba OCR probe / TEST 12345" — the same probe image
# the Node adapter uses, so `?probe=1` timings compare like for like.
WARMUP_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAUAAAABgCAAAAABJIPT0AAAD8UlEQVR42u3ab2iVZRgG8Gtu2c6mPKcVc5u2wAUOl5mbNOd29r7HuTWJWR9qkbZmiRFhUFTTD0pQ4JBA+oth5"
    "GgVCJ6YqVtDI1S2NSsiqtEH08jhFiem02h7p2e7+vC8+2+jkAjOruvTfT885znw433O4XDuBEK5kcwRgQAFKEABKgIUoAAFqAhQgAIUoCJAAQpQgIoABShAASr/HvDbinB5N4Lo2gsACI6up7"
    "jOiiOYvAYADQVFBR8A7+U793cDKa6Tf3L62wTjV5BTs7ybkWqa0XZi8V32lDWSrcWXeKn4+LHwAFvWkIb8ftm0Mye9Ir4yHTDzDK+eoiENf6sqqTW8uLEsdJo05MjiH4vz9pDmxZLQOVuyrINk"
    "+9qKL0luuUpDjqTR30Kz6Y3edaF1vbb1D4p3wIaMJ7+gBXzsIzbdzM2d/HU5acjPDz99qi+TTD7ADx+0JbMGSQ5mLfTGHrXWh+hvYXIrNzSycaNt/YPiHZAX99/9sgVc5PFaChc5jnNnjAFnVWL5"
    "lX11qWRgiN4CW1rAgYUZPmDAWZ3WS38LU4eZ5dHLsq1/UJwDRtvJ6AILmO5xKMCMQQ6ftJ9u5r593fPJ1Bi9bFtybTvJtorSTnLkcdKQu+vpb6EhMz16Wbb1D4qvTPsWTqjuRl+2rVd/iiaiuAmf"
    "1QMAbs35ptobAmItOBi2JV6qu4z+bXXP7BjCgSEAQPlX8LcAQDiCiGvb8YPi+lu4udAt+4Erd9HwXCi0zfB8Zemas2TACYe/3rn00XSPpjZUFbUl+f6KVfkN5Kt5bvXvpCH/zBmm3UJDXqgMVfbY"
    "1j8ovpLwH01nBfv1S0T5J0nQfKCeQAEKUICKAAUoQAEqAhSgAAWoCFCAAhSgIsD/B7DJdZNcN5Liuu4eOyfjrwD9mwyA/aF7jmHgEbegGQBaAji+2HV3zF5BXn+QxUyYkxntSt40ZLR0+Kdc7n6NP"
    "XeQvFI0n417OYuTNKNu1MP69LHuYMZOoG/rnNv7sCUVXTcB2P7cU+hdoiv8d9kV2twWGusyACD3YUSqcMvcmgfeBdp6qoHe5pL1Z3WFp1zhgOM4Hf6czPh0miHJn/OiJHmohl7hBRo+/zY/Cc/aKz"
    "zjZ6A/JzMZ8I+CTnLrNcbS+PFSx0ms+SXG2G2zFnDGKzxxTmbsia19oRC4fAgdS7Ch68SJeY3bj+L0sll7g6/3x3qwH0i5Fyiqb3klkPj6XeODGsF+NDy7EvOOnq8dmftWrl0680RS8js5AlT0S0"
    "SAAhSgIkABClCAigAFKEABKgIUoAAFqAhQgAIUoCJAAQpQgIoABShAASoCFKAABagIUIACFKAARXBj+Qv/48Sw2eSa0QAAAABJRU5ErkJggg=="
)


def warm_up() -> None:
    """
    Load and exercise the pipeline before the first real request.

    Without this, page 1 of a PDF pays the model-load cost (tens of seconds on a
    cold CPU) while pages 2..n take a second or two — which reads to the user as
    "the scan hangs, then races". Warming up makes every page cost the same.
    """
    try:
        t0 = time.time()
        data = base64.b64decode(WARMUP_PNG)
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
        tmp.write(data)
        tmp.close()
        try:
            with _PREDICT_LOCK:
                run_pipeline(LANG, tmp.name)
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
        _STATS["warm"] = True
        log.info("warm-up finished in %.1fs — first real page will be full speed", time.time() - t0)
    except Exception as exc:  # noqa: BLE001
        if _STRUCTURE["available"] is False:
            log.warning("Running in DEGRADED mode: plain text recognition only.")
            log.warning("Scanning WILL still work. To get layout, LaTeX and tables, install the extras above.")
        else:
            log.warning("warm-up failed (page 1 will just be slower): %s", exc)
        log.info("The server is STILL RUNNING and accepting requests on port %d.", PORT)


def main() -> int:
    log.info("=" * 68)
    log.info(" SlideBaba local PaddleOCR server")
    log.info(" http://%s:%d      lang=%s  fallback=%s  device=%s", HOST, PORT, LANG, FALLBACK_LANG, DEVICE)
    log.info(" Put this in .env.local:  PADDLE_OCR_BASE_URL=http://%s:%d", "127.0.0.1", PORT)
    log.info("=" * 68)

    # This import is SLOW — 20-60s on a cold Windows CPU, longer on the very first
    # run when paddlex checks/downloads its model registry. Saying so is not a
    # nicety: without this line the console sits on the banner with a spinner and
    # looks hung, which is indistinguishable from actually being hung.
    log.info("importing PaddleOCR — first run can take a minute or two, please wait…")
    _t_import = time.time()
    try:
        import paddleocr  # noqa: F401
        log.info("PaddleOCR %s imported in %.1fs",
                 getattr(paddleocr, "__version__", "?"), time.time() - _t_import)
    except ImportError:
        log.error("-" * 66)
        log.error("PaddleOCR is not installed in this Python environment:")
        log.error("    %s", sys.executable)
        log.error("Install it with:")
        log.error("    \"%s\" -m pip install paddlepaddle paddleocr pillow", sys.executable)
        log.error("-" * 66)
        return 2
    except Exception as exc:  # noqa: BLE001
        # paddleocr present but unusable — a broken paddlepaddle wheel, a missing
        # MSVC runtime, a numpy/protobuf clash. The traceback is the useful part.
        log.error("-" * 66)
        log.error("PaddleOCR is installed but failed to import: %s: %s", type(exc).__name__, exc)
        log.error("Full detail:\n%s", traceback.format_exc())
        log.error("Most often this is a broken paddlepaddle install. Try:")
        log.error("    \"%s\" -m pip install --force-reinstall paddlepaddle", sys.executable)
        log.error("-" * 66)
        return 2

    # Bind BEFORE warming up: if the port is taken we want to say so in two
    # seconds, not after a minute of loading models we are about to throw away.
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as exc:
        log.error("-" * 66)
        if getattr(exc, "errno", None) in (48, 98, 10048):  # EADDRINUSE (mac/linux/win)
            log.error("Port %d is already in use.", PORT)
            log.error("Either this server is ALREADY RUNNING in another window — check")
            log.error("http://127.0.0.1:%d/health before starting a second one — or another", PORT)
            log.error("program has the port. To use a different one:")
            log.error("    set PADDLE_PORT=8081  &&  python server.py")
            log.error("and change PADDLE_OCR_BASE_URL in .env.local to match.")
        else:
            log.error("Could not listen on %s:%d — %s", HOST, PORT, exc)
        log.error("-" * 66)
        return 3

    server.daemon_threads = True

    if WARMUP:
        threading.Thread(target=warm_up, name="warmup", daemon=True).start()

    log.info("listening on http://%s:%d — press Ctrl+C to stop", HOST, PORT)
    if WARMUP:
        log.info("(models are loading in the background; the first scan will wait for them)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
