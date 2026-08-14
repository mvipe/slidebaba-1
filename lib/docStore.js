// Durable document storage.
//
// THE BUG THIS FIXES
//   Slides (and notes HTML) embed images as base64 data URLs. The whole thing used to be
//   written into a SINGLE Firestore document, and a Firestore document is hard-capped at
//   1 MiB. As soon as a project picked up a couple of pictures — i.e. after a few minutes
//   of real work — every write was rejected with `invalid-argument`. lib/docs.js swallowed
//   that error, the editor still displayed "Saved", and the work was silently lost. On top
//   of that the rejected 1 MB writes clogged the Firestore write queue, so the `updateDoc`
//   inside consume() (which the Download button awaits) never resolved — which is why
//   downloading stopped working after a while.
//
// THE FIX
//   The heavy part of a document is serialised, split into small chunks and stored in a
//   `payload` subcollection. The parent document only ever holds small metadata, so it can
//   never exceed the limit no matter how many images are added, and listing "My Documents"
//   no longer downloads megabytes. Every write is verified and errors are propagated, so
//   the UI can tell the truth about whether the work is actually safe.

import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, writeBatch, serverTimestamp,
} from "firebase/firestore";

/** Chars per chunk. Kept small so that even 4-byte UTF-8 text stays far below the 1 MiB cap. */
const CHUNK_CHARS = 180000;
const BATCH_LIMIT = 400; // Firestore allows 500 ops per batch; leave headroom.

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

/* ---------------- write ---------------- */

/**
 * Create or update a document.
 *
 * @param uid      owner
 * @param docId    existing id, or null to create
 * @param meta     small fields kept on the parent doc (name, format, status, …)
 * @param payload  the heavy object ({ slides } or { notesHtml, header, … }); pass null to
 *                 only update metadata.
 * @returns { id, hash, chunks }
 * @throws on any failure — callers MUST surface this instead of pretending it saved.
 */
export async function writeDocument(uid, docId, meta = {}, payload = null, opts = {}) {
  if (!uid) throw new Error("Not signed in.");
  const timeout = opts.timeout || 25000;

  let id = docId;
  const prev = Number(meta.__prevChunks ?? NaN);
  const { __prevChunks, ...cleanMeta } = meta;
  const format = cleanMeta.format || opts.format || "slides";
  const cField = chunkField(format);
  const parentMeta = { ...cleanMeta, updatedAt: serverTimestamp() };

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
    return { id, hash: null, chunks: null };
  }

  // 2) Serialise + chunk the heavy part.
  const json = JSON.stringify(payload);
  const hash = hashString(json);
  const chunks = splitChunks(json);

  // 3) Write chunks in batches.
  for (let start = 0; start < chunks.length; start += BATCH_LIMIT) {
    const batch = writeBatch(db);
    const slice = chunks.slice(start, start + BATCH_LIMIT);
    slice.forEach((s, k) => {
      const i = start + k;
      batch.set(doc(payloadCol(uid, id, format), String(i).padStart(5, "0")), { i, s });
    });
    await withTimeout(batch.commit(), timeout, "Saving your work");
  }

  // 4) Drop chunks left over from a previously larger version.
  if (Number.isFinite(prev) && prev > chunks.length) {
    const batch = writeBatch(db);
    for (let i = chunks.length; i < prev && i < chunks.length + BATCH_LIMIT; i++) {
      batch.delete(doc(payloadCol(uid, id, format), String(i).padStart(5, "0")));
    }
    try { await withTimeout(batch.commit(), timeout, "Tidying up"); } catch { /* non-fatal */ }
  }

  // 5) Commit the pointer LAST, so a half-written payload is never considered current.
  await withTimeout(
    setDoc(
      doc(db, "users", uid, "documents", id),
      { ...parentMeta, [cField]: chunks.length, [`hash_${fmtKey(format)}`]: hash, bytes: json.length },
      { merge: true },
    ),
    timeout, "Saving",
  );

  return { id, hash, chunks: chunks.length };
}

/* ---------------- read ---------------- */

/** Read the heavy payload back. Falls back to the old inline format for legacy documents. */
export async function readPayload(uid, docId, parentData = null, opts = {}) {
  if (!uid || !docId) return null;
  const timeout = opts.timeout || 25000;
  const format = opts.format || parentData?.format || "slides";
  const cField = chunkField(format);

  let parent = parentData;
  if (!parent) {
    const snap = await withTimeout(getDoc(doc(db, "users", uid, "documents", docId)), timeout, "Loading");
    if (!snap.exists()) return null;
    parent = snap.data();
  }

  const count = Number(parent[cField] ?? (fmtKey(format) === "slides" ? parent.chunks : 0)) || 0;
  if (count > 0) {
    const snap = await withTimeout(getDocs(payloadCol(uid, docId, format)), timeout, "Loading your document");
    const parts = snap.docs
      .map((d) => ({ i: Number(d.data().i ?? d.id), s: d.data().s || "" }))
      .sort((a, b) => a.i - b.i);
    if (parts.length < count) {
      throw new Error(`This document is incomplete (${parts.length}/${count} parts loaded). Check your connection and reload.`);
    }
    try {
      // Extra chunks can linger from a previously larger version — only the first N count.
      return JSON.parse(parts.slice(0, count).map((p) => p.s).join(""));
    } catch {
      throw new Error("This document could not be read back. It may have been saved while offline.");
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
