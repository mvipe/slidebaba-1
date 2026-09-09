// Durable document storage.
//
// WHY THIS FILE EXISTS
//   Slides (and notes HTML) embed images as base64 data URLs. The whole thing used to be
//   written into a SINGLE Firestore document, and a Firestore document is hard-capped at
//   1 MiB. As soon as a project picked up a couple of pictures — i.e. after a few minutes
//   of real work — every write was rejected with `invalid-argument`. lib/docs.js swallowed
//   that error, the editor still displayed "Saved", and the work was silently lost.
//
//   So the heavy part of a document is serialised, split into chunks and stored in a
//   `payload_<format>` subcollection; the parent document holds only small metadata.
//
// WHAT THE FIRST VERSION OF THAT FIX GOT WRONG — and what this version repairs
//
//   1. CHUNKS FROM TWO WRITERS INTERLEAVED, CORRUPTING THE DOCUMENT FOREVER.
//      Chunk ids were just the index ("00000", "00001", …). Studio fires an unawaited
//      save when the preview renders, another when you click Open, and the editor's
//      autosave starts a third — three overlapping writers into ONE namespace. Chunk 3
//      could come from writer A and chunk 4 from writer B, so the concatenation was not
//      valid JSON and `JSON.parse` threw on every subsequent open. That is the
//      "old files won't open" bug, and it was unrecoverable once it happened.
//
//      FIX: every save writes into its own GENERATION (`<rev>-00000`, `<rev>-00001`, …)
//      and the parent pointer names the rev. Concurrent writers therefore cannot mix:
//      each writes a complete, self-consistent generation, and the pointer flip — a
//      single atomic setDoc — decides which one wins. A reader only ever sees chunks
//      from one generation. Old generations are swept afterwards.
//
//   2. BATCHES COULD EXCEED FIRESTORE'S 10 MiB WRITE LIMIT.
//      400 ops × 180 000 chars ≈ 72 MB in one commit(). Firestore caps a write REQUEST at
//      10 MiB, not just 500 operations, so any deck over ~10 MB failed outright — and
//      because the pointer is committed last, the document silently stayed on its
//      previous version.
//      FIX: batches are now capped by BYTES as well as op count.
//
//   3. AN OVERSIZED PARENT DOC FAILED WITH AN OPAQUE FIRESTORE ERROR.
//      A base64 logo in `meta.header` is written to the parent, which is capped at 1 MiB.
//      FIX: the parent payload is measured before writing and rejected with a message
//      that says what to do. (lib/docs.js also routes `header` into the heavy payload.)
//
//   4. WRITES TO THE SAME DOCUMENT RACED EACH OTHER.
//      FIX: writes are serialised per (uid, doc, format) through a promise queue, so the
//      last save wins in order instead of by luck.

import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, writeBatch, serverTimestamp,
} from "firebase/firestore";

/** Chars per chunk. Kept small so that even 4-byte UTF-8 text stays far below the 1 MiB cap. */
const CHUNK_CHARS = 180000;
/** Firestore allows 500 ops per batch; leave headroom. */
const BATCH_LIMIT = 400;
/**
 * Firestore rejects a write REQUEST larger than 10 MiB regardless of the op count.
 * 8 MB of payload leaves room for keys, overhead and multi-byte expansion.
 */
const BATCH_BYTES = 8_000_000;
/** A Firestore document is capped at 1 MiB; refuse well before that with a real message. */
const PARENT_META_MAX = 900_000;

/* ---------------- generic helpers ---------------- */

export class TimeoutError extends Error {
  constructor(label) {
    super(`${label} timed out — the network looks unavailable.`);
    this.name = "TimeoutError";
    this.code = "timeout";
  }
}

/**
 * Never let a hung Firestore promise block the UI forever.
 * This is what stops a stuck write from freezing the Download button.
 */
export function withTimeout(promise, ms, label = "Request") {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(label)), ms); }),
  ]);
}

/** Cheap, stable content hash so identical payloads are never re-uploaded. */
export function hashString(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2654435761) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}${s.length.toString(36)}`;
}

function splitChunks(str) {
  const out = [];
  for (let i = 0; i < str.length; i += CHUNK_CHARS) out.push(str.slice(i, i + CHUNK_CHARS));
  return out.length ? out : [""];
}

/* Payload collections are namespaced BY FORMAT.
   The documents list lets you open the same record either as slides ("PPT") or as A4 notes,
   and each editor persists a different shape. With one shared payload area, opening a deck
   as notes and typing a single character would replace the slides with an empty notes body.
   Separate namespaces make that impossible. */
function fmtKey(format) {
  return format === "notes" ? "notes" : "slides";
}
function payloadCol(uid, docId, format) {
  return collection(db, "users", uid, "documents", docId, `payload_${fmtKey(format)}`);
}
function chunkField(format) {
  return `chunks_${fmtKey(format)}`;
}
function revField(format) {
  return `rev_${fmtKey(format)}`;
}

/**
 * A generation id for one save. Time-prefixed so generations sort chronologically,
 * random-suffixed so two writers in the same millisecond cannot collide.
 */
function newRev() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Chunk document id within a generation: "<rev>-00007". */
function chunkId(rev, i) {
  return `${rev}-${String(i).padStart(5, "0")}`;
}

/** True when this chunk doc belongs to `rev`. Legacy chunks (bare "00007") belong to none. */
function idBelongsToRev(id, rev) {
  return Boolean(rev) && String(id).startsWith(`${rev}-`);
}

/* ---------------- per-document write queue ----------------
   Studio, the editor's autosave and an explicit "Open" click can all try to save the same
   document at the same moment. Generations already make that SAFE; serialising makes it
   ORDERLY, so the last save issued is the last one applied instead of whichever finishes
   first. The queue is per (uid, doc, format) so unrelated documents never block. */

const writeQueues = new Map();

function enqueue(key, task) {
  const prev = writeQueues.get(key) || Promise.resolve();
  // Never let a rejected predecessor break the chain for the next writer.
  const next = prev.catch(() => {}).then(task);
  writeQueues.set(key, next);
  next.catch(() => {}).finally(() => {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  });
  return next;
}

/* ---------------- write ---------------- */

/**
 * Create or update a document.
 *
 * @param uid      owner
 * @param docId    existing id, or null to create
 * @param meta     small fields kept on the parent doc (name, format, status, …)
 * @param payload  the heavy object ({ slides } or { notesHtml, header, … }); pass null to
 *                 only update metadata.
 * @returns { id, hash, chunks, rev }
 * @throws on any failure — callers MUST surface this instead of pretending it saved.
 */
export async function writeDocument(uid, docId, meta = {}, payload = null, opts = {}) {
  if (!uid) throw new Error("Not signed in.");
  const format = meta.format || opts.format || "slides";
  const key = `${uid}|${docId || "new"}|${fmtKey(format)}`;
  return enqueue(key, () => writeDocumentNow(uid, docId, meta, payload, opts));
}

async function writeDocumentNow(uid, docId, meta = {}, payload = null, opts = {}) {
  const timeout = opts.timeout || 25000;

  let id = docId;
  const { __prevChunks, ...cleanMeta } = meta;
  const format = cleanMeta.format || opts.format || "slides";
  const cField = chunkField(format);
  const rField = revField(format);
  const parentMeta = { ...cleanMeta, updatedAt: serverTimestamp() };

  // Guard the 1 MiB parent cap BEFORE writing, so an oversized logo produces a sentence a
  // human can act on rather than Firestore's "invalid-argument".
  const metaBytes = JSON.stringify(cleanMeta || {}).length;
  if (metaBytes > PARENT_META_MAX) {
    throw new Error(
      `This document's settings are too large to save (${Math.round(metaBytes / 1024)} KB). ` +
      "This is almost always a very large logo or background image — use a smaller one."
    );
  }

  // 1) Make sure the parent document exists (metadata only — always tiny).
  if (!id) {
    const ref = await withTimeout(
      addDoc(collection(db, "users", uid, "documents"), { ...parentMeta, createdAt: serverTimestamp(), [cField]: 0 }),
      timeout, "Creating the document",
    );
    id = ref.id;
  }

  if (!payload) {
    await withTimeout(
      setDoc(doc(db, "users", uid, "documents", id), parentMeta, { merge: true }),
      timeout, "Saving",
    );
    return { id, hash: null, chunks: null, rev: null };
  }

  // 2) Serialise + chunk the heavy part into a fresh generation.
  const json = JSON.stringify(payload);
  const hash = hashString(json);
  const chunks = splitChunks(json);
  const rev = newRev();

  // 3) Write this generation's chunks, batching by BOTH op count and bytes.
  let batch = writeBatch(db);
  let ops = 0;
  let bytes = 0;
  for (let i = 0; i < chunks.length; i++) {
    const s = chunks[i];
    // Commit before adding an op that would push this request over either limit.
    if (ops > 0 && (ops >= BATCH_LIMIT || bytes + s.length > BATCH_BYTES)) {
      await withTimeout(batch.commit(), timeout, "Saving your work");
      batch = writeBatch(db);
      ops = 0;
      bytes = 0;
    }
    batch.set(doc(payloadCol(uid, id, format), chunkId(rev, i)), { i, s, rev });
    ops += 1;
    bytes += s.length;
  }
  if (ops > 0) await withTimeout(batch.commit(), timeout, "Saving your work");

  // 4) Flip the pointer. ONE atomic write, and only now does the new generation become
  //    current — so a half-written generation is never readable, and a concurrent writer
  //    either wins this race outright or loses it outright. There is no in-between.
  await withTimeout(
    setDoc(
      doc(db, "users", uid, "documents", id),
      {
        ...parentMeta,
        [cField]: chunks.length,
        [rField]: rev,
        [`hash_${fmtKey(format)}`]: hash,
        bytes: json.length,
      },
      { merge: true },
    ),
    timeout, "Saving",
  );

  // 5) Sweep superseded generations. Best-effort: the document is already correct without
  //    it, and a stale chunk can never be read now that reads are filtered by rev.
  sweepOldChunks(uid, id, format, rev, timeout);

  return { id, hash, chunks: chunks.length, rev };
}

/** Delete every chunk that is not part of the current generation. Never throws. */
async function sweepOldChunks(uid, docId, format, keepRev, timeout = 25000) {
  try {
    const snap = await withTimeout(getDocs(payloadCol(uid, docId, format)), timeout, "Tidying up");
    const stale = snap.docs.filter((d) => !idBelongsToRev(d.id, keepRev));
    for (let start = 0; start < stale.length; start += BATCH_LIMIT) {
      const batch = writeBatch(db);
      stale.slice(start, start + BATCH_LIMIT).forEach((d) => batch.delete(d.ref));
      await withTimeout(batch.commit(), timeout, "Tidying up");
    }
  } catch (e) {
    console.warn("[SlideBaba] could not sweep old payload chunks:", e?.message || e);
  }
}

/* ---------------- read ---------------- */

/**
 * Read the heavy payload back.
 *
 * Reads are filtered to the generation named by the parent pointer, which is what makes a
 * concurrent save harmless. Documents written before generations existed (bare numeric
 * chunk ids, no `rev_*` field) are still read the old way.
 *
 * @returns the payload object, or null when this format has nothing stored.
 * @throws  only when data exists but cannot be assembled.
 */
export async function readPayload(uid, docId, parentData = null, opts = {}) {
  if (!uid || !docId) return null;
  const timeout = opts.timeout || 25000;
  const format = opts.format || parentData?.format || "slides";
  const cField = chunkField(format);
  const rField = revField(format);

  let parent = parentData;
  if (!parent) {
    const snap = await withTimeout(getDoc(doc(db, "users", uid, "documents", docId)), timeout, "Loading");
    if (!snap.exists()) return null;
    parent = snap.data();
  }

  const count = Number(parent[cField] ?? (fmtKey(format) === "slides" ? parent.chunks : 0)) || 0;
  const rev = parent[rField] || "";

  if (count > 0) {
    const snap = await withTimeout(getDocs(payloadCol(uid, docId, format)), timeout, "Loading your document");

    // Take only this generation's chunks. Legacy documents have no rev, so fall back to
    // every chunk whose id is bare-numeric.
    const all = snap.docs.map((d) => ({ id: d.id, i: Number(d.data().i ?? d.id), s: d.data().s || "" }));
    const parts = (rev ? all.filter((p) => idBelongsToRev(p.id, rev)) : all.filter((p) => /^\d+$/.test(p.id)))
      .sort((a, b) => a.i - b.i);

    if (parts.length < count) {
      throw new Error(
        `This document is incomplete (${parts.length}/${count} parts loaded). ` +
        "Check your connection and reload — nothing has been lost."
      );
    }
    try {
      return JSON.parse(parts.slice(0, count).map((p) => p.s).join(""));
    } catch {
      throw new Error(
        "This document's saved data could not be read back. Open it in the other format " +
        "(A4 / PPT) if that version is intact, or re-scan the original file."
      );
    }
  }

  // Legacy inline document (saved before chunking existed).
  const legacy = {};
  if (parent.slides) legacy.slides = parent.slides;
  if (parent.notesHtml) legacy.notesHtml = parent.notesHtml;
  if (parent.items) legacy.items = parent.items;
  if (parent.header) legacy.header = parent.header;
  if (parent.cols) legacy.cols = parent.cols;
  return Object.keys(legacy).length ? legacy : null;
}

/**
 * Which formats this document actually has content for.
 * The Documents list uses it so it cannot offer to open a deck that was never saved as
 * slides — doing so used to hand the editor an empty array, which silently forked a
 * brand-new document and orphaned the original.
 */
export function storedFormats(parent = {}) {
  const has = (fmt) =>
    Number(parent[chunkField(fmt)] ?? 0) > 0 ||
    (fmt === "slides" && (Number(parent.chunks ?? 0) > 0 || Array.isArray(parent.slides))) ||
    (fmt === "notes" && typeof parent.notesHtml === "string" && parent.notesHtml.length > 0);
  return { slides: has("slides"), notes: has("notes") };
}

/** Delete a document together with all of its payload chunks. */
export async function deleteDocumentDeep(uid, docId) {
  if (!uid || !docId) return;
  for (const format of ["slides", "notes"]) {
    try {
      const snap = await getDocs(payloadCol(uid, docId, format));
      for (let start = 0; start < snap.docs.length; start += BATCH_LIMIT) {
        const batch = writeBatch(db);
        snap.docs.slice(start, start + BATCH_LIMIT).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (e) {
      console.warn("[SlideBaba] could not clear payload chunks:", e?.message || e);
    }
  }
  await deleteDoc(doc(db, "users", uid, "documents", docId));
}

/* ---------------- local safety net ----------------
   Even with all of the above, a browser can be closed mid-flight or the network can die.
   A local mirror means work is never lost: on reopening, anything newer than the cloud
   copy is restored automatically. */

const LOCAL_PREFIX = "slidebaba:draft:";
const LOCAL_BUDGET = 4_000_000; // localStorage is ~5 MB; stay well under it.

export function localKey(uid, docId, format) {
  return `${LOCAL_PREFIX}${uid || "anon"}:${format || "slides"}:${docId || "new"}`;
}

export function saveLocalDraft(key, payload, meta = {}) {
  if (typeof window === "undefined") return false;
  try {
    const body = JSON.stringify({ at: Date.now(), meta, payload });
    if (body.length > LOCAL_BUDGET) { pruneLocalDrafts(key); return false; }
    window.localStorage.setItem(key, body);
    return true;
  } catch {
    // Quota exceeded — drop other drafts and try once more.
    try {
      pruneLocalDrafts(key);
      window.localStorage.setItem(key, JSON.stringify({ at: Date.now(), meta, payload }));
      return true;
    } catch { return false; }
  }
}

export function readLocalDraft(key) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearLocalDraft(key) {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(key); } catch {}
}

function pruneLocalDrafts(keep) {
  try {
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(LOCAL_PREFIX) && k !== keep) keys.push(k);
    }
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch {}
}
