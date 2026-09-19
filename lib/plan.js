// Plan catalogue, billing cycle, credits, branding, and Razorpay checkout.
import { db } from "@/lib/firebase";
import { doc, updateDoc, getDoc, serverTimestamp, increment, addDoc, collection } from "firebase/firestore";
import { redeemCoupon } from "@/lib/coupons";

/* ============================================================================
 * PLAN LIMITS — read this before changing a number.
 * ============================================================================
 * There are FOUR separate limits and a user hits whichever is smallest. That is
 * how a paid plan advertised at "100 pages" used to stop at around 40:
 *
 *   docs            documents (downloads) per cycle
 *   credits         AI credits / snippet runs per cycle
 *   maxPages        pages in ONE uploaded PDF
 *   maxSlidesPerDoc slides ONE document may produce
 *
 * maxSlidesPerDoc used to be set equal to maxPages — Basic allowed 100 pages AND
 * 100 slides. But a real exam page carries 3–8 questions, and every question
 * becomes its own slide, so a 25-page paper already produced more than 100 slides
 * and the scan was refused with "exceeds your plan limit". The page allowance was
 * never reachable. The two are now sized for what a page actually yields:
 * maxSlidesPerDoc is ~12 slides per allowed page, so the PAGE limit is the one a
 * user actually meets, exactly as the pricing page says.
 *
 * Both numbers live here and nowhere else — planLimits() reads them from this
 * object, and if a key is missing the gate silently compares against `undefined`
 * (always false) and never fires.
 * ========================================================================== */

// credits = "AI Credits" (snippets/AI runs) · docs = "Documents" (downloads)
export const PLANS = {
  free:   { label: "Free",   m: 0,    y: 0,     credits: { m: 2,   y: 2 },    docs: { m: 2,   y: 2 },    slides: { m: "2",       y: "2" },         maxSlidesPerDoc: { m: 150,  y: 150 },  maxPages: { m: 25,  y: 25 },  pdf: true, ppt: true,  branding: true, teaching: false },
  basic:  { label: "Basic",  m: 999,  y: 9999,  credits: { m: 150, y: 2400 }, docs: { m: 150, y: 2400 }, slides: { m: "3,000+",  y: "36,000+" },   maxSlidesPerDoc: { m: 1200, y: 1200 }, maxPages: { m: 100, y: 100 }, pdf: true, ppt: false, branding: true, teaching: false },
  medium: { label: "Medium", m: 1999, y: 19990, credits: { m: 400, y: 5400 }, docs: { m: 400, y: 5400 }, slides: { m: "8,000+",  y: "96,000+" },   maxSlidesPerDoc: { m: 1800, y: 1800 }, maxPages: { m: 150, y: 150 }, pdf: true, ppt: true,  branding: true, teaching: false },
  high:   { label: "High",   m: 2999, y: 29990, credits: { m: 749, y: 9600 }, docs: { m: 749, y: 9600 }, slides: { m: "15,000+", y: "1,80,000+" }, maxSlidesPerDoc: { m: 2400, y: 2400 }, maxPages: { m: 200, y: 200 }, pdf: true, ppt: true,  branding: true, teaching: true },
};
export const PLAN_ORDER = ["free", "basic", "medium", "high"];
export const RANK = { free: 0, basic: 1, medium: 2, high: 3 };

/** Coerce anything stored on a profile into a usable positive number, or null. */
function posNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Single source of truth for every per-plan numeric limit.
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
  const plan = PLANS[profile?.plan] ? profile.plan : "free";
  const period = periodOverride || profile?.period || "monthly";
  const lim = planLimits(plan, period);
  return {
    plan,
    label: PLANS[plan].label,
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

// Max slides one document may produce on this profile's plan.
export function maxSlidesFor(profile, periodOverride) {
  const n = Number(planMeta(profile, periodOverride).maxSlidesPerDoc);
  return Number.isFinite(n) && n > 0 ? n : PLANS.free.maxSlidesPerDoc.m;
}

export function canCreateSlides(profile, slidesCount, periodOverride) {
  const maxSlidesPerDoc = maxSlidesFor(profile, periodOverride);
  const count = Number(slidesCount || 0);
  if (!count) return { ok: true, maxSlidesPerDoc, slidesCount: 0 };
  return {
    ok: count <= maxSlidesPerDoc,
    reason: count > maxSlidesPerDoc ? "limit" : null,
    maxSlidesPerDoc,
    slidesCount: count,
  };
}

/**
 * ONE gate for "may this profile scan this document?", so the UI can always say
 * exactly WHICH limit fired instead of showing a generic failure.
 *
 * @param {object} profile
 * @param {object} what     { pages?, slides? }
 * @returns {{ok:true} | {ok:false, kind:"auth"|"pages"|"slides"|"credits", ...}}
 */
export function checkDocumentLimits(profile, what = {}) {
  if (!profile) return { ok: false, kind: "auth", message: "Still loading your plan — try again in a second." };

  const meta = planMeta(profile);
  const left = remaining(profile);

  if (left.docsLeft <= 0) {
    return {
      ok: false,
      kind: "credits",
      plan: meta.plan,
      planLabel: meta.label,
      message: `You have used all ${left.docsLimit} documents on your ${meta.label} plan for this cycle.`,
    };
  }

  const pages = Number(what.pages || 0);
  if (pages > 0 && pages > meta.maxPages) {
    return {
      ok: false,
      kind: "pages",
      plan: meta.plan,
      planLabel: meta.label,
      pages,
      allowed: meta.maxPages,
      message: `This PDF has ${pages} pages but your ${meta.label} plan allows ${meta.maxPages} pages per document.`,
    };
  }

  const slides = Number(what.slides || 0);
  if (slides > 0 && slides > meta.maxSlidesPerDoc) {
    return {
      ok: false,
      kind: "slides",
      plan: meta.plan,
      planLabel: meta.label,
      slides,
      allowed: meta.maxSlidesPerDoc,
      message: `This document would create ${slides} slides but your ${meta.label} plan allows ${meta.maxSlidesPerDoc} slides per document.`,
    };
  }

  return { ok: true, plan: meta.plan, planLabel: meta.label, maxPages: meta.maxPages, maxSlidesPerDoc: meta.maxSlidesPerDoc };
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

/**
 * How much of the cycle is left.
 *
 * NOTE the posNum() guards. Registration used to write `docsLimit: 0, snipsLimit: 0`
 * onto a brand-new profile, and `profile.docsLimit ?? lim.docs` keeps a stored ZERO
 * (?? only falls through on null/undefined). So every new free account had a limit of
 * 0 documents and was shown the payment modal on its very first upload. A stored limit
 * is now honoured only when it is a real positive number; otherwise the plan's own
 * allowance applies. Paid plans that stack credits still keep their larger stored value.
 */
export function remaining(profile) {
  const lim = planLimits(profile?.plan || "free", profile?.period || "monthly");
  const docsLimit = posNum(profile?.docsLimit) ?? lim.docs;
  const snipsLimit = posNum(profile?.snipsLimit) ?? lim.snips;
  return {
    docsLimit, snipsLimit,
    docsLeft: Math.max(0, docsLimit - (Number(profile?.docsUsed) || 0)),
    snipsLeft: Math.max(0, snipsLimit - (Number(profile?.snipsUsed) || 0)),
  };
}

export async function maybeRenew(uid, profile) {
  if (!uid || !profile) return null;

  // Repair a profile that was created with zero limits before it can block anything.
  // Cheap, runs once, and turns "new account cannot scan at all" into a non-event.
  const plan = profile.plan || "free";
  if (!posNum(profile.docsLimit) || !posNum(profile.snipsLimit)) {
    const lim = planLimits(plan, profile.period || "monthly");
    try {
      await updateDoc(doc(db, "users", uid), { docsLimit: lim.docs, snipsLimit: lim.snips });
      profile = { ...profile, docsLimit: lim.docs, snipsLimit: lim.snips };
    } catch (e) { console.error("[SlideBaba] limit repair failed:", e?.code || "", e?.message || e); }
  }

  if (!cycleInfo(profile).expired) {
    return posNum(profile.docsLimit) && posNum(profile.snipsLimit)
      ? { docsLimit: profile.docsLimit, snipsLimit: profile.snipsLimit }
      : null;
  }

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
  // never silently re-grant itself for free.
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
    return { ok: true, patch: { [field]: (Number(profile?.[field]) || 0) + 1 } };
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
      const prev = remaining(d);
      leftDocs = prev.docsLeft;
      leftSnips = prev.snipsLeft;
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
