"use client";

// Autosave that tells the truth.
//
// The old implementation did `setSaved(false); setTimeout(() => setSaved(true), 500)` — the
// "Saved" badge was on a timer and had nothing to do with whether Firestore had accepted
// anything. Combined with lib/docs.js swallowing every error, a project could fail to save
// for an entire session while the UI cheerfully reported success. That is why work
// disappeared when a document was reopened from My Documents.
//
// This hook only reports "Saved" after the server has acknowledged the write. If a save
// fails it says so, keeps retrying with backoff, and always keeps a local copy so nothing
// is ever lost in the meantime.

import { useCallback, useEffect, useRef, useState } from "react";
import { saveDocument, updateDocument } from "@/lib/docs";
import { hashString, localKey, saveLocalDraft, clearLocalDraft } from "@/lib/docStore";

const RETRY_MS = [3000, 8000, 20000, 45000];

export function useAutoSave({ user, docId, setDocId, build, format = "slides", delay = 1500 }) {
  const [status, setStatus] = useState("saved");   // saved | dirty | saving | error
  const [error, setError] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [rev, setRev] = useState(0);      // bumped on every edit so the debounce restarts

  const buildRef = useRef(build);
  buildRef.current = build;

  const docIdRef = useRef(docId);
  docIdRef.current = docId;

  const hashRef = useRef(null);        // hash of the last payload the server confirmed
  const chunksRef = useRef(null);      // chunk count of that payload, for cleanup
  const inFlight = useRef(false);
  const pending = useRef(false);       // a change arrived while a save was running
  const timer = useRef(null);
  const retry = useRef(0);
  const dirty = useRef(false);

  const key = localKey(user?.uid, docIdRef.current, format);

  /** Record that the document has changed. Also mirrors it locally straight away. */
  const markDirty = useCallback(() => {
    dirty.current = true;
    setRev((r) => r + 1);
    setStatus((s) => (s === "saving" ? s : "dirty"));
    try {
      const snap = buildRef.current?.();
      if (snap) saveLocalDraft(localKey(user?.uid, docIdRef.current, format), snap.payload, snap.meta);
    } catch {}
  }, [user?.uid, format]);

  const doSave = useCallback(async (force = false) => {
    if (!user?.uid) return { ok: false, reason: "auth" };
    if (inFlight.current) { pending.current = true; return { ok: false, reason: "busy" }; }

    let snap;
    try { snap = buildRef.current?.(); } catch (e) { snap = null; }
    if (!snap) return { ok: false, reason: "nothing" };

    const json = JSON.stringify(snap.payload);
    const h = hashString(json + "|" + JSON.stringify(snap.meta));
    if (!force && h === hashRef.current) {
      dirty.current = false;
      setStatus("saved");
      return { ok: true, unchanged: true };
    }

    inFlight.current = true;
    setStatus("saving");
    setError("");

    try {
      let id = docIdRef.current;
      if (id) {
        const res = await updateDocument(user.uid, id, { ...snap.meta, ...snap.payload }, { prevChunks: chunksRef.current });
        chunksRef.current = res?.chunks ?? chunksRef.current;
      } else {
        const res = await saveDocument(user.uid, { ...snap.meta, ...snap.payload });
        id = res.id;
        chunksRef.current = res.chunks ?? null;
        docIdRef.current = id;
        setDocId?.(id);
      }
      hashRef.current = h;
      retry.current = 0;
      dirty.current = false;
      setLastSavedAt(Date.now());
      setStatus(pending.current ? "dirty" : "saved");
      clearLocalDraft(localKey(user.uid, id, format));
      return { ok: true, id };
    } catch (e) {
      const msg = e?.code === "permission-denied"
        ? "Your session doesn't have permission to save. Try signing in again."
        : e?.code === "timeout"
          ? "Couldn't reach the server. Your work is kept on this device and will be saved when you're back online."
          : (e?.message || "Save failed.");
      console.error("[SlideBaba] save failed:", e?.code || "", e?.message || e);
      setError(msg);
      setStatus("error");
      // Keep the local mirror as the safety net.
      try { saveLocalDraft(localKey(user.uid, docIdRef.current, format), snap.payload, snap.meta); } catch {}
      return { ok: false, reason: "error", error: msg };
    } finally {
      inFlight.current = false;
      if (pending.current) { pending.current = false; dirty.current = true; }
    }
  }, [user?.uid, setDocId, format]);

  /** Debounced autosave loop + retry-with-backoff after a failure. */
  useEffect(() => {
    if (!user?.uid) return undefined;
    clearTimeout(timer.current);
    if (status === "dirty") {
      timer.current = setTimeout(() => { doSave(); }, delay);
    } else if (status === "error") {
      const wait = RETRY_MS[Math.min(retry.current, RETRY_MS.length - 1)];
      retry.current += 1;
      timer.current = setTimeout(() => { doSave(true); }, wait);
    }
    return () => clearTimeout(timer.current);
  }, [status, rev, doSave, delay, user?.uid, lastSavedAt]);

  /** Flush when the tab is hidden or closed — the two moments work used to vanish. */
  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const onHide = () => {
      if (document.visibilityState === "hidden" && dirty.current) doSave();
    };
    const onBeforeUnload = (e) => {
      if (!dirty.current) return undefined;
      try {
        const snap = buildRef.current?.();
        if (snap) saveLocalDraft(localKey(user?.uid, docIdRef.current, format), snap.payload, snap.meta);
      } catch {}
      e.preventDefault();
      e.returnValue = "";
      return "";
    };

    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [doSave, user?.uid, format]);

  /** Tell the hook what the server already has, so an untouched document isn't rewritten. */
  const primeFrom = useCallback((payload, meta, chunks) => {
    try {
      hashRef.current = hashString(JSON.stringify(payload) + "|" + JSON.stringify(meta || {}));
      chunksRef.current = chunks ?? null;
      dirty.current = false;
      setStatus("saved");
    } catch {}
  }, []);

  return {
    status,
    error,
    lastSavedAt,
    markDirty,
    saveNow: () => doSave(true),
    primeFrom,
    isDirty: () => dirty.current,
    localDraftKey: key,
  };
}
