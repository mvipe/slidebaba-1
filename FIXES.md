# SlideBaba — fixes for the three reported issues

All three symptoms had a shared root cause plus a couple of independent aggravating bugs.
Nothing about the UI, the plans, the pricing, Studio, OCR or the auth flow was changed.

---

## The shared root cause

Slides (and A4 notes HTML) embed images as **base64 data URLs**, and the whole project was
written into a **single Firestore document**. A Firestore document is hard-capped at
**1 MiB**. After a few minutes of real work — two or three pictures, or a background image —
every save was rejected by the server with `invalid-argument`.

That one fact produced two of the three symptoms.

---

## Issue 2 — "It says saved, but the changes are gone when I reopen it"

**Why it happened**

1. The 1 MiB limit rejected the write (see above).
2. `lib/docs.js` caught that error and only did `console.error(...)`, then returned normally —
   so the caller could not tell a failure from a success.
3. The "Saved" badge was driven by `setSaved(false); setTimeout(() => setSaved(true), 500)`.
   It was a timer. It had never been connected to whether Firestore accepted anything.

So the app confidently reported "Saved" for an entire session while nothing was being stored.

**What changed**

| File | Change |
|---|---|
| `lib/docStore.js` *(new)* | The heavy part of a document is serialised, split into ~180 KB chunks and written to a `payload_slides` / `payload_notes` subcollection. The parent document holds only small metadata, so it can never exceed the limit however many images you add. |
| `lib/docs.js` | `saveDocument()` / `updateDocument()` now **throw** on failure instead of swallowing it. Added `loadDocument()` (fetches metadata + payload) and `touchDocument()` for genuinely non-critical status flags. |
| `lib/useAutoSave.js` *(new)* | Reports `Saved` only after the **server acknowledges** the write. Shows **"Not saved — retry"** on failure, retries with backoff (3s → 8s → 20s → 45s), flushes when the tab is hidden or closed, and warns before you navigate away with unsaved work. |
| `lib/slideStore.js` | The Studio → editor handoff went through `sessionStorage`, which is capped at ~5 MB — a deck with images threw `QuotaExceededError` and the document opened blank. Now an in-memory handoff (navigation is client-side, so it survives) with sessionStorage as a best-effort fallback. |
| `Editor.js`, `NotesEditor.js` | Undo/redo and title edits now mark the document dirty (they previously didn't — an undo could be the last thing you did before closing the tab). |

**Bonus safety net.** Every edit is also mirrored to `localStorage`. If a save never reaches
the server, reopening the document offers to restore the local copy. Work is no longer
lost even if Firestore is completely unreachable.

**Bonus speed.** "My Documents" used to download every deck in full just to draw the list.
The parent documents are now ~200 bytes each, so the list loads almost instantly.

**A data-loss hole that was closed along the way.** The documents list lets you open the same
record as either slides (PPT) or notes (A4). Payload namespaces are separated by format, so
opening a deck as A4 notes and typing one character can no longer replace the slides with an
empty notes body.

**Firestore rules:** no change needed. The existing
`match /users/{uid}/{document=**}` rule already covers the new subcollections.

---

## Issue 1 — "After 5–10 minutes of work I can't download any more"

**Why it happened — three separate causes**

1. **The download awaited a Firestore write.** `downloadAs()` called
   `await consume(user.uid, profile, "doc")` *before* exporting. Once the rejected 1 MB
   autosaves had clogged the Firestore write queue, that promise never resolved — so the
   button did nothing, forever, with no error.
2. **Silent abort.** If `consume()` returned `{ ok: false }` for any reason other than
   `"limit"`, the function just `return`ed. No message, no spinner, nothing. It also burned a
   document credit *before* the export, so a failed export still cost you.
3. **html2canvas clones the entire document on every call.** The editor page grows as you
   work — each slide thumbnail carries its background as an inline base64 `background-image`,
   the background library renders base64 `<img>` tags, the current slide holds full-resolution
   pictures. A 30-slide deck meant 30 clones of a document that had grown to tens of
   megabytes. Export got slower and slower until the tab ran out of memory.

**What changed**

- **Export first, bookkeeping after.** The allowance is now checked **locally** from the
  profile already in memory (no network at all). The file is produced, and only then is the
  usage recorded — in the background, where it cannot block or break anything.
- **Nothing in the download path can hang on the network.** All Firestore calls are wrapped
  in `withTimeout()`.
- **Every failure is reported**, with a message that tells you your work is safe.
- **Isolated render sandbox** (`lib/slideExport.js`). Slides are rasterised inside a
  dedicated, permanently empty iframe carrying only the stylesheets and fonts. The document
  html2canvas clones now contains one slide and nothing else, so **export cost is constant**
  and no longer depends on how long you have been editing. Falls back to the old in-document
  path automatically if the sandbox can't be created.
- **Progress feedback** — the button shows `Exporting 7/24` instead of an opaque spinner.
- **Large decks step down** raster resolution (1792 → 1536 → 1280 px) instead of dying
  halfway through.

---

## Issue 3 — "The preview looks fine but the PDF is misaligned, especially maths"

**Why it happened**

The same text was being laid out at **three different widths**, with **absolute pixel** font
sizes:

| Surface | Width |
|---|---|
| Editor canvas | fluid — `calc(min(100%, 56rem) * zoom)` |
| Preview modal | `max-w-5xl` → **1024 px** |
| Exporter | **896 px** |

Identical text therefore wrapped in a different place in each one. That alone is enough to
make every PDF look "misaligned" compared with what you had just been looking at.

Three smaller mismatches compounded it:

- `word-break` / `overflow-wrap` existed **only** in the export path, so a long unbroken word
  wrapped in the PDF but overflowed on screen.
- Font families were emitted unquoted. `Source Sans 3` is **not** a valid unquoted CSS
  identifier (a component starts with a digit), so it silently fell back to sans-serif.
- The KaTeX flattening guessed vertical alignment from the strut's `vertical-align`, and
  measured a wrapping text node with a single rect (which returns the *union* of both lines).

**What changed**

- **`lib/slideRender.js` *(new)* — one source of truth.** The editor canvas, the preview modal
  and the exporter all import the same `frameStyle()` / `textStyle()` / `shapeInnerStyle()`
  functions. The exporter converts that identical object to a CSS string via `styleToCss()`.
  They cannot drift apart any more.
- **One fixed design surface.** Everything now *lays out* at exactly **896 × 504** and is only
  ever scaled with a CSS `transform`. A transform **cannot change where lines break**, so the
  editor, the preview and the exported PDF are guaranteed identical — on every screen size,
  on mobile, and at every zoom level. Resize handles are counter-scaled so they stay the same
  physical size.
- **`word-break` / `overflow-wrap` applied to all three paths.**
- **Font families are properly quoted** (`'Source Sans 3', sans-serif`), which also fixes the
  family silently disappearing on screen.
- **KaTeX flattening rewritten.** A zero-width **baseline probe** is inserted to measure the
  true text baseline instead of inferring it from the strut, so fractions, powers, roots and
  sub/superscripts sit exactly where they do on screen. Text nodes are split **per visual
  line**, intermediate backgrounds are painted behind glyphs, and the sandbox verifies the
  KaTeX webfonts are really loaded — bailing out to the main document rather than shipping a
  PDF rendered in a fallback font.
- **Preview modal rebuilt** on the same fixed surface, plus arrow-key and Escape navigation.

---

## Verification performed

- `npx next build` → **✓ Compiled successfully**, all 26 pages generated.
- **Persistence suite** (10/10) against a mock Firestore that enforces the real 1 MiB cap:
  - the original single-document write on a realistic 1.45 MB deck is **rejected** —
    reproducing the exact silent data loss;
  - the new chunked write **succeeds** (9 chunks) and reads back **byte-identical**;
  - the parent document stays at **194 bytes**;
  - shrinking a deck leaves no corrupt tail;
  - a notes save does **not** clobber the slides payload;
  - delete removes the document and every chunk.
- **Style-parity suite** (18/18): editor and exporter derive from the identical style object;
  quoting, unitless `line-height`, `min-height` vs `height`, and every typography property
  verified to survive the object → CSS-string conversion.

## Files added

```
lib/slideRender.js     one source of truth for slide geometry and element styling
lib/docStore.js        chunked, format-namespaced document storage + local safety net
lib/useAutoSave.js     autosave that only claims success when the server confirms it
```

## Files changed

```
lib/docs.js                        lib/slideExport.js       lib/slideStore.js
components/editor/Editor.js        components/notes/NotesEditor.js
components/studio/Studio.js        app/dashboard/page.js
app/dashboard/documents/page.js
```

## After deploying

Existing documents keep working — the reader falls back to the old inline format for anything
saved before this change, and migrates to chunks the first time you edit and save it.
