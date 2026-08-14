import { NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";
const digits = (s) => String(s || "").replace(/[^\d]/g, "");

export async function POST(request) {
  const authkey = process.env.MSG91_AUTHKEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  if (!authkey || !templateId) return NextResponse.json({ ok: false, error: "OTP service is not configured (MSG91)." }, { status: 500 });

  let body; try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }
  const e164 = String(body?.phone || "").trim();
  const mobile = digits(e164);
  const mode = body?.mode === "register" ? "register" : (body?.mode === "login" ? "login" : "");
  if (mobile.length < 12) return NextResponse.json({ ok: false, error: "Enter a valid mobile number." }, { status: 400 });

  // For LOGIN: do not send an OTP to an unregistered number — tell the client to go to /register.
  if (mode === "login") {
    try {
      await adminAuth().getUserByPhoneNumber(e164);
    } catch (e) {
      if (e?.code === "auth/user-not-found") {
        return NextResponse.json({ ok: false, notRegistered: true, error: "This number isn't registered. Please create an account." }, { status: 404 });
      }
      // Admin not configured / other transient error — don't block the OTP send.
    }
  }

  try {
    const url = `https://control.msg91.com/api/v5/otp?template_id=${templateId}&mobile=${mobile}&otp_length=6&otp_expiry=10`;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", authkey }, body: JSON.stringify({}) });
    const data = await res.json();
    if (data?.type === "success") return NextResponse.json({ ok: true });
    return NextResponse.json({ ok: false, error: data?.message || "Could not send the OTP." }, { status: 502 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "Could not reach the OTP service." }, { status: 502 });
  }
}
