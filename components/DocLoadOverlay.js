"use client";

import Link from "next/link";
import { Loader2, FileText } from "lucide-react";

/**
 * Covers an editor while its document is (re)loaded from the server — e.g. after a page
 * reload, when the one-time handoff from Studio / My Documents is gone. Nothing can be
 * typed (and so nothing can be saved) until the real content is back.
 */
export default function DocLoadOverlay({ loading, error, what = "slides" }) {
  if (!loading && !error) return null;
  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-ink-950/85 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl bg-ink-900 p-6 text-center ring-1 ring-white/10">
        {error ? (
          <>
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-accent-500/15 text-accent-300"><FileText className="h-6 w-6" /></span>
            <p className="mt-4 font-display text-lg font-bold text-white">Couldn&apos;t open this document</p>
            <p className="mt-1 text-sm text-slate-400">{error}</p>
            <Link href="/dashboard/documents" className="btn-primary mt-5 inline-flex">Go to My Documents</Link>
          </>
        ) : (
          <p className="flex items-center justify-center gap-2 font-semibold text-white">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading your {what}…
          </p>
        )}
      </div>
    </div>
  );
}
