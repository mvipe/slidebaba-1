"use client";

import { useState } from "react";
import Link from "next/link";
import { X, Check, Rocket, Crown, ArrowRight, Loader2, Tag, Lock } from "lucide-react";
import { PLANS, applyPlan, startCheckout } from "@/lib/plan";
import { validateCoupon, applyDiscount, discountLabel } from "@/lib/coupons";

const ITEMS = [
  { id: "basic", icon: Rocket },
  { id: "medium", icon: Rocket },
  { id: "high", icon: Crown, popular: true },
];

const fmt = (paise) => "₹" + Math.round(paise / 100).toLocaleString("en-IN");

export default function PlanModal({ open, onClose, profile, uid, onApplied, period = "monthly", title = "Upgrade to start creating" }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [code, setCode] = useState("");
  const [coupon, setCoupon] = useState(null);
  const [couponMsg, setCouponMsg] = useState("");

  if (!open) return null;
  const k = period === "yearly" ? "y" : "m";

  const checkCoupon = async () => {
    setCouponMsg("Checking…");
    const r = await validateCoupon(code);
    setCoupon(r.ok ? r : null);
    setCouponMsg(r.ok ? `${discountLabel(r)} applied ✓` : r.reason);
  };

  const buy = (id) => {
    if (!uid) { window.location.href = "/register"; return; }
    setErr(""); setBusy(id);
    startCheckout({
      plan: id, period, profile, coupon, uid,
      onSuccess: async (plan, per) => {
        try { const patch = await applyPlan(uid, plan, per); onApplied?.(patch); } catch {}
        setBusy(""); onClose?.();
      },
      onError: (e) => { setErr(e.message || "Payment failed."); setBusy(""); },
    });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="relative max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl dark:bg-ink-900 sm:rounded-3xl sm:p-8">
        <button onClick={onClose} className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-black/5 dark:hover:bg-white/10"><X className="h-5 w-5" /></button>

        <div className="flex items-center gap-2 text-brand-500">
          <Lock className="h-5 w-5" />
          <span className="text-xs font-bold uppercase tracking-wider">Plan required</span>
        </div>
        <h2 className="mt-2 font-display text-2xl font-extrabold text-ink-900 dark:text-white">{title}</h2>
        <p className="mt-1 text-sm text-slate-500">Pick a plan to upload documents and generate slides &amp; notes.</p>

        {/* coupon */}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex flex-1 items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 ring-1 ring-inset ring-black/5 dark:bg-ink-800 dark:ring-white/10">
            <Tag className="h-4 w-4 text-slate-400" />
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Coupon code (optional)" className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-slate-400 dark:text-white" />
          </div>
          <button onClick={checkCoupon} className="rounded-xl bg-ink-900 px-4 py-2 text-sm font-bold text-white hover:bg-ink-800 dark:bg-ink-700 dark:hover:bg-ink-600">Apply</button>
        </div>
        {couponMsg && <p className={`mt-1.5 text-xs font-semibold ${coupon ? "text-emerald-500" : "text-accent-500"}`}>{couponMsg}</p>}

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {ITEMS.map(({ id, icon: Icon, popular }) => {
            const plan = PLANS[id];
            const base = (plan[k] || 0) * 100; // paise
            const final = applyDiscount(base, coupon);
            const discounted = final < base;
            return (
              <div key={id} className={`relative flex flex-col rounded-2xl border p-5 ${popular ? "border-emerald-400/60 ring-1 ring-emerald-400/40" : "border-black/10 dark:border-white/10"}`}>
                {popular && <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500 px-2.5 py-0.5 text-[10px] font-bold uppercase text-white">Popular</span>}
                <div className="flex items-center gap-2">
                  <span className={`grid h-9 w-9 place-items-center rounded-xl ${popular ? "bg-emerald-500/15 text-emerald-400" : "bg-sky-500/15 text-sky-400"}`}><Icon className="h-5 w-5" /></span>
                  <span className="font-display text-base font-bold text-ink-900 dark:text-white">{plan.label}</span>
                </div>
                <div className="mt-3">
                  {discounted && <span className="mr-1.5 text-sm text-slate-400 line-through">{fmt(base)}</span>}
                  <span className="font-display text-2xl font-extrabold text-ink-900 dark:text-white">{fmt(final)}</span>
                  <span className="text-xs text-slate-500">/{period === "yearly" ? "yr" : "mo"}</span>
                </div>
                <ul className="mt-3 flex-1 space-y-1.5 text-xs text-slate-500">
                  <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-500" /> Up to {plan.maxSlidesPerDoc[k]} slides per document</li>
                  <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-500" /> {plan.credits[k]} AI credits</li>
                  <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-500" /> {plan.docs[k]} documents</li>
                  <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-500" /> {plan.ppt ? "PPT + PDF" : "PDF export"}</li>
                </ul>
                <button onClick={() => buy(id)} disabled={!!busy} className={`mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-bold transition disabled:opacity-60 ${popular ? "bg-gradient-to-r from-emerald-500 to-cyan-500 text-white" : "bg-ink-900 text-white hover:bg-ink-800 dark:bg-ink-700 dark:hover:bg-ink-600"}`}>
                  {busy === id ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Choose {plan.label} <ArrowRight className="h-4 w-4" /></>}
                </button>
              </div>
            );
          })}
        </div>

        {err && <p className="mt-3 text-sm font-semibold text-accent-500">{err}</p>}
        <div className="mt-5 flex items-center justify-between text-sm">
          <Link href="/dashboard/subscription" className="font-semibold text-brand-500 hover:underline">See all plans &amp; yearly pricing →</Link>
          <button onClick={onClose} className="text-slate-500 hover:text-ink-900 dark:hover:text-white">Maybe later</button>
        </div>
      </div>
    </div>
  );
}
