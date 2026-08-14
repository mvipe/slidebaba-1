// Plan catalogue, billing cycle, credits, branding, and Razorpay checkout.
import { db } from "@/lib/firebase";
import { doc, updateDoc, getDoc, serverTimestamp, increment, addDoc, collection } from "firebase/firestore";
import { redeemCoupon } from "@/lib/coupons";

// credits = "AI Credits" (snippets/AI runs) · docs = "Documents" (downloads)
export const PLANS = {
  free:   { label: "Free",   m: 0,    y: 0,     credits: { m: 2,   y: 2 },    docs: { m: 2,   y: 2 },    slides: { m: "2",       y: "2" },         maxSlidesPerDoc: { m: 25, y: 25 }, maxPages: { m: 25,  y: 25 },  pdf: true, ppt: true,  branding: true, teaching: false },
  basic:  { label: "Basic",  m: 999,  y: 9999,  credits: { m: 150, y: 2400 }, docs: { m: 150, y: 2400 }, slides: { m: "3,000+",  y: "36,000+" },   maxSlidesPerDoc: { m: 100, y: 100 }, maxPages: { m: 100, y: 100 }, pdf: true, ppt: false, branding: true, teaching: false },
  medium: { label: "Medium", m: 1999, y: 19990, credits: { m: 400, y: 5400 }, docs: { m: 400, y: 5400 }, slides: { m: "8,000+",  y: "96,000+" },   maxSlidesPerDoc: { m: 150, y: 150 }, maxPages: { m: 150, y: 150 }, pdf: true, ppt: true,  branding: true, teaching: false },
  high:   { label: "High",   m: 2999, y: 29990, credits: { m: 749, y: 9600 }, docs: { m: 749, y: 9600 }, slides: { m: "15,000+", y: "1,80,000+" }, maxSlidesPerDoc: { m: 200, y: 200 }, maxPages: { m: 200, y: 200 }, pdf: true, ppt: true,  branding: true, teaching: true },
};
export const PLAN_ORDER = ["free", "basic", "medium", "high"];
export const RANK = { free: 0, basic: 1, medium: 2, high: 3 };

// Single source of truth for every per-plan numeric limit.
// NOTE: maxPages / maxSlidesPerDoc must live here — maxPagesFor() reads them from
// this object, and if they're missing the page gate silently compares against
// `undefined` (always false) and never fires.
export function planLimits(plan, period = "monthly") {
  const p = PLANS[plan] || PLANS.free;
  const k = period === "yearly" ? "y" : "m";
  return {
    docs: p.docs?.[k] ?? PLANS.free.docs.m,
    snips: p.credits?.[k] ?? PLANS.free.credits.m,
    maxPages: p.maxPages?.[k] ?? p.maxPages?.m ?? PLANS.free.maxPages.m,
    maxSlidesPerDoc: p.maxSlidesPerDoc?.[k] ?? p.maxSlidesPerDoc?.m ?? PLANS.free.maxSlidesPerDoc.m,
  };
}

export function planMeta(profile, periodOverride) {
  const plan = profile?.plan || "free";
  const period = periodOverride || profile?.period || "monthly";
  const lim = planLimits(plan, period);
  return {
    plan,
    period,
    key: period === "yearly" ? "y" : "m",
    maxSlidesPerDoc: lim.maxSlidesPerDoc,
    maxPages: lim.maxPages,
  };
}

// Max PDF pages this profile is allowed to scan in one document.
// Always returns a finite positive number so the caller can compare safely.
export function maxPagesFor(profile, periodOverride) {
  const n = Number(planMeta(profile, periodOverride).maxPages);
  return Number.isFinite(n) && n > 0 ? n : PLANS.free.maxPages.m;
}

export function canCreateSlides(profile, slidesCount, periodOverride) {
  const { maxSlidesPerDoc } = planMeta(profile, periodOverride);
  const count = Number(slidesCount || 0);
  if (!count) return { ok: true, maxSlidesPerDoc, slidesCount: 0 };
  return {
    ok: count <= maxSlidesPerDoc,
    reason: count > maxSlidesPerDoc ? "limit" : null,
    maxSlidesPerDoc,
    slidesCount: count,
  };
}

function ms(ts) {
  if (!ts) return Date.now();
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts.seconds) return ts.seconds * 1000;
  return new Date(ts).getTime();
}

export function cycleInfo(profile) {
  const plan = profile?.plan || "free";
  const period = profile?.period || "monthly";
  const days = period === "yearly" ? 365 : 30;
  // Free tier refills on a rolling monthly cycle (cycleStart). A PAID plan is valid for exactly
  // one period from when it was actually purchased (planSince) — never from cycleStart, so it
  // cannot keep renewing itself for free. After that it must be paid for again.
  const start = plan === "free"
    ? ms(profile?.cycleStart || profile?.createdAt)
    : ms(profile?.planSince || profile?.cycleStart || profile?.createdAt);
  const renew = start + days * 86400000;
  const now = Date.now();
  return { period, start: new Date(start), renew: new Date(renew), daysLeft: Math.max(0, Math.ceil((renew - now) / 86400000)), expired: now >= renew };
}

export function remaining(profile) {
  const lim = planLimits(profile?.plan || "free", profile?.period || "monthly");
  const docsLimit = profile?.docsLimit ?? lim.docs;
  const snipsLimit = profile?.snipsLimit ?? lim.snips;
  return {
    docsLimit, snipsLimit,
    docsLeft: Math.max(0, docsLimit - (profile?.docsUsed ?? 0)),
    snipsLeft: Math.max(0, snipsLimit - (profile?.snipsUsed ?? 0)),
  };
}

export async function maybeRenew(uid, profile) {
  if (!uid || !profile) return null;
  if (!cycleInfo(profile).expired) return null;

  const plan = profile.plan || "free";

  // FREE tier: refill the free monthly credits and roll the cycle forward — this is the only
  // plan that auto-renews (it's free).
  if (plan === "free") {
    const lim = planLimits("free", "monthly");
    try {
      await updateDoc(doc(db, "users", uid), { docsUsed: 0, snipsUsed: 0, docsLimit: lim.docs, snipsLimit: lim.snips, cycleStart: serverTimestamp() });
      return { docsUsed: 0, snipsUsed: 0, docsLimit: lim.docs, snipsLimit: lim.snips, cycleStart: { seconds: Math.floor(Date.now() / 1000) } };
    } catch (e) { console.error("[SlideBaba] free renew failed:", e?.code || "", e?.message || e); return null; }
  }

  // PAID plan whose period has ended: DOWNGRADE to Free so the user must pay again to continue.
  // Razorpay orders here are one-time (not auto-charging subscriptions), so a paid plan must
  // never silently re-grant itself for free. This also fixes accounts that previously kept
  // auto-renewing without payment — their old planSince makes them expire on next login.
  const lim = planLimits("free", "monthly");
  try {
    await updateDoc(doc(db, "users", uid), {
      plan: "free", period: "monthly",
      docsUsed: 0, snipsUsed: 0, docsLimit: lim.docs, snipsLimit: lim.snips,
      cycleStart: serverTimestamp(),
      prevPlan: plan, planExpiredAt: serverTimestamp(),
    });
    return {
      plan: "free", period: "monthly",
      docsUsed: 0, snipsUsed: 0, docsLimit: lim.docs, snipsLimit: lim.snips,
      cycleStart: { seconds: Math.floor(Date.now() / 1000) },
      prevPlan: plan,
    };
  } catch (e) { console.error("[SlideBaba] downgrade failed:", e?.code || "", e?.message || e); return null; }
}

export async function consume(uid, profile, kind) {
  if (!uid) return { ok: false, reason: "auth" };
  const r = remaining(profile);
  const left = kind === "snip" ? r.snipsLeft : r.docsLeft;
  if (left <= 0) return { ok: false, reason: "limit" };
  const field = kind === "snip" ? "snipsUsed" : "docsUsed";
  try {
    await updateDoc(doc(db, "users", uid), { [field]: increment(1) });
    return { ok: true, patch: { [field]: (profile?.[field] ?? 0) + 1 } };
  } catch (e) { console.error("[SlideBaba] consume failed:", e?.code || "", e?.message || e); return { ok: false, reason: "error" }; }
}

// Save the user's reusable brand (logo + coaching name) on their profile.
export async function saveBrand(uid, brand) {
  if (!uid) return;
  try { await updateDoc(doc(db, "users", uid), { brand }); }
  catch (e) { console.error("[SlideBaba] saveBrand failed:", e?.code || "", e?.message || e); }
}

// Record a successful payment so the admin revenue panel can list it.
export async function recordPayment(uid, profile, info) {
  try {
    await addDoc(collection(db, "payments"), {
      uid,
      phone: profile?.phone || "",
      name: profile?.fullName || "",
      plan: info.plan,
      period: info.period,
      amount: info.amount || 0,        // paise
      currency: info.currency || "INR",
      coupon: info.coupon || "",
      paymentId: info.paymentId || "",
      orderId: info.orderId || "",
      createdAt: serverTimestamp(),
    });
  } catch (e) { console.error("[SlideBaba] recordPayment FAILED:", e?.code || "", e?.message || e); }
}

export async function applyPlan(uid, plan, period = "monthly") {
  const lim = planLimits(plan, period);
  // Carry over whatever credits are still left and ADD the new plan on top (stack, don't replace).
  let leftDocs = 0, leftSnips = 0;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) {
      const d = snap.data();
      leftDocs = Math.max(0, (d.docsLimit ?? 0) - (d.docsUsed ?? 0));
      leftSnips = Math.max(0, (d.snipsLimit ?? 0) - (d.snipsUsed ?? 0));
    }
  } catch {}
  const docsLimit = leftDocs + lim.docs;
  const snipsLimit = leftSnips + lim.snips;
  const patch = { plan, period, docsLimit, snipsLimit, docsUsed: 0, snipsUsed: 0, cycleStart: serverTimestamp(), planSince: serverTimestamp(), prevPlan: "" };
  await updateDoc(doc(db, "users", uid), patch);
  return { plan, period, docsLimit, snipsLimit, docsUsed: 0, snipsUsed: 0, cycleStart: { seconds: Math.floor(Date.now() / 1000) }, prevPlan: "" };
}

function loadRazorpay() {
  return new Promise((res, rej) => {
    if (typeof window === "undefined") return rej(new Error("no window"));
    if (window.Razorpay) return res();
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => res();
    s.onerror = () => rej(new Error("Failed to load Razorpay checkout."));
    document.body.appendChild(s);
  });
}

export async function startCheckout({ plan, period = "monthly", profile, coupon = null, uid, onSuccess, onError }) {
  try {
    const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    if (!keyId) throw new Error("Razorpay is not configured yet (missing NEXT_PUBLIC_RAZORPAY_KEY_ID).");
    await loadRazorpay();
    const orderRes = await fetch("/api/razorpay/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan, period, couponCode: coupon?.code || "" }) });
    const order = await orderRes.json();
    if (!order.ok) throw new Error(order.error || "Could not start the order.");

    const rzp = new window.Razorpay({
      key: keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: "SlideBaba",
      description: `${PLANS[plan]?.label || plan} plan — ${period}`,
      prefill: { name: profile?.fullName || "", email: profile?.email || "", contact: (profile?.phone || "").replace("+91", "") },
      theme: { color: "#6d3aed" },
      handler: async (resp) => {
        try {
          const v = await fetch("/api/razorpay/verify", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId: resp.razorpay_order_id, paymentId: resp.razorpay_payment_id, signature: resp.razorpay_signature, plan, period }),
          });
          const data = await v.json();
          if (data.ok) {
            await recordPayment(uid || profile?.uid, profile, { plan, period, amount: order.amount, currency: order.currency, coupon: coupon?.code || "", paymentId: resp.razorpay_payment_id, orderId: resp.razorpay_order_id });
            if (coupon?.ok && coupon?.code) await redeemCoupon(coupon.code);
            onSuccess?.(plan, period, resp.razorpay_payment_id);
          } else onError?.(new Error(data.error || "Payment could not be verified."));
        } catch (e) { onError?.(e); }
      },
      modal: { ondismiss: () => onError?.(new Error("Payment cancelled.")) },
    });
    rzp.open();
  } catch (e) { onError?.(e); }
}