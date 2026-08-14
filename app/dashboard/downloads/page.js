"use client";

import { useEffect, useState } from "react";
import { Download, FileDown, Trash2, Presentation } from "lucide-react";
import Topbar from "@/components/dashboard/Topbar";
import { useAuth } from "@/context/AuthContext";
import { listDownloads, removeDownload } from "@/lib/docs";
import { fmtDate } from "@/lib/usage";

export default function DownloadsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user) listDownloads(user.uid).then((d) => { setItems(d); setLoading(false); });
  }, [user]);

  const del = async (id) => {
    await removeDownload(user.uid, id);
    setItems((prev) => prev.filter((x) => x.id !== id));
  };

  return (
    <>
      <Topbar title="My Downloads" />
      <div className="flex-1 overflow-y-auto bg-dots p-6">
        {loading ? (
          <p className="py-16 text-center text-sm text-slate-500">Loading…</p>
        ) : items.length === 0 ? (
          <div className="grid place-items-center rounded-2xl bg-ink-850 p-16 text-center ring-1 ring-white/10">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-500/15 text-brand-300 ring-1 ring-inset ring-brand-500/30">
              <Download className="h-7 w-7" />
            </span>
            <h2 className="mt-5 font-display text-xl font-bold text-white">No downloads yet</h2>
            <p className="mt-2 max-w-sm text-sm text-slate-400">Exported .pptx decks and notes will appear here once you download them from the editor.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl bg-ink-850 ring-1 ring-white/10">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-white/10 px-5 py-3 text-xs font-bold uppercase tracking-wider text-slate-500">
              <span>File</span><span className="hidden sm:block">Date</span><span>Type</span><span></span>
            </div>
            {items.map((d) => (
              <div key={d.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-white/5 px-5 py-3.5 last:border-0">
                <span className="flex items-center gap-3 truncate">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-500/15 text-brand-300"><Presentation className="h-4 w-4" /></span>
                  <span className="truncate font-medium text-white">{d.name}</span>
                </span>
                <span className="hidden text-sm text-slate-400 sm:block">{fmtDate(d.createdAt?.toDate ? d.createdAt.toDate() : Date.now())}</span>
                <span className="rounded-full bg-sky-500/15 px-2.5 py-1 text-[10px] font-bold uppercase text-sky-300">{d.format || "file"}</span>
                <button onClick={() => del(d.id)} className="grid h-8 w-8 place-items-center rounded-lg bg-ink-800 text-slate-400 ring-1 ring-inset ring-white/10 hover:text-accent-400">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
