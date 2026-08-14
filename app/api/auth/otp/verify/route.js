import { NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";
const digits = (s) => String(s || "").replace(/[^\d]/g, "");

export async function POST(request) {
  const authkey = process.env.MSG91_AUTHKEY;
  if (!authkey) return NextResponse.json({ ok: false, error: "OTP service is not configured (MSG91)." }, { status: 500 });

  let body; try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }
  const e164 = String(body?.phone || "").trim();
  const mobile = digits(e164);
  const otp = digits(body?.otp);
  const mode = body?.mode === "register" ? "register" : "login";
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim();
  if (mobile.length < 12 || otp.length < 4) return NextResponse.json({ ok: false, error: "Enter the code we sent you." }, { status: 400 });

  // 1) Verify OTP with MSG91
  try {
    const vr = await fetch(`https://control.msg91.com/api/v5/otp/verify?otp=${encodeURIComponent(otp)}&mobile=${mobile}`, { headers: { authkey } });
    const vd = await vr.json();
    if (vd?.type !== "success") return NextResponse.json({ ok: false, error: vd?.message || "Invalid or expired OTP." }, { status: 401 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "Could not verify the OTP. Please try again." }, { status: 502 });
  }

  // 2) Firebase Admin
  let auth, fdb;
  try { auth = adminAuth(); fdb = adminDb(); }
  catch (e) {
    console.error("[SlideBaba] Firebase Admin init failed:", e?.message || e);
    return NextResponse.json({ ok: false, error: "Auth server error: " + (e?.message || "could not initialise Firebase Admin.") }, { status: 500 });
  }

  // 3) Find or create the Firebase user (identity = phone number)
  let uid, isNew = false;
  try {
    const u = await auth.getUserByPhoneNumber(e164);
    uid = u.uid;
  } catch {
    if (mode !== "register") {
      return NextResponse.json({ ok: false, error: "No account found for this number. Please create an account." }, { status: 404 });
    }
    try {
      const created = await auth.createUser({ phoneNumber: e164, displayName: name || "SlideBaba User" });
      uid = created.uid; isNew = true;
    } catch (e) {
      return NextResponse.json({ ok: false, error: "Could not create your account. Please try again." }, { status: 500 });
    }
  }

  // 4) Ensure Firestore profile + phone index exist
  try {
    const ref = fdb.collection("users").doc(uid);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        uid,
        fullName: name || "SlideBaba User",
        email: email || "",
        phone: e164,
        plan: "free",
        period: "monthly",
        docsLimit: 2, docsUsed: 0, snipsLimit: 2, snipsUsed: 0,
        createdAt: FieldValue.serverTimestamp(),
      });
      await fdb.collection("phoneIndex").doc(e164).set({ uid, email: email || "" });
    }
  } catch (e) {
    console.error("[SlideBaba] profile ensure failed:", e?.message || e);
  }

  // 5) Mint a Firebase custom token so the client can sign in
  try {
    const token = await auth.createCustomToken(uid);
    return NextResponse.json({ ok: true, token, isNew });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "Could not start your session." }, { status: 500 });
  }
}