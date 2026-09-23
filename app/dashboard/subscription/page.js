"use client";

import { useState } from "react";
import { Crown, Check, X as XIcon, Loader2, CheckCircle2, AlertCircle, MonitorPlay, Bot, Tag } from "lucide-react";
import Topbar from "@/components/dashboard/Topbar";
import { useAuth } from "@/context/AuthContext";
import { fmtDate } from "@/lib/usage";
import { PLANS, PLAN_ORDER, RANK, remaining, cycleInfo, startCheckout, applyPlan } from "@/lib/plan";
import { validateCoupon, discountLabel, applyDiscount } from "@/lib/coupons";

// Price suffix shown next to a plan's amount. The two one-time promo plans get their own.
const PERIOD_SUFFIX = { yearly: "/yr", monthly: "/mo", quarter: "/3 mo", triennial: "/3 yr" };
const SPECIAL_IDS = ["quarter", "triennial"];

function Bar({ used, limit }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-ink-700">
      <div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Feature({ ok, children }) {
  return (
    <li className={`flex items-start gap-2 text-sm ${ok ? "text-slate-200" : "text-slate-600 line-through"}`}>
      {ok ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : <XIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-600" />}
      {children}
    </li>
  );
}

export default function SubscriptionPage() {
  const { user, profile, mergeProfile } = useAuth();
  const plan = profile?.plan || "free";
  const period = profile?.period || "monthly";
  const { docsLimit, snipsLimit } = remaining(profile);
  const docsUsed = profile?.docsUsed ?? 0;
  const snipsUsed = profile?.snipsUsed ?? 0;
  const { renew, daysLeft } = cycleInfo(profile);
  // Set when a paid plan expired and was downgraded to Free — prompt the user to pay again.
  const expiredFrom = plan === "free" && profile?.prevPlan && profile.prevPlan !== "free" ? profile.prevPlan : null;

  const [billing, setBilling] = useState("monthly"); // selector
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [code, setCode] = useState("");
  const [coupon, setCoupon] = useState(null);
  const [couponMsg, setCouponMsg] = useState("");

  const checkCoupon = async () => {
    setCouponMsg("Checking…");
    const r = await validateCoupon(code);
    setCoupon(r.ok ? r : null);
    setCouponMsg(r.ok ? `${discountLabel(r)} applied \u2713` : r.reason);
  };

  const yearly = billing === "yearly";
  const k = yearly ? "y" : "m";
  const per = yearly ? "/year" : "/month";
  const ids = yearly ? ["basic", "medium", "high"] : ["free", "basic", "medium", "high"];

  const buy = (id, periodOverride) => {
    if (!user || id === "free") return;
    setMsg(null); setBusy(id);
    startCheckout({
      plan: id, period: periodOverride || billing, profile, coupon, uid: user.uid,
      onSuccess: async (paidPlan, paidPeriod) => {
        try {
          const patch = await applyPlan(user.uid, paidPlan, paidPeriod);
          mergeProfile(patch);
          setMsg({ type: "ok", text: `Payment successful — you're on the ${PLANS[paidPlan]?.label} (${paidPeriod}) plan!` });
        } catch (e) { setMsg({ type: "err", text: "Payment succeeded but the plan update failed: " + (e?.message || e) }); }
        finally { setBusy(null); }
      },
      onError: (e) => { setMsg({ type: "err", text: e?.message || "Payment failed." }); setBusy(null); },
    });
  };

  return (
    <>
      <Topbar title="Subscription & Billing" />
      <div className="flex-1 overflow-y-auto bg-dots p-4 sm:p-6">
        {msg && (
          <div className={`mb-5 flex items-center gap-2 rounded-xl px-4 py-3 text-sm ring-1 ring-inset ${msg.type === "ok" ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" : "bg-accent-600/15 text-accent-300 ring-accent-500/30"}`}>
            {msg.type === "ok" ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />} {msg.text}
          </div>
        )}

        {expiredFrom && (
          <div className="mb-5 flex items-center gap-2 rounded-xl bg-amber-500/15 px-4 py-3 text-sm text-amber-300 ring-1 ring-inset ring-amber-500/30">
            <AlertCircle className="h-4 w-4 shrink-0" /> Your <b className="capitalize">{PLANS[expiredFrom]?.label || expiredFrom}</b> plan has ended. Choose a plan below to renew and restore your credits.
          </div>
        )}

        {/* current plan */}
        <div className="overflow-hidden rounded-3xl bg-ink-850 p-5 ring-1 ring-white/10 sm:p-7">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <span className="rounded-full bg-sky-500/15 px-3 py-1 text-xs font-bold uppercase tracking-wider text-sky-300">Current Plan</span>
              <h2 className="mt-3 font-display text-3xl font-extrabold capitalize text-white sm:text-4xl">{plan} <span className="text-base font-bold text-slate-500">· {period}</span></h2>
              <p className="mt-2 text-sm text-slate-400">Credits renew on <b className="text-slate-200">{fmtDate(renew)}</b> · {daysLeft} days left.</p>
            </div>
            <p className="font-display text-3xl font-extrabold text-white">₹{(PLANS[plan]?.[period === "yearly" ? "y" : "m"] ?? 0).toLocaleString("en-IN")}<span className="text-base text-slate-500">{PERIOD_SUFFIX[period] || "/mo"}</span></p>
          </div>
          <div className="mt-7 space-y-5">
            <div>
              <div className="flex items-center justify-between text-sm font-semibold"><span className="text-slate-300">Document Credits</span><span className="text-brand-300">{Math.max(0, docsLimit - docsUsed)} / {docsLimit} left</span></div>
              <Bar used={docsUsed} limit={docsLimit} />
            </div>
            <div>
              <div className="flex items-center justify-between text-sm font-semibold"><span className="text-slate-300">AI Credits</span><span className="text-sky-300">{Math.max(0, snipsLimit - snipsUsed)} / {snipsLimit} left</span></div>
              <Bar used={snipsUsed} limit={snipsLimit} />
            </div>
          </div>
        </div>

        {/* billing toggle */}
        <div className="mx-auto mt-7 flex w-fit items-center gap-1 rounded-full bg-slate-200 p-1 ring-1 ring-inset ring-black/10 dark:bg-ink-800 dark:ring-white/10">
          <button onClick={() => setBilling("monthly")} className={`rounded-full px-5 py-2 text-sm font-bold transition ${!yearly ? "bg-brand-gradient text-white shadow-soft" : "text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"}`}>Monthly</button>
          <button onClick={() => setBilling("yearly")} className={`flex items-center gap-2 rounded-full px-5 py-2 text-sm font-bold transition ${yearly ? "bg-brand-gradient text-white shadow-soft" : "text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"}`}>
            Yearly <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-white">SAVE 20%</span>
          </button>
        </div>

        {/* coupon */}
        <div className="mx-auto mt-5 flex w-full max-w-md flex-col items-center gap-2 sm:flex-row">
          <div className="flex w-full flex-1 items-center gap-2 rounded-xl bg-slate-100 px-3 py-2.5 ring-1 ring-inset ring-black/10 dark:bg-ink-800 dark:ring-white/10">
            <Tag className="h-4 w-4 text-slate-400" />
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Have a coupon code?" className="w-full bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-500 dark:text-white" />
          </div>
          <button onClick={checkCoupon} className="w-full rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 sm:w-auto">Apply</button>
        </div>
        {couponMsg && <p className={`mx-auto mt-1.5 max-w-md text-center text-xs font-semibold ${coupon ? "text-emerald-400" : "text-accent-400"}`}>{couponMsg}</p>}

        {/* plan cards */}
        <div className={`mx-auto mt-6 grid max-w-6xl gap-5 sm:grid-cols-2 lg:grid-cols-3`}>
          {ids.map((id) => {
            const p = PLANS[id];
            const isCurrent = plan === id && period === billing;
            const price = p[k];
            const finalPrice = Math.round(applyDiscount((price || 0) * 100, coupon) / 100);
            const discounted = coupon && finalPrice < price;
            const badge = id === "high" ? (yearly ? "BEST VALUE" : "MOST POPULAR") : null;
            const monthlyEquiv = yearly && price ? Math.round(price / 12) : null;
            return (
              <div key={id} className={`relative flex flex-col rounded-3xl bg-ink-850 p-5 ring-1 ${isCurrent ? "ring-2 ring-brand-400" : badge ? "ring-emerald-500/40" : "ring-white/10"}`}>
                {badge && <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow-soft">★ {badge}</span>}
                <span className={`grid h-10 w-10 place-items-center rounded-xl ${id === "high" ? "bg-emerald-500/15 text-emerald-300" : "bg-sky-500/15 text-sky-300"}`}>{id === "high" ? <Crown className="h-5 w-5" /> : <Bot className="h-5 w-5" />}</span>
                <h3 className={`mt-3 font-display text-lg font-bold ${id === "high" ? "text-emerald-300" : "text-white"}`}>{p.label}</h3>
                <p className="mt-1 font-display text-3xl font-extrabold text-white">{discounted && <span className="mr-1.5 align-middle text-lg font-bold text-slate-500 line-through">₹{price.toLocaleString("en-IN")}</span>}₹{(discounted ? finalPrice : price).toLocaleString("en-IN")}<span className="text-sm text-slate-500">{per}</span></p>
                {discounted && <p className="text-xs font-bold text-emerald-400">{discountLabel(coupon)} with {coupon.code}</p>}
                {monthlyEquiv ? <p className="text-xs font-semibold text-emerald-400">≈ ₹{monthlyEquiv.toLocaleString("en-IN")}/mo</p> : <p className="text-xs text-transparent">.</p>}

                <ul className="mt-4 flex-1 space-y-2.5">
                  <li className="flex items-start gap-2 text-sm text-slate-200"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> Up to <b className="text-brand-300">{p.maxSlidesPerDoc[k]}</b> slides per document</li>
                  <Feature ok>{p.credits[k].toLocaleString("en-IN")} AI Credits</Feature>
                  <Feature ok>{p.docs[k].toLocaleString("en-IN")} Documents/{yearly ? "year" : "month"}</Feature>
                  <Feature ok={p.pdf}>PDF Export</Feature>
                  <Feature ok={p.ppt}>PPT Export</Feature>
                  <Feature ok={p.branding}>Custom Branding</Feature>
                  <Feature ok={p.teaching}>Teaching Mode</Feature>
                </ul>

                <div className="mt-5 flex items-center gap-2 rounded-xl bg-ink-800/70 px-3 py-2.5 ring-1 ring-inset ring-white/10">
                  <MonitorPlay className="h-4 w-4 text-brand-300" />
                  <span className="text-xs text-slate-400">Create</span>
                  <span className="text-sm font-bold text-white">{p.slides[k]} Slides</span>
                </div>

                <button
                  onClick={() => buy(id)}
                  disabled={id === "free" || isCurrent || !!busy}
                  className={`mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition disabled:opacity-50 ${id === "high" ? "bg-gradient-to-r from-emerald-500 to-cyan-500 text-white" : "bg-brand-gradient text-white"}`}
                >
                  {busy === id ? <><Loader2 className="h-4 w-4 animate-spin" /> Opening…</> : isCurrent ? "Current plan" : id === "free" ? "Free forever" : <>Subscribe to {p.label} →</>}
                </button>
              </div>
            );
          })}
        </div>

        {/* special one-time plans — independent of the monthly/yearly toggle */}
        <div className="mx-auto mt-10 max-w-6xl">
          <div className="mb-4 flex items-center gap-3">
            <h3 className="font-display text-lg font-extrabold text-white">Special long-term plans</h3>
            <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300">One-time payment</span>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            {SPECIAL_IDS.map((id) => {
              const p = PLANS[id];
              const isCurrent = plan === id;
              const price = p.m; // one price, m === y
              const finalPrice = Math.round(applyDiscount(price * 100, coupon) / 100);
              const discounted = coupon && finalPrice < price;
              const months = Math.round((p.durationDays || 0) / 30);
              const validFor = id === "triennial" ? "3 years" : "3 months";
              return (
                <div key={id} className={`relative flex flex-col rounded-3xl bg-ink-850 p-5 ring-1 ${isCurrent ? "ring-2 ring-brand-400" : "ring-amber-500/30"} sm:p-6`}>
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow-soft">★ Best deal · valid {validFor}</span>
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-500/15 text-amber-300"><Crown className="h-5 w-5" /></span>
                    <h3 className="font-display text-lg font-bold text-white">{p.label} Plan</h3>
                  </div>
                  <p className="mt-3 font-display text-3xl font-extrabold text-white">
                    {discounted && <span className="mr-1.5 align-middle text-lg font-bold text-slate-500 line-through">₹{price.toLocaleString("en-IN")}</span>}
                    ₹{(discounted ? finalPrice : price).toLocaleString("en-IN")}
                    <span className="text-sm text-slate-500"> one-time</span>
                  </p>
                  {discounted && <p className="text-xs font-bold text-emerald-400">{discountLabel(coupon)} with {coupon.code}</p>}
                  <p className="mt-0.5 text-xs font-semibold text-amber-300/90">Pay once — full access for {validFor} ({months} months)</p>

                  <ul className="mt-4 flex-1 space-y-2.5">
                    <li className="flex items-start gap-2 text-sm text-slate-200"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> Up to <b className="text-brand-300">{p.maxSlidesPerDoc.m}</b> slides per document</li>
                    <Feature ok>{p.credits.m.toLocaleString("en-IN")} AI Credits</Feature>
                    <Feature ok>{p.docs.m.toLocaleString("en-IN")} Documents</Feature>
                    <Feature ok={p.pdf}>PDF Export</Feature>
                    <Feature ok={p.ppt}>PPT Export</Feature>
                    <Feature ok={p.branding}>Custom Branding</Feature>
                    <Feature ok={p.teaching}>Teaching Mode</Feature>
                  </ul>

                  <div className="mt-5 flex items-center gap-2 rounded-xl bg-ink-800/70 px-3 py-2.5 ring-1 ring-inset ring-white/10">
                    <MonitorPlay className="h-4 w-4 text-brand-300" />
                    <span className="text-xs text-slate-400">Create</span>
                    <span className="text-sm font-bold text-white">{p.slides.m} Slides</span>
                  </div>

                  <button
                    onClick={() => buy(id, id)}
                    disabled={isCurrent || !!busy}
                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2.5 text-sm font-bold text-white transition disabled:opacity-50"
                  >
                    {busy === id ? <><Loader2 className="h-4 w-4 animate-spin" /> Opening…</> : isCurrent ? "Current plan" : <>Get {p.label} plan →</>}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-slate-500">Payments are processed securely by Razorpay. Use a test card in Razorpay test mode.</p>
      </div>
    </>
  );
}
