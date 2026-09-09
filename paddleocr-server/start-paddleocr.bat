@echo off
setlocal EnableDelayedExpansion
title SlideBaba - local PaddleOCR server

REM ===========================================================================
REM  SlideBaba - start the local PaddleOCR server
REM
REM  Free, offline OCR for SlideBaba. Nothing is billed and no page image leaves
REM  this computer. Double-click this file and leave the window open while you
REM  scan; close it when you are done.
REM
REM  It reuses the virtualenv you already have at C:\Users\DELL\paddleocr-test\venv.
REM  Set PADDLE_VENV below if yours lives somewhere else.
REM ===========================================================================

REM ---- where your PaddleOCR virtualenv lives --------------------------------
if "%PADDLE_VENV%"=="" set "PADDLE_VENV=C:\Users\DELL\paddleocr-test\venv"

REM ---- OCR settings (override any of these before launching if you want) ----
if "%PADDLE_HOST%"==""          set "PADDLE_HOST=127.0.0.1"
if "%PADDLE_PORT%"==""          set "PADDLE_PORT=8080"
if "%PADDLE_LANG%"==""          set "PADDLE_LANG=en"
if "%PADDLE_FALLBACK_LANG%"=="" set "PADDLE_FALLBACK_LANG=devanagari"
if "%PADDLE_DEVICE%"==""        set "PADDLE_DEVICE=cpu"
if "%PADDLE_USE_FORMULA%"==""   set "PADDLE_USE_FORMULA=1"
if "%PADDLE_USE_TABLE%"==""     set "PADDLE_USE_TABLE=1"
if "%PADDLE_ORIENTATION%"==""   set "PADDLE_ORIENTATION=1"
if "%PADDLE_WARMUP%"==""        set "PADDLE_WARMUP=1"

REM Paddle is very chatty on a CPU build; keep the window readable.
set "GLOG_minloglevel=2"
set "FLAGS_call_stack_level=0"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"

cd /d "%~dp0"

echo.
echo  ==========================================================
echo   SlideBaba - local PaddleOCR server
echo   venv : %PADDLE_VENV%
echo   url  : http://%PADDLE_HOST%:%PADDLE_PORT%
echo  ==========================================================
echo.

REM ---- pick an interpreter --------------------------------------------------
set "PY="
if exist "%PADDLE_VENV%\Scripts\python.exe" (
  set "PY=%PADDLE_VENV%\Scripts\python.exe"
  echo  [1/3] Using the virtualenv at %PADDLE_VENV%
) else (
  echo  [1/3] No virtualenv at %PADDLE_VENV% - falling back to the system Python.
  where python >nul 2>&1
  if errorlevel 1 (
    echo.
    echo  ERROR: Python is not on PATH and the virtualenv was not found.
    echo         Install Python 3.10+ or set PADDLE_VENV at the top of this file.
    echo.
    pause
    exit /b 1
  )
  set "PY=python"
)

REM ---- check PaddleOCR is importable ---------------------------------------
echo  [2/3] Checking PaddleOCR...
"%PY%" -c "from paddleocr import PPStructureV3" >nul 2>&1
if errorlevel 1 (
  echo.
  echo  PaddleOCR's document-parsing pipeline ^(PP-StructureV3^) is not available
  echo  in that environment.
  echo.
  echo  Install it with these two commands, then run this file again:
  echo.
  echo      "%PY%" -m pip install --upgrade pip
  echo      "%PY%" -m pip install paddlepaddle "paddleocr[doc-parser]" pillow
  echo.
  echo  NOTE: the [doc-parser] part matters. Plain "pip install paddleocr" gives
  echo        you text recognition only - no layout, no LaTeX formulas, no tables.
  echo.
  echo  The first scan afterwards downloads the models once (about 1 GB^);
  echo  after that everything runs offline.
  echo.
  set /p INSTALL="  Install them now? [y/N] "
  if /i "!INSTALL!"=="y" (
    "%PY%" -m pip install --upgrade pip
    "%PY%" -m pip install paddlepaddle "paddleocr[doc-parser]" pillow
    if errorlevel 1 (
      echo.
      echo  Install failed. See the messages above.
      pause
      exit /b 1
    )
  ) else (
    pause
    exit /b 1
  )
)

REM ---- go -------------------------------------------------------------------
echo  [3/3] Starting the server. Leave this window open while you scan.
echo.
echo        In .env.local, make sure you have:
echo            PADDLE_OCR_BASE_URL=http://127.0.0.1:%PADDLE_PORT%
echo            PADDLE_OCR_MODE=self
echo.
echo        Health check:  http://127.0.0.1:%PADDLE_PORT%/health
echo.

"%PY%" "%~dp0server.py"

echo.
echo  The server stopped.
pause
endlocal
