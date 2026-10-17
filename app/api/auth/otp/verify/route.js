import { NextResponse } from "next/server";
import { ERROR_KIND, devOr, publicError } from "@/lib/userError";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";
const digits = (s) => String(s || "").replace(/[^\d]/g, "");

export async function POST(request) {
  const authkey = process.env.MSG91_AUTHKEY;
  if (!authkey) { console.error("[SlideBaba/otp] MSG91 is not configured (MSG91_AUTHKEY / MSG91_TEMPLATE_ID)."); return NextResponse.json({ ok: false, error: publicError("OTP service is not configured (MSG91).", ERROR_KIND.CONFIG, "login") }, { status: 500 }); }

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
    if (vd?.type !== "success") {
      console.error("[SlideBaba/otp] MSG91 verify rejected:", vd);
      const m = String(vd?.message || "").toLowerCase();
      const friendly = /already verified/.test(m)
        ? "This code was already used. Please tap Resend to get a new code."
        : /expire/.test(m)
          ? "This code has expired. Please tap Resend to get a new code."
          : "That code is incorrect. Please try again.";
      return NextResponse.json({ ok: false, error: devOr(vd?.message, friendly) }, { status: 401 });
    }
  } catch (e) {
    console.error("[SlideBaba/otp] MSG91 verify unreachable:", e);
    return NextResponse.json({ ok: false, error: "Could not verify the code. Please check your internet and try again." }, { status: 502 });
  }

  // 2) Firebase Admin
  let auth, fdb;
  try { auth = adminAuth(); fdb = adminDb(); }
  catch (e) {
    console.error("[SlideBaba] Firebase Admin init failed:", e?.message || e);
    return NextResponse.json({ ok: false, error: publicError("Auth server error: " + (e?.message || "could not initialise Firebase Admin."), ERROR_KIND.CONFIG, "login") }, { status: 500 });
  }

  // 3) Find or create the Firebase user (identity = phone number)
  let uid, isNew = false;
  try {
    const u = await auth.getUserByPhoneNumber(e164);
    uid = u.uid;
  } catch (lookupErr) {
    // Only a real "no such user" means there is no account. Anything else (bad Firebase
    // credentials, network) used to be reported as "No account found" too, which sent
    // existing users to register — log it and say the login service is unavailable instead.
    if (lookupErr?.code !== "auth/user-not-found") {
      console.error("[SlideBaba/otp] account lookup failed:", lookupErr?.code || "", lookupErr?.message || lookupErr);
      return NextResponse.json({ ok: false, error: publicError(`Account lookup failed: ${lookupErr?.code || ""} ${lookupErr?.message || lookupErr}`, ERROR_KIND.CONFIG, "login") }, { status: 500 });
    }
    if (mode !== "register") {
      return NextResponse.json({ ok: false, error: "No account found for this number. Please create an account." }, { status: 404 });
    }
    try {
      const created = await auth.createUser({ phoneNumber: e164, displayName: name || "SlideBaba User" });
      uid = created.uid; isNew = true;
    } catch (e) {
      console.error("[SlideBaba/otp] createUser failed:", e?.code || "", e?.message || e);
      return NextResponse.json({ ok: false, error: devOr(`Could not create your account: ${e?.code || ""} ${e?.message || e}`, "Could not create your account. Please try again.") }, { status: 500 });
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
        slidesLimit: 50, slidesUsed: 0, // Free plan allowance — keep in step with PLANS.free.slides
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
    console.error("[SlideBaba/otp] createCustomToken failed:", e?.code || "", e?.message || e);
    return NextResponse.json({ ok: false, error: devOr(`Could not start your session: ${e?.message || e}`, "Could not start your session. Please try again.") }, { status: 500 });
  }
}