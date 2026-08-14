import { NextResponse } from "next/server";

export const runtime = "nodejs";
const digits = (s) => String(s || "").replace(/[^\d]/g, "");

export async function POST(request) {
  const authkey = process.env.MSG91_AUTHKEY;
  if (!authkey) return NextResponse.json({ ok: false, error: "OTP service is not configured (MSG91)." }, { status: 500 });

  let body; try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }
  const mobile = digits(body?.phone);
  if (mobile.length < 12) return NextResponse.json({ ok: false, error: "Enter a valid mobile number." }, { status: 400 });

  try {
    const url = `https://control.msg91.com/api/v5/otp/retry?mobile=${mobile}&retrytype=text`;
    const res = await fetch(url, { headers: { authkey } });
    const data = await res.json();
    if (data?.type === "success") return NextResponse.json({ ok: true });
    return NextResponse.json({ ok: false, error: data?.message || "Could not resend the OTP." }, { status: 502 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "Could not reach the OTP service." }, { status: 502 });
  }
}
