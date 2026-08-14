"use client";

import { Menu } from "lucide-react";
import PlanBadges from "@/components/dashboard/PlanBadges";
import { useSidebar } from "@/components/dashboard/sidebarStore";

export default function Topbar({ title }) {
  const { setOpen } = useSidebar();
  return (
    <header className="flex h-16 items-center gap-2 border-b border-white/10 bg-ink-900/60 px-3 sm:px-6">
      <button onClick={() => setOpen(true)} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-300 hover:bg-ink-700 hover:text-white lg:hidden" aria-label="Open menu">
        <Menu className="h-5 w-5" />
      </button>
      <h1 className="truncate font-display text-lg font-extrabold text-white sm:text-xl">{title}</h1>
      <div className="ml-auto min-w-0 overflow-x-auto">
        <PlanBadges />
      </div>
    </header>
  );
}
