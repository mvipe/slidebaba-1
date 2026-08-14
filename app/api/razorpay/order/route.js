import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Base amounts in paise.
const AMOUNTS = {
  monthly: { basic: 99900, medium: 199900, high: 299900 },
  yearly:  { basic: 999900, medium: 1999900, high: 2999900 },
};

// Validate a coupon by reading the public `coupons/{CODE}` doc via Firestore REST,
// then return the discounted amount (paise). Falls back to full price on any issue.
async function discounted(amount, rawCode) {
  const code = (rawCode || "").trim().toUpperCase();
  if (!code) return { amount, coupon: "" };
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!projectId || !apiKey) return { amount, coupon: "" };
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/coupons/${encodeURIComponent(code)}?key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return { amount, coupon: "" };
    const data = await res.json();
    const f = data.fields || {};
    const type = f.type?.stringValue || "percent";
    const value = Number(f.value?.integerValue ?? f.value?.doubleValue ?? 0);
    const active = f.active?.booleanValue !== false;
    const maxR = Number(f.maxRedemptions?.integerValue ?? 0);
    const used = Number(f.redemptions?.integerValue ?? 0);
    const expMs = f.expiresAt?.timestampValue ? new Date(f.expiresAt.timestampValue).getTime() : 0;
    if (!active) return { amount, coupon: "" };
    if (expMs && expMs < Date.now()) return { amount, coupon: "" };
    if (maxR && used >= maxR) return { amount, coupon: "" };
    if (!value) return { amount, coupon: "" };
    const next = type === "percent"
      ? Math.round(amount * (1 - value / 100))
      : Math.max(0, amount - Math.round(value * 100));
    return { amount: Math.max(100, next), coupon: code }; // Razorpay min ₹1
  } catch { return { amount, coupon: "" }; }
}

export async function POST(request) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return NextResponse.json({ ok: false, error: "Razorpay keys are not configured on the server." }, { status: 500 });
  }
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid body." }, { status: 400 }); }
  const plan = body?.plan;
  const period = body?.period === "yearly" ? "yearly" : "monthly";
  const base = AMOUNTS[period]?.[plan];
  if (!base) return NextResponse.json({ ok: false, error: "Unknown plan." }, { status: 400 });

  const { amount, coupon } = await discounted(base, body?.couponCode);

  try {
    const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ amount, currency: "INR", receipt: `sb_${plan}_${period}_${Date.now()}`, notes: { plan, period, coupon } }),
    });
    const order = await res.json();
    if (!res.ok) return NextResponse.json({ ok: false, error: order?.error?.description || "Razorpay order failed." }, { status: 502 });
    return NextResponse.json({ ok: true, orderId: order.id, amount: order.amount, currency: order.currency, coupon });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
