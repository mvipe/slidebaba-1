"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, FileText, Presentation, FileType2, Trash2, Plus } from "lucide-react";
import Topbar from "@/components/dashboard/Topbar";
import { useAuth } from "@/context/AuthContext";
import { listDocuments, removeDocument, loadDocument } from "@/lib/docs";
import { saveHandoff } from "@/lib/slideStore";
import { fmtDate } from "@/lib/usage";

const TABS = ["All", "Generated", "Analyzed"];

export default function DocumentsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("All");
  const [q, setQ] = useState("");
  const [opening, setOpening] = useState(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (user) listDocuments(user.uid).then((d) => { setDocs(d); setLoading(false); });
  }, [user]);

  // Slides / notes HTML now live in a chunked subcollection (so they are no longer capped
  // at Firestore's 1 MiB per-document limit), which means opening a document has to fetch
  // the payload first instead of reading it off the list entry.
  const open = async (d, format) => {
    if (opening) return;
    setOpening(d.id);
    setLoadError("");
    try {
      const fmt = format || d.format || "slides";
      const full = await loadDocument(user.uid, d.id, fmt);
      const doc = full || d;
      if (fmt === "notes") {
        saveHandoff({
          title: doc.name, format: "notes", notesHtml: doc.notesHtml || "", items: doc.items || [],
          header: doc.header || {}, cols: doc.cols || 1, docId: d.id,
          chunks: doc.chunkCount ?? null, updatedAtMs: doc.updatedAt?.toMillis ? doc.updatedAt.toMillis() : 0,
        });
        router.push("/notes");
      } else {
        saveHandoff({
          title: doc.name, format: "slides", slides: doc.slides || [], docId: d.id,
          chunks: doc.chunkCount ?? null, updatedAtMs: doc.updatedAt?.toMillis ? doc.updatedAt.toMillis() : 0,
        });
        router.push("/editor");
      }
    } catch (e) {
      console.error("[SlideBaba] open document failed:", e);
      setLoadError(e?.message || "Couldn't open that document. Check your connection and try again.");
      setOpening(null);
    }
  };

  const del = async (e, d) => {
    e.stopPropagation();
    await removeDocument(user.uid, d.id);
    setDocs((prev) => prev.filter((x) => x.id !== d.id));
  };

  const filtered = docs.filter((d) => {
    const okTab = tab === "All" || (d.status || "generated").toLowerCase() === tab.toLowerCase();
    const okQ = !q || d.name.toLowerCase().includes(q.toLowerCase());
    return okTab && okQ;
  });

  return (
    <>
      <Topbar title="My Documents" />
      <div className="flex-1 overflow-y-auto bg-dots p-6">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-md">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search your generated notes..."
              className="w-full rounded-lg bg-ink-850 py-3 pl-11 pr-4 text-sm text-white placeholder:text-slate-500 ring-1 ring-inset ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div className="flex items-center gap-1 rounded-xl bg-ink-850 p-1 ring-1 ring-inset ring-white/10">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${tab === t ? "bg-brand-gradient text-white" : "text-slate-400 hover:text-white"}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {loadError && (
          <div className="mb-4 rounded-xl bg-accent-500/10 px-4 py-3 text-sm text-accent-200 ring-1 ring-inset ring-accent-500/30">{loadError}</div>
        )}

        {loading ? (
          <p className="py-16 text-center text-sm text-slate-500">Loading…</p>
        ) : filtered.length === 0 ? (
          <div className="grid place-items-center rounded-2xl bg-ink-850 p-16 text-center ring-1 ring-white/10">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-500/15 text-brand-300 ring-1 ring-inset ring-brand-500/30">
              <FileText className="h-7 w-7" />
            </span>
            <h2 className="mt-5 font-display text-xl font-bold text-white">No documents here yet</h2>
            <p className="mt-2 max-w-sm text-sm text-slate-400">Generate slides or notes from AI Studio and they'll show up here.</p>
            <Link href="/dashboard/studio" className="btn-primary mt-6"><Plus className="h-4 w-4" /> New conversion</Link>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((d) => (
              <div key={d.id} className="group min-w-0 rounded-xl bg-ink-850 p-4 ring-1 ring-white/10 transition hover:ring-brand-500/40">
                <div className="flex items-start justify-between">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-500/15 text-brand-300"><FileText className="h-5 w-5" /></span>
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">{d.status || "generated"}</span>
                </div>
                <h3 className="mt-3 truncate font-semibold text-white" title={d.name}>{d.name}</h3>
                <p className="text-xs text-slate-500">{fmtDate(d.createdAt?.toDate ? d.createdAt.toDate() : Date.now())}</p>
                <div className="mt-4 flex min-w-0 items-center gap-2 border-t border-white/5 pt-3">
                  <button onClick={() => open(d, "slides")} disabled={!!opening} className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-brand-500/10 py-2 text-xs font-semibold text-brand-300 ring-1 ring-inset ring-brand-500/20 hover:bg-brand-500/20 disabled:opacity-50">
                    <Presentation className="h-3.5 w-3.5" /> {opening === d.id ? "Opening…" : "PPT"}
                  </button>
                  <button onClick={() => open(d, "notes")} disabled={!!opening} className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-sky-500/10 py-2 text-xs font-semibold text-sky-300 ring-1 ring-inset ring-sky-500/20 hover:bg-sky-500/20 disabled:opacity-50">
                    <FileType2 className="h-3.5 w-3.5" /> A4
                  </button>
                  <button onClick={(e) => del(e, d)} className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-ink-800 text-slate-400 ring-1 ring-inset ring-white/10 hover:text-accent-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
