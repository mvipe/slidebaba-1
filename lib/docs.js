import { db } from "@/lib/firebase";
import {
  collection, doc, addDoc, getDoc, getDocs, deleteDoc, serverTimestamp,
} from "firebase/firestore";
import { writeDocument, readPayload, deleteDocumentDeep, withTimeout } from "@/lib/docStore";

// Per-user data: users/{uid}/documents and users/{uid}/downloads.
// Firestore rules required (already published):
//   match /users/{uid}/{document=**} { allow read, write: if request.auth.uid == uid; }
//
// IMPORTANT: saveDocument()/updateDocument() now THROW when a save fails.
// They used to swallow the error, which meant the editor showed "Saved" while the work
// was actually being rejected by Firestore. Callers must handle the rejection and tell
// the user the truth.

function ms(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return 0;
}

/* Fields that can grow without bound and therefore must never live on the parent doc. */
const HEAVY_KEYS = ["slides", "notesHtml", "items"];

function split(data) {
  const meta = {};
  const payload = {};
  let hasPayload = false;
  for (const [k, v] of Object.entries(data || {})) {
    if (HEAVY_KEYS.includes(k)) { payload[k] = v; hasPayload = true; }
    else meta[k] = v;
  }
  return { meta, payload: hasPayload ? payload : null };
}

/* ---------- Documents ---------- */

/** Create a document. Returns { id }. Throws if the write fails. */
export async function saveDocument(uid, data) {
  if (!uid) throw new Error("You need to be signed in for your work to be saved.");
  const { meta, payload } = split(data);
  const res = await writeDocument(uid, null, meta, payload);
  return { id: res.id, hash: res.hash, chunks: res.chunks };
}

/** Update a document. Throws if the write fails. */
export async function updateDocument(uid, id, data, opts = {}) {
  if (!uid) throw new Error("You need to be signed in for your work to be saved.");
  if (!id) throw new Error("Missing document id.");
  const { meta, payload } = split(data);
  if (opts.prevChunks != null) meta.__prevChunks = opts.prevChunks;
  return writeDocument(uid, id, meta, payload, opts);
}

/**
 * Fire-and-forget metadata update for non-critical status flags.
 * Used where a failure genuinely does not matter (e.g. status: "extracted").
 */
export function touchDocument(uid, id, data) {
  updateDocument(uid, id, data).catch((e) =>
    console.warn("[SlideBaba] touchDocument:", e?.code || "", e?.message || e));
}

/** List documents. Only metadata is fetched, so this stays fast however big the projects are. */
export async function listDocuments(uid) {
  if (!uid) { console.warn("[SlideBaba] listDocuments skipped: not signed in"); return []; }
  try {
    const snap = await withTimeout(getDocs(collection(db, "users", uid, "documents")), 25000, "Loading your documents");
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    items.sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
    return items;
  } catch (e) {
    console.error("[SlideBaba] listDocuments FAILED:", e?.code || "", e?.message || e);
    return [];
  }
}

/**
 * Fetch a document's metadata plus its full payload.
 * `format` selects which payload namespace to read ("slides" or "notes") — they are stored
 * separately so opening a deck as A4 notes can never overwrite the slides.
 */
export async function loadDocument(uid, id, format) {
  if (!uid || !id) return null;
  const snap = await withTimeout(getDoc(doc(db, "users", uid, "documents", id)), 25000, "Loading");
  if (!snap.exists()) return null;
  const data = snap.data();
  const fmt = format || data.format || "slides";
  const payload = await readPayload(uid, id, data, { format: fmt });
  return { id, ...data, ...(payload || {}), chunkCount: data[`chunks_${fmt === "notes" ? "notes" : "slides"}`] ?? null };
}

export async function removeDocument(uid, id) {
  if (!uid || !id) return;
  try { await deleteDocumentDeep(uid, id); }
  catch (e) { console.error("[SlideBaba] removeDocument FAILED:", e?.code || "", e?.message || e); }
}

/* ---------- Downloads ---------- */
export async function saveDownload(uid, data) {
  if (!uid) { console.warn("[SlideBaba] saveDownload skipped: not signed in"); return null; }
  try {
    const ref = await addDoc(collection(db, "users", uid, "downloads"), { ...data, createdAt: serverTimestamp() });
    return ref;
  } catch (e) {
    console.error("[SlideBaba] saveDownload FAILED:", e?.code || "", e?.message || e);
    return null;
  }
}

export async function listDownloads(uid) {
  if (!uid) return [];
  try {
    const snap = await getDocs(collection(db, "users", uid, "downloads"));
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    items.sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    return items;
  } catch (e) {
    console.error("[SlideBaba] listDownloads FAILED:", e?.code || "", e?.message || e);
    return [];
  }
}

export async function removeDownload(uid, id) {
  if (!uid || !id) return;
  try { await deleteDoc(doc(db, "users", uid, "downloads", id)); }
  catch (e) { console.error("[SlideBaba] removeDownload FAILED:", e?.code || "", e?.message || e); }
}

/* ---------- Custom backgrounds (reusable library) ---------- */
export async function saveBackground(uid, url) {
  if (!uid || !url) return null;
  try { return await addDoc(collection(db, "users", uid, "backgrounds"), { url, createdAt: serverTimestamp() }); }
  catch (e) { console.error("[SlideBaba] saveBackground FAILED:", e?.code || "", e?.message || e); return null; }
}

export async function listBackgrounds(uid) {
  if (!uid) return [];
  try {
    const snap = await getDocs(collection(db, "users", uid, "backgrounds"));
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    items.sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    return items;
  } catch (e) { console.error("[SlideBaba] listBackgrounds FAILED:", e?.code || "", e?.message || e); return []; }
}

export async function removeBackground(uid, id) {
  if (!uid || !id) return;
  try { await deleteDoc(doc(db, "users", uid, "backgrounds", id)); }
  catch (e) { console.error("[SlideBaba] removeBackground FAILED:", e?.code || "", e?.message || e); }
}
