"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";

const LINKS = [
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#how" },
  { label: "Pricing", href: "#pricing" },
];

export default function LandingNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`sticky top-0 z-50 border-b backdrop-blur-md transition-all duration-300 ${scrolled ? "border-black/5 bg-white/85 shadow-sm dark:border-white/10 dark:bg-ink-900/80" : "border-transparent bg-white/60 dark:bg-ink-900/40"}`}>
      <nav className={`mx-auto flex w-full max-w-[1640px] items-center justify-between px-5 transition-all duration-300 sm:px-8 lg:px-12 ${scrolled ? "h-16" : "h-20"}`}>
        <Link href="/" className="text-ink-900 dark:text-white">
          <Logo />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-sm font-medium text-slate-600 transition hover:text-ink-900 dark:text-slate-300 dark:hover:text-white"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <ThemeToggle />
          <Link
            href="/login"
            className="text-sm font-semibold text-slate-700 hover:text-ink-900 dark:text-slate-200 dark:hover:text-white"
          >
            Log in
          </Link>
          <Link href="/register" className="btn-cool">Get started free</Link>
        </div>

        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle />
          <button
            onClick={() => setOpen((v) => !v)}
            className="grid h-10 w-10 place-items-center rounded-xl text-ink-900 ring-1 ring-black/10 dark:text-white dark:ring-white/10"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {open && (
        <div className="border-t border-black/5 bg-white dark:border-white/10 dark:bg-ink-900 md:hidden">
          <div className="mx-auto flex w-full max-w-[1640px] flex-col gap-1 px-5 py-4 sm:px-8">
            {LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-black/5 dark:text-slate-300 dark:hover:bg-ink-800"
              >
                {l.label}
              </a>
            ))}
            <Link href="/register" onClick={() => setOpen(false)} className="btn-cool mt-2">
              Get started free
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
