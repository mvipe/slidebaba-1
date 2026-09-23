"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { IndianRupee, Receipt, Tag, Image as ImageIcon, Type, Trash2, Plus, ShieldAlert, Loader2, Power, Users, ShieldCheck, User as UserIcon } from "lucide-react";
import Topbar from "@/components/dashboard/Topbar";
import { useAuth } from "@/context/AuthContext";
import { isAdmin, listPayments, revenueSummary, addGlobalBackground, listGlobalBackgrounds, removeGlobalBackground, addGlobalFont, listGlobalFonts, removeGlobalFont, ensureFontLoaded, listAllUsers } from "@/lib/admin";
import { auth } from "@/lib/firebase";
import { listCoupons, createCoupon, deleteCoupon, updateCoupon } from "@/lib/coupons";
import { fileToDataUrl, downscaleDataUrl } from "@/lib/imageCrop";
import { fmtDate } from "@/lib/usage";

const TABS = [
  { id: "revenue", label: "Revenue", icon: Receipt },
  { id: "coupons", label: "Coupons", icon: Tag },
  { id: "backgrounds", label: "Backgrounds", icon: ImageIcon },
  { id: "fonts", label: "Fonts", icon: Type },
  { id: "users", label: "Users", icon: Users },
];
const inr = (paise) => "₹" + Math.round((paise || 0) / 100).toLocaleString("en-IN");

// A Firestore timestamp (or Date/number) -> milliseconds. Used by the filters below.
function tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : 0;
}

export default function AdminPage() {
  const { user, profile } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState("revenue");
  const admin = isAdmin(profile);

  if (profile && !admin) {
    return (
      <>
        <Topbar title="Admin" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
          <ShieldAlert className="h-10 w-10 text-accent-400" />
          <h2 className="font-display text-xl font-bold text-white">Admins only</h2>
          <p className="max-w-sm text-sm text-slate-400">This area is restricted. Ask the owner to set your account role to <code className="rounded bg-ink-800 px-1">admin</code>.</p>
          <button onClick={() => router.push("/dashboard")} className="btn-cool mt-2">Back to dashboard</button>
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar title="Admin" />
      <div className="flex-1 overflow-y-auto bg-dots p-6">
        <div className="mb-6 flex flex-wrap items-center gap-1 rounded-xl bg-ink-850 p-1 ring-1 ring-inset ring-white/10">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${tab === t.id ? "bg-brand-gradient text-white" : "text-slate-400 hover:text-white"}`}>
              <t.icon className="h-4 w-4" /> {t.label}
            </button>
          ))}
        </div>

        {!admin ? <p className="py-16 text-center text-sm text-slate-500">Loading…</p> : (
          <>
            {tab === "revenue" && <RevenueTab />}
            {tab === "coupons" && <CouponsTab />}
            {tab === "backgrounds" && <BackgroundsTab />}
            {tab === "fonts" && <FontsTab />}
            {tab === "users" && <UsersTab />}
          </>
        )}
      </div>
    </>
  );
}

/* ============ REVENUE ============ */
function RevenueTab() {
  const [rows, setRows] = useState(null);
  const [mode, setMode] = useState("all"); // all | normal | coupon
  useEffect(() => { listPayments().then(setRows); }, []);
  if (!rows) return <p className="py-10 text-center text-sm text-slate-500">Loading payments…</p>;

  // "coupon" = a coupon code was used on the order; "normal" = full-price, no coupon.
  const withCoupon = rows.filter((p) => (p.coupon || "").trim());
  const normal = rows.filter((p) => !(p.coupon || "").trim());
  const view = mode === "coupon" ? withCoupon : mode === "normal" ? normal : rows;
  const sum = revenueSummary(view);
  const couponSum = revenueSummary(withCoupon);
  const normalSum = revenueSummary(normal);

  const FILTERS = [
    { id: "all",    label: `All (${rows.length})` },
    { id: "normal", label: `Normal (${normal.length})` },
    { id: "coupon", label: `Coupon used (${withCoupon.length})` },
  ];

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat icon={IndianRupee} label={mode === "all" ? "Total revenue" : mode === "coupon" ? "Coupon revenue" : "Normal revenue"} value={inr(sum.totalPaise)} tone="emerald" />
        <Stat icon={Receipt} label="Payments" value={String(sum.count)} tone="sky" />
        <Stat icon={Tag} label="Avg. order" value={inr(sum.count ? sum.totalPaise / sum.count : 0)} tone="brand" />
      </div>

      {/* Normal vs coupon split — always visible so the breakdown is one glance away. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl bg-ink-850 p-1 ring-1 ring-inset ring-white/10">
          {FILTERS.map((f) => (
            <button key={f.id} onClick={() => setMode(f.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${mode === f.id ? "bg-brand-gradient text-white" : "text-slate-400 hover:text-white"}`}>
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-500">
          Normal <b className="text-slate-300">{inr(normalSum.totalPaise)}</b> · Coupon <b className="text-slate-300">{inr(couponSum.totalPaise)}</b>
        </span>
      </div>

      <div className="mt-6 overflow-x-auto rounded-2xl bg-ink-850 ring-1 ring-white/10">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Date</th><th className="px-4 py-3">Phone</th><th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Period</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Coupon</th><th className="px-4 py-3">Payment ID</th>
            </tr>
          </thead>
          <tbody>
            {view.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No payments in this filter.</td></tr>}
            {view.map((p) => (
              <tr key={p.id} className="border-b border-white/5 text-slate-300">
                <td className="px-4 py-3 text-slate-400">{fmtDate(p.createdAt?.toDate ? p.createdAt.toDate() : Date.now())}</td>
                <td className="px-4 py-3 font-medium text-white">{p.phone || "—"}</td>
                <td className="px-4 py-3 capitalize">{p.plan}</td>
                <td className="px-4 py-3 capitalize">{p.period}</td>
                <td className="px-4 py-3 font-semibold text-emerald-400">{inr(p.amount)}</td>
                <td className="px-4 py-3">{p.coupon ? <span className="rounded bg-brand-500/15 px-1.5 py-0.5 text-xs text-brand-300">{p.coupon}</span> : "—"}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">{p.paymentId || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone }) {
  const tones = { emerald: "bg-emerald-500/15 text-emerald-300", sky: "bg-sky-500/15 text-sky-300", brand: "bg-brand-500/15 text-brand-300" };
  return (
    <div className="flex items-center gap-4 rounded-2xl bg-ink-850 p-5 ring-1 ring-white/10">
      <span className={`grid h-12 w-12 place-items-center rounded-xl ${tones[tone]}`}><Icon className="h-6 w-6" /></span>
      <div>
        <p className="text-xs uppercase text-slate-500">{label}</p>
        <p className="font-display text-2xl font-extrabold text-white">{value}</p>
      </div>
    </div>
  );
}

/* ============ COUPONS ============ */
function CouponsTab() {
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState({ code: "", type: "percent", value: "", maxRedemptions: "", expiresAt: "", active: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => { listCoupons().then(setRows); }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setErr(""); setBusy(true);
    try {
      await createCoupon({ ...form, expiresAt: form.expiresAt || null });
      setForm({ code: "", type: "percent", value: "", maxRedemptions: "", expiresAt: "", active: true });
      load();
    } catch (e) { setErr(e.message || "Could not create coupon."); }
    setBusy(false);
  };
  const toggle = async (c) => { await updateCoupon(c.code, { active: !(c.active !== false) }); load(); };
  const del = async (c) => { await deleteCoupon(c.code); load(); };

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      <div className="rounded-2xl bg-ink-850 p-5 ring-1 ring-white/10">
        <h3 className="font-display text-lg font-bold text-white">New coupon</h3>
        <div className="mt-4 space-y-3">
          <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="CODE e.g. SAVE20" className="w-full rounded-lg bg-ink-800 px-3 py-2 text-sm text-white ring-1 ring-inset ring-white/10" />
          <div className="flex gap-2">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="rounded-lg bg-ink-800 px-3 py-2 text-sm text-white ring-1 ring-inset ring-white/10">
              <option value="percent">% off</option>
              <option value="flat">₹ off</option>
            </select>
            <input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder={form.type === "percent" ? "20" : "100"} className="w-full rounded-lg bg-ink-800 px-3 py-2 text-sm text-white ring-1 ring-inset ring-white/10" />
          </div>
          <input type="number" value={form.maxRedemptions} onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })} placeholder="Max redemptions (0 = unlimited)" className="w-full rounded-lg bg-ink-800 px-3 py-2 text-sm text-white ring-1 ring-inset ring-white/10" />
          <label className="block text-xs text-slate-500">Expires (optional)
            <input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} className="mt-1 w-full rounded-lg bg-ink-800 px-3 py-2 text-sm text-white ring-1 ring-inset ring-white/10" />
          </label>
          {err && <p className="text-xs font-semibold text-accent-400">{err}</p>}
          <button onClick={create} disabled={busy} className="btn-cool w-full justify-center disabled:opacity-60">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4" /> Create coupon</>}</button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl bg-ink-850 ring-1 ring-white/10">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase text-slate-500">
            <tr><th className="px-4 py-3">Code</th><th className="px-4 py-3">Discount</th><th className="px-4 py-3">Used</th><th className="px-4 py-3">Status</th><th className="px-4 py-3"></th></tr>
          </thead>
          <tbody>
            {rows === null && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">Loading…</td></tr>}
            {rows && rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">No coupons yet.</td></tr>}
            {rows && rows.map((c) => (
              <tr key={c.code} className="border-b border-white/5 text-slate-300">
                <td className="px-4 py-3 font-mono font-bold text-white">{c.code}</td>
                <td className="px-4 py-3">{c.type === "percent" ? `${c.value}%` : `₹${c.value}`}</td>
                <td className="px-4 py-3">{c.redemptions || 0}{c.maxRedemptions ? ` / ${c.maxRedemptions}` : ""}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${c.active !== false ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-500/15 text-slate-400"}`}>{c.active !== false ? "Active" : "Off"}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1.5">
                    <button onClick={() => toggle(c)} title="Toggle active" className="grid h-8 w-8 place-items-center rounded-md bg-ink-800 text-slate-300 ring-1 ring-inset ring-white/10 hover:text-white"><Power className="h-4 w-4" /></button>
                    <button onClick={() => del(c)} title="Delete" className="grid h-8 w-8 place-items-center rounded-md bg-ink-800 text-slate-400 ring-1 ring-inset ring-white/10 hover:text-accent-400"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============ GLOBAL BACKGROUNDS ============ */
function BackgroundsTab() {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { listGlobalBackgrounds().then(setRows); }, []);
  useEffect(() => { load(); }, [load]);

  const upload = async (f) => {
    if (!f) return;
    setBusy(true);
    try {
      const raw = await fileToDataUrl(f);
      const small = await downscaleDataUrl(raw, 1600, 0.82);
      await addGlobalBackground(small, f.name);
      load();
    } catch (e) { console.error(e); }
    setBusy(false);
  };

  return (
    <div>
      <label className="flex w-fit cursor-pointer items-center gap-2 rounded-xl bg-ink-900 px-4 py-3 text-sm font-bold text-white ring-1 ring-inset ring-white/10 hover:bg-ink-800">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Upload background
        <input type="file" accept="image/*" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
      </label>
      <p className="mt-2 text-xs text-slate-500">Uploaded backgrounds appear in every user&apos;s editor under &ldquo;Shared backgrounds&rdquo;.</p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {rows === null && <p className="col-span-full py-8 text-center text-sm text-slate-500">Loading…</p>}
        {rows && rows.length === 0 && <p className="col-span-full py-8 text-center text-sm text-slate-500">No shared backgrounds yet.</p>}
        {rows && rows.map((b) => (
          <div key={b.id} className="group relative overflow-hidden rounded-xl ring-1 ring-white/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={b.url} alt={b.name} className="aspect-video w-full object-cover" />
            <button onClick={async () => { await removeGlobalBackground(b.id); load(); }} className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-md bg-black/60 text-white opacity-0 transition group-hover:opacity-100 hover:bg-accent-500"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============ GLOBAL FONTS ============ */
function FontsTab() {
  const [rows, setRows] = useState(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => { listGlobalFonts().then((f) => { f.forEach((x) => ensureFontLoaded(x.url)); setRows(f); }); }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    setErr(""); setBusy(true);
    try {
      await addGlobalFont(name, url);
      setName(""); setUrl(""); load();
    } catch (e) { setErr(e.message || "Could not add the font."); }
    setBusy(false);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div className="rounded-2xl bg-ink-850 p-5 ring-1 ring-white/10">
        <h3 className="font-display text-lg font-bold text-white">Add a font</h3>
        <p className="mt-1 text-xs text-slate-500">Paste a Google Fonts (or any CSS) stylesheet URL and the exact family name. It becomes selectable in every user&apos;s editor.</p>
        <div className="mt-4 space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Family name e.g. Poppins" className="w-full rounded-lg bg-ink-800 px-3 py-2 text-sm text-white ring-1 ring-inset ring-white/10" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&display=swap" className="w-full rounded-lg bg-ink-800 px-3 py-2 text-sm text-white ring-1 ring-inset ring-white/10" />
          {err && <p className="text-xs font-semibold text-accent-400">{err}</p>}
          <button onClick={add} disabled={busy} className="btn-cool w-full justify-center disabled:opacity-60">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4" /> Add font</>}</button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {rows === null && <p className="col-span-full py-8 text-center text-sm text-slate-500">Loading…</p>}
        {rows && rows.length === 0 && <p className="col-span-full py-8 text-center text-sm text-slate-500">No fonts added yet.</p>}
        {rows && rows.map((f) => (
          <div key={f.id} className="flex items-center justify-between rounded-xl bg-ink-850 p-4 ring-1 ring-white/10">
            <div className="min-w-0">
              <p className="truncate text-lg text-white" style={{ fontFamily: f.name }}>{f.name}</p>
              <p className="truncate text-xs text-slate-500" style={{ fontFamily: f.name }}>The quick brown fox 1234</p>
            </div>
            <button onClick={async () => { await removeGlobalFont(f.id); load(); }} className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-ink-800 text-slate-400 ring-1 ring-inset ring-white/10 hover:text-accent-400"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============ USERS (admin: role + delete) ============ */
function UsersTab() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState(""); // yyyy-mm-dd — joined-on-or-after
  const [to, setTo] = useState("");     // yyyy-mm-dd — joined-on-or-before
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => { listAllUsers().then(setRows); }, []);
  useEffect(() => { load(); }, [load]);

  const callAdmin = async (payload) => {
    setErr("");
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) { setErr("Please sign in again."); return null; }
    const res = await fetch("/api/admin/user", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, idToken }) });
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok || !data.ok) { setErr(data.error || "Action failed."); return null; }
    return data;
  };

  const toggleRole = async (u) => {
    const next = u.role === "admin" ? "user" : "admin";
    setBusyId(u.id);
    const r = await callAdmin({ action: "setRole", uid: u.id, role: next });
    if (r) setRows((rs) => rs.map((x) => (x.id === u.id ? { ...x, role: r.role } : x)));
    setBusyId(null);
  };

  const remove = async (u) => {
    if (!confirm(`Delete ${u.fullName || u.phone || "this user"}? This removes their account and data permanently.`)) return;
    setBusyId(u.id);
    const r = await callAdmin({ action: "delete", uid: u.id });
    if (r) setRows((rs) => rs.filter((x) => x.id !== u.id));
    setBusyId(null);
  };

  const meUid = auth.currentUser?.uid;
  // Custom date range on the JOINED date (createdAt). `to` is inclusive of the whole day.
  const fromMs = from ? new Date(`${from}T00:00:00`).getTime() : null;
  const toMs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
  const list = (rows || []).filter((u) => {
    const t = q.trim().toLowerCase();
    if (t) {
      const hit = (u.fullName || "").toLowerCase().includes(t) || (u.phone || "").toLowerCase().includes(t) || (u.email || "").toLowerCase().includes(t);
      if (!hit) return false;
    }
    if (fromMs || toMs) {
      const j = tsMs(u.createdAt);
      if (fromMs && j < fromMs) return false;
      if (toMs && j > toMs) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / phone / email" className="w-full max-w-xs rounded-lg bg-ink-800 px-3 py-2 text-sm text-white ring-1 ring-inset ring-white/10 sm:w-72" />
        <p className="text-xs text-slate-500">{rows ? `${list.length} of ${rows.length} user(s)` : "Loading…"}</p>
      </div>
      {/* Custom joined-date range */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span className="font-semibold uppercase tracking-wide text-slate-500">Joined</span>
        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
          className="rounded-lg bg-ink-800 px-2.5 py-1.5 text-white ring-1 ring-inset ring-white/10" />
        <span>to</span>
        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
          className="rounded-lg bg-ink-800 px-2.5 py-1.5 text-white ring-1 ring-inset ring-white/10" />
        {(from || to) && (
          <button onClick={() => { setFrom(""); setTo(""); }} className="text-slate-400 underline-offset-2 hover:text-white hover:underline">clear</button>
        )}
      </div>
      {err && <p className="text-sm font-semibold text-accent-400">{err}</p>}

      <div className="overflow-x-auto rounded-2xl bg-ink-850 ring-1 ring-white/10">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">Loading…</td></tr>}
            {rows && list.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">No users found.</td></tr>}
            {list.map((u) => (
              <tr key={u.id} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3">
                  <p className="font-semibold text-white">{u.fullName || "—"}{u.id === meUid && <span className="ml-2 rounded bg-brand-500/20 px-1.5 py-0.5 text-[10px] font-bold text-brand-200">YOU</span>}</p>
                  <p className="text-xs text-slate-500">{u.email || ""}</p>
                </td>
                <td className="px-4 py-3 text-slate-300">{u.phone || "—"}</td>
                <td className="px-4 py-3"><span className="rounded-md bg-ink-800 px-2 py-0.5 text-xs font-semibold uppercase text-slate-300">{u.plan || "free"}</span></td>
                <td className="px-4 py-3">
                  {u.role === "admin"
                    ? <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-bold text-emerald-300"><ShieldCheck className="h-3.5 w-3.5" /> Admin</span>
                    : <span className="inline-flex items-center gap-1 rounded-md bg-ink-800 px-2 py-0.5 text-xs font-semibold text-slate-400"><UserIcon className="h-3.5 w-3.5" /> User</span>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <button disabled={u.id === meUid || busyId === u.id} onClick={() => toggleRole(u)} className="rounded-lg bg-ink-800 px-2.5 py-1.5 text-xs font-semibold text-slate-200 ring-1 ring-inset ring-white/10 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40">
                      {busyId === u.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (u.role === "admin" ? "Make user" : "Make admin")}
                    </button>
                    <button disabled={u.id === meUid || busyId === u.id} onClick={() => remove(u)} className="grid h-8 w-8 place-items-center rounded-lg bg-ink-800 text-slate-400 ring-1 ring-inset ring-white/10 transition hover:text-accent-400 disabled:cursor-not-allowed disabled:opacity-40" title="Delete user">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">You can&apos;t change or delete your own account here (safety).</p>
    </div>
  );
}