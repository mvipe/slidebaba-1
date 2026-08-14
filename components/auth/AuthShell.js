"use client";

import Link from "next/link";
import { ScanText, FileDown, Sigma } from "lucide-react";

const PILLS = [
  { icon: ScanText, label: "SlideBaba Vision OCR", tone: "text-brand-400" },
  { icon: FileDown, label: "Auto-PPTX Export", tone: "text-sky-400" },
  { icon: Sigma, label: "Complex Math Ready", tone: "text-flame-400" },
];

export default function AuthShell({ children }) {
  return (
    <main className="app-shell relative min-h-screen overflow-hidden bg-ink-950 bg-grid">
      <div className="pointer-events-none absolute -left-32 top-0 h-96 w-96 rounded-full bg-brand-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 bottom-0 h-96 w-96 rounded-full bg-accent-500/15 blur-3xl" />

      <div className="container-x flex min-h-screen items-center justify-center py-10">
        <div className="grid w-full max-w-5xl overflow-hidden rounded-3xl bg-ink-900/80 shadow-card ring-1 ring-white/10 backdrop-blur md:grid-cols-2">
          {/* Brand side */}
          <div className="relative hidden flex-col justify-between border-r border-white/10 bg-ink-850/60 p-10 md:flex">
            <Link href="/" className="flex items-center gap-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.svg" alt="SlideBaba" className="h-10 w-10 rounded-xl shadow-soft" />
              <span className="font-display text-xl font-extrabold tracking-tight text-white">
                Slide<span className="gradient-text">Baba</span>
              </span>
            </Link>

            <div>
              <h2 className="font-display text-4xl font-extrabold leading-tight text-white">
                Your Personal
                <br />
                <span className="gradient-text">AI Assistant</span>
              </h2>

              <div className="mt-8 space-y-3">
                {PILLS.map((p) => (
                  <div
                    key={p.label}
                    className="inline-flex w-full items-center gap-3 rounded-xl bg-ink-800/70 px-4 py-3 ring-1 ring-inset ring-white/10"
                  >
                    <span className={`grid h-6 w-6 place-items-center rounded-full bg-ink-700 ${p.tone}`}>
                      <p.icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-sm font-semibold text-slate-100">{p.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <p className="text-xs text-slate-500">
              Trusted by students, teachers & creators across India.
            </p>
          </div>

          {/* Form side */}
          <div className="p-8 sm:p-10">{children}</div>
        </div>
      </div>
      <div id="recaptcha-container" />
    </main>
  );
}
