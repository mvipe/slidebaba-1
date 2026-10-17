import { NextResponse } from "next/server";
import { ERROR_KIND, devOr, publicError } from "@/lib/userError";

export const runtime = "nodejs";
const digits = (s) => String(s || "").replace(/[^\d]/g, "");

export async function POST(request) {
  const authkey = process.env.MSG91_AUTHKEY;
  if (!authkey) { console.error("[SlideBaba/otp] MSG91 is not configured (MSG91_AUTHKEY / MSG91_TEMPLATE_ID)."); return NextResponse.json({ ok: false, error: publicError("OTP service is not configured (MSG91).", ERROR_KIND.CONFIG, "login") }, { status: 500 }); }

  let body; try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }
  const mobile = digits(body?.phone);
  if (mobile.length < 12) return NextResponse.json({ ok: false, error: "Enter a valid mobile number." }, { status: 400 });

  try {
    const url = `https://control.msg91.com/api/v5/otp/retry?mobile=${mobile}&retrytype=text`;
    const res = await fetch(url, { headers: { authkey } });
    const data = await res.json();
    if (data?.type === "success") return NextResponse.json({ ok: true });
    console.error("[SlideBaba/otp] MSG91 resend failed:", data);
    return NextResponse.json({ ok: false, error: devOr(data?.message, "Couldn't resend the code. Please wait a minute and try again.") }, { status: 502 });
  } catch (e) {
    console.error("[SlideBaba/otp] MSG91 resend unreachable:", e);
    return NextResponse.json({ ok: false, error: "Couldn't resend the code. Please check your internet and try again." }, { status: 502 });
  }
}
