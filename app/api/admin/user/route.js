import { NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

// Admin actions on a user: change role or delete. Secured by verifying the caller's
// Firebase ID token AND that the caller's own profile has role === "admin".
export async function POST(request) {
  let body; try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }
  const { action, uid, role, idToken } = body || {};
  if (!idToken || !uid || !action) return NextResponse.json({ ok: false, error: "Missing parameters." }, { status: 400 });

  let auth, fdb;
  try { auth = adminAuth(); fdb = adminDb(); }
  catch (e) { return NextResponse.json({ ok: false, error: "Auth server not configured." }, { status: 500 }); }

  // 1) verify caller + confirm caller is an admin
  let caller;
  try { caller = await auth.verifyIdToken(idToken); }
  catch { return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 }); }
  try {
    const me = await fdb.collection("users").doc(caller.uid).get();
    if (!me.exists || me.data().role !== "admin") {
      return NextResponse.json({ ok: false, error: "Admins only." }, { status: 403 });
    }
  } catch { return NextResponse.json({ ok: false, error: "Could not verify admin." }, { status: 500 }); }

  if (uid === caller.uid) return NextResponse.json({ ok: false, error: "You can't change or delete your own account here." }, { status: 400 });

  // 2) perform the action
  if (action === "setRole") {
    const next = role === "admin" ? "admin" : "user";
    try {
      await fdb.collection("users").doc(uid).set({ role: next }, { merge: true });
      return NextResponse.json({ ok: true, role: next });
    } catch (e) { return NextResponse.json({ ok: false, error: "Could not update role." }, { status: 500 }); }
  }

  if (action === "delete") {
    try {
      // read phone first so we can clean the phone index
      let phone = null;
      try { const u = await fdb.collection("users").doc(uid).get(); if (u.exists) phone = u.data().phone || null; } catch {}
      await auth.deleteUser(uid).catch(() => {}); // remove the Firebase Auth account (ignore if already gone)
      await fdb.collection("users").doc(uid).delete().catch(() => {});
      if (phone) await fdb.collection("phoneIndex").doc(phone).delete().catch(() => {});
      return NextResponse.json({ ok: true });
    } catch (e) { return NextResponse.json({ ok: false, error: "Could not delete the user." }, { status: 500 }); }
  }

  return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
}