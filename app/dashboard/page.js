"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FileText, Presentation, Clock, Upload, ArrowRight,
  FileImage, FileType, Wand2,
} from "lucide-react";
import { Menu } from "lucide-react";
import PlanBadges from "@/components/dashboard/PlanBadges";
import { useSidebar } from "@/components/dashboard/sidebarStore";
import { useAuth } from "@/context/AuthContext";
import { listDocuments, loadDocument } from "@/lib/docs";
import { saveHandoff } from "@/lib/slideStore";
import { fmtDate } from "@/lib/usage";

export default function OverviewPage() {
  const { user, profile } = useAuth();
  const { setOpen } = useSidebar();
  const router = useRouter();
  const [docs, setDocs] = useState([]);
  const name = (profile?.fullName || user?.displayName || "there").split(" ")[0];

  useEffect(() => {
    if (user) listDocuments(user.uid).then(setDocs);
  }, [user]);

  const thisMonth = docs.filter((d) => {
    const dt = d.createdAt?.toDate ? d.createdAt.toDate() : null;
    return dt && dt.getMonth() === new Date().getMonth() && dt.getFullYear() === new Date().getFullYear();
  }).length;

  // The payload lives in a chunked subcollection now, so fetch it before handing over.
  const openDoc = async (d) => {
    try {
      const full = (await loadDocument(user.uid, d.id, d.format || "slides")) || d;
      saveHandoff({
        title: full.name, format: full.format || "slides", slides: full.slides || [], docId: d.id,
        chunks: full.chunkCount ?? null, updatedAtMs: full.updatedAt?.toMillis ? full.updatedAt.toMillis() : 0,
      });
      router.push("/editor");
    } catch (e) {
      console.error("[SlideBaba] open document failed:", e);
      alert(e?.message || "Couldn't open that document. Check your connection and try again.");
    }
  };

  const STATS = [
    { label: "Total Documents", value: docs.length, icon: Presentation, accent: "from-sky-400 to-sky-600", tint: "text-sky-400" },
    { label: "This Month", value: thisMonth, icon: FileText, accent: "from-emerald-400 to-emerald-600", tint: "text-emerald-400" },
    { label: "Hours Saved", value: `${docs.length}`, suffix: "hrs", icon: Clock, accent: "from-flame-400 to-flame-600", tint: "text-flame-400" },
  ];

  return (
    <>
      <div className="flex items-center gap-2 border-b border-white/10 bg-ink-900/60 px-3 py-3 sm:px-6">
        <button onClick={() => setOpen(true)} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-300 hover:bg-ink-700 hover:text-white lg:hidden" aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-base font-extrabold text-white sm:text-2xl">Welcome back, {name}!</h1>
          <p className="hidden text-sm text-slate-400 sm:block">Here's what's happening with your projects today.</p>
        </div>
        <div className="shrink-0"><PlanBadges /></div>
      </div>

      <div className="flex-1 overflow-y-auto bg-dots p-6">
        {/* stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          {STATS.map((s) => (
            <div key={s.label} className="relative overflow-hidden rounded-2xl bg-ink-850 p-5 ring-1 ring-white/10">
              <span className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${s.accent}`} />
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{s.label}</p>
                  <p className="mt-2 font-display text-4xl font-extrabold text-white">
                    {s.value}{s.suffix && <span className="ml-1 text-lg text-slate-500">{s.suffix}</span>}
                  </p>
                </div>
                <span className={`grid h-11 w-11 place-items-center rounded-xl bg-ink-800 ${s.tint} ring-1 ring-inset ring-white/10`}>
                  <s.icon className="h-5 w-5" />
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* quick generate */}
        <div className="mt-6 overflow-hidden rounded-3xl bg-ink-850 p-6 ring-1 ring-white/10 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-5">
              <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-brand-gradient text-white shadow-soft">
                <Wand2 className="h-7 w-7" />
              </span>
              <div>
                <h2 className="font-display text-xl font-bold text-white">Quick Generate</h2>
                <p className="mt-1 max-w-lg text-sm text-slate-400">
                  Drop a PDF, JPG, or PNG file — AI transforms it into polished presentations or notes instantly.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Link href="/dashboard/studio" className="btn-primary">
                    <Upload className="h-4 w-4" /> Upload &amp; Generate
                  </Link>
                  <span className="text-xs text-slate-500">or head to AI Studio</span>
                </div>
              </div>
            </div>
            <div className="flex gap-2 lg:flex-col">
              {[{ i: FileType, t: "PDF" }, { i: FileImage, t: "JPG" }, { i: FileImage, t: "PNG" }].map((c, k) => (
                <span key={k} className="flex items-center gap-2 rounded-lg bg-ink-800 px-3 py-2 text-xs font-semibold text-slate-300 ring-1 ring-inset ring-white/10">
                  <c.i className="h-4 w-4 text-brand-300" /> {c.t}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* recent documents */}
        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-white">Recent Documents</h2>
            <Link href="/dashboard/documents" className="flex items-center gap-1 text-sm font-semibold text-sky-400 hover:text-sky-300">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="overflow-hidden rounded-2xl bg-ink-850 ring-1 ring-white/10">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-white/10 px-5 py-3 text-xs font-bold uppercase tracking-wider text-slate-500">
              <span>Document name</span><span className="hidden sm:block">Date</span><span>Status</span><span>Open</span>
            </div>
            {docs.length === 0 ? (
              <div className="grid place-items-center px-5 py-12 text-center">
                <FileText className="h-8 w-8 text-slate-600" />
                <p className="mt-3 text-sm text-slate-400">No documents yet. Generate your first from AI Studio.</p>
                <Link href="/dashboard/studio" className="btn-ghost mt-4">Open AI Studio</Link>
              </div>
            ) : (
              docs.slice(0, 5).map((d) => (
                <button
                  key={d.id}
                  onClick={() => openDoc(d)}
                  className="grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-white/5 px-5 py-3.5 text-left transition last:border-0 hover:bg-ink-800"
                >
                  <span className="flex items-center gap-3 truncate">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-500/15 text-brand-300"><FileText className="h-4 w-4" /></span>
                    <span className="truncate font-medium text-white">{d.name}</span>
                  </span>
                  <span className="hidden text-sm text-slate-400 sm:block">{fmtDate(d.createdAt?.toDate ? d.createdAt.toDate() : Date.now())}</span>
                  <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-bold uppercase text-emerald-300">{d.status || "generated"}</span>
                  <ArrowRight className="h-4 w-4 text-slate-500" />
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
