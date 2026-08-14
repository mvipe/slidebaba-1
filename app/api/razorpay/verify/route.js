import { NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

export async function POST(request) {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) return NextResponse.json({ ok: false, error: "Razorpay secret not configured." }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid body." }, { status: 400 }); }
  const { orderId, paymentId, signature } = body || {};
  if (!orderId || !paymentId || !signature) return NextResponse.json({ ok: false, error: "Missing payment fields." }, { status: 400 });

  const expected = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  let valid = false;
  try {
    valid = expected.length === String(signature).length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  } catch { valid = false; }

  if (!valid) return NextResponse.json({ ok: false, error: "Invalid payment signature." }, { status: 400 });
  return NextResponse.json({ ok: true, paymentId });
}
