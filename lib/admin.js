// Admin-only data access: payments/revenue + global (admin-uploaded) backgrounds.
import { db } from "@/lib/firebase";
import { collection, getDocs, addDoc, deleteDoc, doc, serverTimestamp } from "firebase/firestore";

// Gate the admin UI. Owner sets users/{uid}.role = "admin" in the Firebase console.
export function isAdmin(profile) {
  return !!profile && profile.role === "admin";
}

function ms(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts.seconds) return ts.seconds * 1000;
  return new Date(ts).getTime() || 0;
}

/* ---------- payments / revenue ---------- */
export async function listPayments() {
  try {
    const snap = await getDocs(collection(db, "payments"));
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  } catch (e) { console.error("[SlideBaba] listPayments FAILED:", e?.code || "", e?.message || e); return []; }
}

// amounts are stored in paise
export function revenueSummary(payments) {
  const totalPaise = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const byPlan = {};
  for (const p of payments) {
    const key = `${p.plan || "?"}`;
    byPlan[key] = (byPlan[key] || 0) + (Number(p.amount) || 0);
  }
  return { totalPaise, total: totalPaise / 100, count: payments.length, byPlan };
}

/* ---------- global backgrounds (admin upload → all users can apply) ---------- */
export async function addGlobalBackground(url, name = "Background") {
  try { return await addDoc(collection(db, "globalBackgrounds"), { url, name, createdAt: serverTimestamp() }); }
  catch (e) { console.error("[SlideBaba] addGlobalBackground FAILED:", e?.code || "", e?.message || e); return null; }
}

export async function listGlobalBackgrounds() {
  try {
    const snap = await getDocs(collection(db, "globalBackgrounds"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  } catch (e) { console.error("[SlideBaba] listGlobalBackgrounds FAILED:", e?.code || "", e?.message || e); return []; }
}

export async function removeGlobalBackground(id) {
  try { await deleteDoc(doc(db, "globalBackgrounds", id)); }
  catch (e) { console.error("[SlideBaba] removeGlobalBackground FAILED:", e?.code || "", e?.message || e); }
}

/* ---------- global fonts (admin adds → all users can use in the editor) ---------- */
// A font is { name: "Poppins", url: "https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&display=swap" }
export async function addGlobalFont(name, url = "") {
  const fam = (name || "").trim();
  if (!fam) throw new Error("Font family name is required.");
  try { return await addDoc(collection(db, "globalFonts"), { name: fam, url: (url || "").trim(), createdAt: serverTimestamp() }); }
  catch (e) { console.error("[SlideBaba] addGlobalFont FAILED:", e?.code || "", e?.message || e); return null; }
}

export async function listGlobalFonts() {
  try {
    const snap = await getDocs(collection(db, "globalFonts"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  } catch (e) { console.error("[SlideBaba] listGlobalFonts FAILED:", e?.code || "", e?.message || e); return []; }
}

export async function removeGlobalFont(id) {
  try { await deleteDoc(doc(db, "globalFonts", id)); }
  catch (e) { console.error("[SlideBaba] removeGlobalFont FAILED:", e?.code || "", e?.message || e); }
}

// Inject a <link> for an admin font URL once (browser only).
export function ensureFontLoaded(url) {
  if (typeof document === "undefined" || !url) return;
  const id = "gfont-" + btoa(url).replace(/[^a-z0-9]/gi, "").slice(0, 24);
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id; link.rel = "stylesheet"; link.href = url;
  document.head.appendChild(link);
}

/* ---------- users (admin: list, change role, delete) ---------- */
export async function listAllUsers() {
  try {
    const snap = await getDocs(collection(db, "users"));
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (ms(b.createdAt) - ms(a.createdAt)));
  } catch (e) { console.error("[SlideBaba] listAllUsers FAILED:", e?.code || "", e?.message || e); return []; }
}