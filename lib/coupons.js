// Coupon catalogue + validation. Coupons live in the top-level `coupons` collection,
// keyed by the (uppercased) code. Public read (for validation) + admin write via rules.
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp, increment } from "firebase/firestore";

export const norm = (c) => (c || "").trim().toUpperCase();

function ms(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts.seconds) return ts.seconds * 1000;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/* ---------- admin CRUD ---------- */
export async function listCoupons() {
  try {
    const snap = await getDocs(collection(db, "coupons"));
    return snap.docs
      .map((d) => ({ code: d.id, ...d.data() }))
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  } catch (e) { console.error("[SlideBaba] listCoupons FAILED:", e?.code || "", e?.message || e); return []; }
}

export async function createCoupon({ code, type = "percent", value, maxRedemptions = 0, expiresAt = null, active = true }) {
  const id = norm(code);
  if (!id) throw new Error("Coupon code is required.");
  const num = Number(value);
  if (!num || num <= 0) throw new Error("Discount value must be greater than 0.");
  if (type === "percent" && num > 100) throw new Error("Percent discount cannot exceed 100.");
  await setDoc(doc(db, "coupons", id), {
    type, value: num,
    maxRedemptions: Number(maxRedemptions) || 0,
    redemptions: 0,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    active: !!active,
    createdAt: serverTimestamp(),
  });
  return id;
}

export async function updateCoupon(code, patch) {
  await updateDoc(doc(db, "coupons", norm(code)), patch);
}

export async function deleteCoupon(code) {
  await deleteDoc(doc(db, "coupons", norm(code)));
}

export async function redeemCoupon(code) {
  try { await updateDoc(doc(db, "coupons", norm(code)), { redemptions: increment(1) }); }
  catch (e) { console.error("[SlideBaba] redeemCoupon FAILED:", e?.code || "", e?.message || e); }
}

/* ---------- validation (client + server share the same rules) ---------- */
export async function validateCoupon(rawCode) {
  const code = norm(rawCode);
  if (!code) return { ok: false, reason: "Enter a coupon code." };
  let snap;
  try { snap = await getDoc(doc(db, "coupons", code)); }
  catch (e) { return { ok: false, reason: "Could not check the coupon." }; }
  if (!snap.exists()) return { ok: false, reason: "Invalid coupon code." };
  const c = snap.data();
  if (c.active === false) return { ok: false, reason: "This coupon is no longer active." };
  if (c.expiresAt && ms(c.expiresAt) < Date.now()) return { ok: false, reason: "This coupon has expired." };
  if (c.maxRedemptions && (c.redemptions || 0) >= c.maxRedemptions) return { ok: false, reason: "This coupon is fully redeemed." };
  return { ok: true, code, type: c.type || "percent", value: Number(c.value) || 0 };
}

// amount is in the SAME unit you pass in (paise here). flat value is in rupees → convert.
export function applyDiscount(amountPaise, coupon) {
  if (!coupon || !coupon.ok) return amountPaise;
  if (coupon.type === "percent") return Math.max(0, Math.round(amountPaise * (1 - coupon.value / 100)));
  return Math.max(0, amountPaise - Math.round(coupon.value * 100)); // flat ₹ → paise
}

export function discountLabel(coupon) {
  if (!coupon || !coupon.ok) return "";
  return coupon.type === "percent" ? `${coupon.value}% off` : `₹${coupon.value} off`;
}
