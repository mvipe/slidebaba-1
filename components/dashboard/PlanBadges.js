"use client";

import Link from "next/link";
import { Zap, Scissors, Clock, Bell } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { remaining, cycleInfo } from "@/lib/plan";

export default function PlanBadges() {
  const { profile } = useAuth();
  const { docsLeft, docsLimit, snipsLeft, snipsLimit } = remaining(profile);
  const { daysLeft } = cycleInfo(profile);
  const plan = profile?.plan || "free";

  return (
    <div className="flex w-max items-center gap-2.5">
      <Link
        href="/dashboard/subscription"
        className="hidden shrink-0 items-center gap-2 rounded-full bg-ink-800 px-3.5 py-2 text-xs font-bold text-flame-400 ring-1 ring-inset ring-flame-500/30 sm:flex"
      >
        <Clock className="h-3.5 w-3.5" /> {daysLeft} Days Left
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 capitalize text-emerald-300">{plan === "free" ? "Upgrade" : plan}</span>
      </Link>
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-ink-800 px-3 py-2 text-xs font-bold text-brand-300 ring-1 ring-inset ring-brand-500/30" title="Document credits left this cycle">
        <Zap className="h-3.5 w-3.5" /> {docsLeft}/{docsLimit} Docs
      </span>
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-ink-800 px-3 py-2 text-xs font-bold text-sky-300 ring-1 ring-inset ring-sky-500/30" title="AI credits left this cycle">
        <Scissors className="h-3.5 w-3.5" /> {snipsLeft}/{snipsLimit} Snips
      </span>
      <button className="relative hidden h-9 w-9 shrink-0 place-items-center rounded-full bg-ink-800 text-slate-300 ring-1 ring-inset ring-white/10 hover:text-white sm:grid">
        <Bell className="h-4 w-4" />
        <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-accent-500" />
      </button>
    </div>
  );
}
