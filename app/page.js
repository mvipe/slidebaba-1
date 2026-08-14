"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { useAuth } from "@/context/AuthContext";
import {
  ArrowRight, Sparkles, UploadCloud, Brain, DownloadCloud, Upload, Check, X as XIcon,
  GraduationCap, Presentation, Laptop, Crosshair, LayoutGrid, Scissors, Rocket, Crown,
  FileUp, Zap, Bot, CheckCircle2, FileText, MonitorPlay, Play,
} from "lucide-react";
import LandingNav from "@/components/landing/LandingNav";
import Logo from "@/components/Logo";

/* ---------- motion helpers ---------- */
const fade = {
  hidden: { opacity: 0, y: 22 },
  show: (i = 0) => ({ opacity: 1, y: 0, transition: { delay: 0.06 * i, duration: 0.55, ease: "easeOut" } }),
};
const reveal = {
  hidden: { opacity: 0, y: 30 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } },
};
const vp = { once: true, margin: "-70px" };

/* ---------- data ---------- */
const TONES = {
  sky: "bg-sky-500/15 text-sky-300 ring-sky-500/20",
  emerald: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/20",
  flame: "bg-flame-500/15 text-flame-400 ring-flame-500/20",
  brand: "bg-brand-500/15 text-brand-300 ring-brand-500/20",
  accent: "bg-accent-500/15 text-accent-300 ring-accent-500/20",
  yellow: "bg-yellow-400/15 text-yellow-300 ring-yellow-400/20",
};
const BADGE = {
  sky: "text-sky-300 ring-sky-500/40",
  flame: "text-flame-400 ring-flame-500/40",
  emerald: "text-emerald-300 ring-emerald-500/40",
};
const HOVER_RING = {
  sky: "hover:ring-sky-500/40",
  flame: "hover:ring-flame-500/40",
  emerald: "hover:ring-emerald-500/40",
};

const AUDIENCE = [
  { icon: GraduationCap, tone: "sky", title: "For Students", text: "Convert your cluttered lecture snapshots into tidy, exam-ready A4 PDFs — and never misplace a formula again." },
  { icon: Presentation, tone: "emerald", title: "For Teachers", text: "Turn textbook pages straight into polished presentation decks (PPT). Spend your hours teaching, not retyping." },
  { icon: Laptop, tone: "flame", title: "For Creators", text: "Effortlessly digitize aging books, research papers, and handwritten manuscripts into editable formats within seconds." },
];

const SUPER = [
  { icon: Crosshair, tone: "sky", badge: "99.9% ACCURACY", title: "Cognitive OCR Engine", text: "Decodes untidy handwriting, advanced calculus, and scientific notation with precision, rebuilding them as crisp digital text." },
  { icon: LayoutGrid, tone: "flame", badge: "NATIVE VECTOR", title: "Auto-Layout Matrix", text: "Reshapes raw content into presentation-ready decks — automatically sizing fonts, aligning images, and generating editable shapes." },
  { icon: Scissors, tone: "emerald", badge: "CONTEXT-AWARE", title: "Smart Snipping Tool", text: "Use the built-in selector to pick out individual questions from any page and instantly produce step-by-step solutions." },
];

const STEPS = [
  { icon: UploadCloud, tone: "text-sky-400", ring: "ring-sky-500/30", num: "1", title: "Upload File", text: "Drop your handwritten notes, textbook photos, or raw PDFs." },
  { icon: Brain, tone: "text-brand-400", ring: "ring-brand-500/30", num: "2", title: "AI Analysis", text: "Our engine extracts text and decodes complex mathematical formulas accurately." },
  { icon: DownloadCloud, tone: "text-flame-400", ring: "ring-flame-500/30", num: "3", title: "Download Magic", text: "Get beautifully formatted, editable PPTs or A4 print-ready notes." },
];

/* period-aware plan data (m = monthly, y = yearly) */
const PLAN_DATA = {
  free:   { name: "Free",   m: "₹0",     y: "₹0",      credits: { m: "5",   y: "5" },     docs: { m: "2",   y: "2" },     slides: { m: "3,000+",  y: "3,000+" },    maxSlidesPerDoc: { m: 25, y: 25 }, pdf: true, ppt: true,  branding: true, teaching: false, icon: Rocket },
  basic:  { name: "Basic",  m: "₹999",   y: "₹9,999",  credits: { m: "150", y: "2,400" }, docs: { m: "150", y: "2,400" }, slides: { m: "3,000+",  y: "36,000+" },   maxSlidesPerDoc: { m: 100, y: 100 }, pdf: true, ppt: false, branding: true, teaching: false, icon: Rocket, ym: "≈ ₹833/mo" },
  medium: { name: "Medium", m: "₹1,999", y: "₹19,990", credits: { m: "400", y: "5,400" }, docs: { m: "400", y: "5,400" }, slides: { m: "8,000+",  y: "96,000+" },   maxSlidesPerDoc: { m: 150, y: 150 }, pdf: true, ppt: true,  branding: true, teaching: false, icon: Rocket, ym: "≈ ₹1,666/mo" },
  high:   { name: "High",   m: "₹2,999", y: "₹29,990", credits: { m: "749", y: "9,600" }, docs: { m: "749", y: "9,600" }, slides: { m: "15,000+", y: "1,80,000+" }, maxSlidesPerDoc: { m: 200, y: 200 }, pdf: true, ppt: true,  branding: true, teaching: true,  icon: Crown,  ym: "≈ ₹2,499/mo", popular: true },
};

const QUICK = [
  { icon: FileUp, tone: "flame", title: "Just upload a PDF or click a photo", text: "AI builds professional PPTs in seconds." },
  { icon: Zap, tone: "yellow", title: "No typing needed", text: "Let AI carry the workload." },
  { icon: Rocket, tone: "accent", title: "Fast & Easy", text: "Ready-to-present slides, instantly." },
  { icon: Bot, tone: "brand", title: "AI-Powered", text: "Smart extraction with beautifully designed slides." },
];

const FAQS = [
  { q: "What file types can I upload?", a: "PDFs, JPGs and PNGs — including photos of handwritten notes and printed question papers." },
  { q: "Does it handle math and equations?", a: "Yes. SlideBaba reads complex math with Vision OCR and rebuilds it as editable LaTeX/Unicode in your slides and notes." },
  { q: "Can I edit the output?", a: "Absolutely. Everything opens in an editor where you can change text, fonts, colours, backgrounds, formulas and your branding." },
  { q: "Is there a free plan?", a: "Yes — the Free plan gives you 2 documents and 5 AI credits every month, with no credit card required." },
];

const LATEX = "$$ \\int_{a}^{b} x^2\\,dx = \\frac{b^3 - a^3}{3} $$";

export default function LandingPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [billing, setBilling] = useState("monthly");
  const yearly = billing === "yearly";

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [user, loading, router]);

  if (loading || user) return <div className="min-h-screen bg-white dark:bg-ink-950" />;

  return (
    <div className="min-h-screen overflow-x-clip bg-grid bg-white text-ink-900 dark:bg-ink-950 dark:text-slate-200">
      <LandingNav />

      {/* ============ HERO ============ */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute -top-24 left-1/2 h-72 w-[46rem] -translate-x-1/2 rounded-full bg-sky-500/10 blur-3xl dark:bg-sky-500/15 sm:bg-brand-500/20 sm:dark:bg-brand-600/25" />
        <div className="pointer-events-none absolute right-0 top-40 h-72 w-72 rounded-full bg-sky-500/15 blur-3xl dark:bg-sky-500/20 sm:bg-accent-500/15 sm:dark:bg-accent-500/20" />
        <div className="pointer-events-none absolute -left-10 top-60 h-64 w-64 rounded-full bg-emerald-500/10 blur-3xl" />

        <div className="container-x relative grid items-center gap-12 py-16 lg:grid-cols-2 lg:py-24">
          <div>
            <motion.span variants={fade} initial="hidden" animate="show" className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider text-emerald-500 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Powered by Thumbnail Baba
            </motion.span>
            <motion.h1 variants={fade} initial="hidden" animate="show" custom={1} className="mt-5 font-display text-4xl font-extrabold leading-[1.08] tracking-tight l-head sm:text-5xl lg:text-[2.5rem] xl:text-5xl">
              <span className="whitespace-nowrap">Transform Books into</span>
              <br />
              <span className="gradient-text">Smart PPTs &amp; Notes</span>
            </motion.h1>
            <motion.p variants={fade} initial="hidden" animate="show" custom={2} className="mt-5 max-w-xl text-lg leading-relaxed l-muted">
              Upload your raw PDFs, handwritten notes, or textbook images. SlideBaba reads complex math equations with Vision OCR and auto-formats them into editable presentations and A4 PDFs — instantly.
            </motion.p>
            <motion.div variants={fade} initial="hidden" animate="show" custom={3} className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/register" className="btn bg-ink-900 text-white shadow-soft hover:-translate-y-0.5 dark:bg-white dark:text-ink-900"><UploadCloud className="h-5 w-5" /> Upload Document</Link>
              <a href="#how" className="l-ghost text-base"><Play className="h-4 w-4" /> Watch Demo</a>
            </motion.div>
            <motion.div variants={fade} initial="hidden" animate="show" custom={4} className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm l-muted">
              <span className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-500" /> 99.9% OCR accuracy</span>
              <span className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-500" /> Editable .pptx</span>
              <span className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-500" /> Math as LaTeX</span>
            </motion.div>
          </div>

          {/* crafted animated mockup */}
          <motion.div initial={{ opacity: 0, scale: 0.95, y: 24 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.6 }} className="relative mx-auto w-full max-w-md">
            <div className="l-card relative z-10 p-5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-widest l-muted">AI Output Preview</span>
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-flame-gradient text-white"><Presentation className="h-4 w-4" /></span>
              </div>
              <div className="mt-4 space-y-2">
                {[92, 70].map((w, i) => <div key={i} className="h-2.5 rounded-full bg-slate-200 dark:bg-ink-700" style={{ width: `${w}%` }} />)}
              </div>
              <div className="mt-3 rounded-xl bg-emerald-500/10 p-3 ring-1 ring-inset ring-emerald-500/20">
                <code className="block break-all font-mono text-[11px] leading-relaxed text-emerald-600 dark:text-emerald-300">{LATEX}</code>
              </div>
              <div className="mt-3 space-y-2">
                {[84, 96, 60].map((w, i) => <div key={i} className="h-2.5 rounded-full bg-slate-200 dark:bg-ink-700" style={{ width: `${w}%` }} />)}
              </div>
            </div>

            <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.5, duration: 0.5 }}
              className="absolute -left-5 -top-6 z-20 animate-floaty rounded-2xl bg-white p-3 shadow-glow ring-1 ring-black/5 dark:bg-ink-800 dark:ring-white/10">
              <div className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-sky-500/15 text-sky-400"><Upload className="h-4 w-4" /></span>
                <div className="pr-1">
                  <p className="text-xs font-bold l-head">Maths_Ch1.jpg</p>
                  <p className="text-[11px] font-semibold text-sky-400">Scanning OCR…</p>
                </div>
              </div>
            </motion.div>

            <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.7, duration: 0.5 }}
              className="absolute -right-4 top-2 z-20 hidden animate-floaty rounded-2xl bg-white p-3 shadow-glow ring-1 ring-black/5 dark:bg-ink-800 dark:ring-white/10 sm:block" style={{ animationDelay: "1.2s" }}>
              <div className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent-500/15 text-accent-400"><FileText className="h-4 w-4" /></span>
                <div className="pr-1">
                  <p className="text-xs font-bold l-head">Science_Draft.pdf</p>
                  <p className="text-[11px] font-semibold text-accent-400">Parsing data…</p>
                </div>
              </div>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.9, duration: 0.5 }}
              className="absolute -bottom-6 left-8 z-20 animate-floaty rounded-2xl bg-white p-3 shadow-glow ring-1 ring-black/5 dark:bg-ink-800 dark:ring-white/10" style={{ animationDelay: "0.6s" }}>
              <div className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-yellow-400/20 text-yellow-500"><Sparkles className="h-4 w-4" /></span>
                <div className="pr-1">
                  <p className="text-xs font-bold l-head">AI Formatting</p>
                  <p className="text-[11px] l-muted">Structuring PPT layout</p>
                </div>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* ============ HOW IT WORKS ============ */}
      <section id="how" className="section">
        <div className="container-x">
          <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={vp} className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-extrabold tracking-tight l-head sm:text-4xl">From Paper to Pixel in <span className="gradient-text">3 Steps</span></h2>
            <p className="mt-4 l-muted">No manual typing. No formatting headaches. Just upload and let the SlideBaba Engine do the heavy lifting.</p>
          </motion.div>
          <div className="relative mx-auto mt-16 grid max-w-5xl gap-12 md:grid-cols-3">
            <div className="pointer-events-none absolute left-[16.6%] right-[16.6%] top-10 hidden h-px bg-gradient-to-r from-sky-500/40 via-brand-500/60 to-flame-500/40 md:block" />
            {STEPS.map((s, i) => (
              <motion.div key={s.title} custom={i} variants={fade} initial="hidden" whileInView="show" viewport={vp} className="relative z-10 flex flex-col items-center text-center">
                <div className={`grid h-20 w-20 place-items-center rounded-3xl bg-white ring-1 ${s.ring} shadow-card dark:bg-ink-850`}>
                  <s.icon className={`h-8 w-8 ${s.tone}`} />
                </div>
                <h3 className="mt-6 font-display text-xl font-bold l-head">{s.num}. {s.title}</h3>
                <p className="mt-2 max-w-xs text-sm leading-relaxed l-muted">{s.text}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ BUILT FOR THE MODERN WORLD ============ */}
      <section className="section">
        <div className="container-x">
          <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={vp} className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-extrabold tracking-tight l-head sm:text-4xl">Built For The Modern World</h2>
            <p className="mt-4 l-muted">Whether you're teaching a packed classroom or revising solo, we hand your time back.</p>
          </motion.div>
          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {AUDIENCE.map((a, i) => (
              <motion.div key={a.title} custom={i} variants={fade} initial="hidden" whileInView="show" viewport={vp}
                className="l-card group p-7 transition hover:-translate-y-1">
                <span className={`grid h-14 w-14 place-items-center rounded-2xl ring-1 ring-inset ${TONES[a.tone]}`}><a.icon className="h-7 w-7" /></span>
                <h3 className="mt-5 font-display text-xl font-bold l-head">{a.title}</h3>
                <p className="mt-2 text-sm leading-relaxed l-muted">{a.text}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ SUPERCHARGED FEATURES ============ */}
      <section id="features" className="section l-section-alt border-y border-black/5 dark:border-white/10">
        <div className="container-x">
          <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={vp} className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-extrabold tracking-tight l-head sm:text-4xl">Supercharged Features</h2>
            <p className="mt-4 l-muted">Driven by our purpose-built, custom-trained deep-learning models.</p>
          </motion.div>
          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {SUPER.map((f, i) => (
              <motion.div key={f.title} custom={i} variants={fade} initial="hidden" whileInView="show" viewport={vp}
                className={`group relative overflow-hidden rounded-3xl bg-white p-7 ring-1 ring-black/5 shadow-card transition duration-300 hover:-translate-y-1 hover:shadow-glow dark:bg-ink-850 dark:ring-white/10 ${HOVER_RING[f.tone]}`}>
                <div className={`pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full opacity-0 blur-2xl transition-all duration-500 group-hover:-right-6 group-hover:-top-6 group-hover:opacity-100 ${TONES[f.tone].split(" ")[0]}`} />
                <div className="relative flex items-start justify-between">
                  <span className={`grid h-12 w-12 place-items-center rounded-xl ring-1 ring-inset ${TONES[f.tone]}`}><f.icon className="h-6 w-6" /></span>
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset ${BADGE[f.tone]}`}>{f.badge}</span>
                </div>
                <h3 className="relative mt-5 font-display text-xl font-bold l-head">{f.title}</h3>
                <p className="relative mt-2 text-sm leading-relaxed l-muted">{f.text}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ PRICING ============ */}
      <section id="pricing" className="section l-section-alt border-y border-black/5 dark:border-white/10">
        <div className="container-x">
          <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={vp} className="mx-auto max-w-2xl text-center">
            <span className="eyebrow">Pricing</span>
            <h2 className="mt-3 font-display text-3xl font-extrabold tracking-tight l-head sm:text-4xl">Simple plans, <span className="gradient-text">serious value</span></h2>
          </motion.div>

          {/* billing toggle */}
          <div className="mx-auto mt-8 flex w-fit items-center gap-1 rounded-full bg-slate-100 p-1 ring-1 ring-inset ring-black/5 dark:bg-ink-800 dark:ring-white/10">
            <button onClick={() => setBilling("monthly")} className={`rounded-full px-5 py-2 text-sm font-bold transition ${!yearly ? "bg-ink-900 text-white dark:bg-white dark:text-ink-900" : "l-muted hover:text-ink-900 dark:hover:text-white"}`}>Monthly</button>
            <button onClick={() => setBilling("yearly")} className={`flex items-center gap-2 rounded-full px-5 py-2 text-sm font-bold transition ${yearly ? "bg-ink-900 text-white dark:bg-white dark:text-ink-900" : "l-muted hover:text-ink-900 dark:hover:text-white"}`}>
              Yearly <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-white">SAVE ~20%</span>
            </button>
          </div>

          {yearly ? (
            <div className="mx-auto mt-10 grid max-w-5xl gap-6 lg:grid-cols-3">
              {["basic", "medium", "high"].map((id, i) => <PlanCard key={id} p={PLAN_DATA[id]} period="yearly" i={i} />)}
            </div>
          ) : (
            <>
              <div className="mx-auto mt-10 grid max-w-5xl gap-6 lg:grid-cols-3">
                {["free", "basic", "medium"].map((id, i) => <PlanCard key={id} p={PLAN_DATA[id]} period="monthly" i={i} />)}
              </div>
              <div className="mx-auto mt-6 max-w-md">
                <PlanCard p={PLAN_DATA.high} period="monthly" i={0} />
              </div>
            </>
          )}
        </div>
      </section>

      {/* ============ QUICK FEATURES + REGISTER BANNER ============ */}
      <section className="section">
        <div className="container-x">
          <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={vp} className="rounded-3xl bg-white p-6 ring-1 ring-black/5 shadow-card dark:bg-ink-850/70 dark:ring-white/10 sm:p-8">
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {QUICK.map((q, i) => (
                <motion.div key={q.title} custom={i} variants={fade} initial="hidden" whileInView="show" viewport={vp} className="flex items-start gap-3">
                  <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset ${TONES[q.tone]}`}><q.icon className="h-5 w-5" /></span>
                  <div>
                    <p className="text-sm font-bold l-head">{q.title}</p>
                    <p className="mt-0.5 text-xs l-muted">{q.text}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>

          <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={vp} className="mt-6 flex items-center justify-center gap-2 rounded-3xl border border-emerald-500/30 bg-emerald-500/5 px-6 py-5 text-center">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
            <p className="text-sm font-semibold l-head sm:text-base">
              <Link href="/register" className="text-emerald-500 hover:underline">Register now</Link> and start creating amazing presentations!
            </p>
          </motion.div>
        </div>
      </section>

      {/* ============ FAQ ============ */}
      <section id="faq" className="section l-section-alt border-y border-black/5 dark:border-white/10">
        <div className="container-x">
          <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={vp} className="mx-auto max-w-2xl text-center">
            <span className="eyebrow">FAQ</span>
            <h2 className="mt-3 font-display text-3xl font-extrabold tracking-tight l-head sm:text-4xl">Questions, <span className="gradient-text">answered</span></h2>
          </motion.div>
          <div className="mx-auto mt-12 grid max-w-3xl gap-4">
            {FAQS.map((f, i) => (
              <motion.details key={f.q} custom={i} variants={fade} initial="hidden" whileInView="show" viewport={vp} className="group l-card rounded-2xl p-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold l-head">
                  {f.q}
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-500/10 text-brand-500 transition group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed l-muted">{f.a}</p>
              </motion.details>
            ))}
          </div>
        </div>
      </section>

      {/* ============ CTA ============ */}
      <section className="section">
        <div className="container-x">
          <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={vp} className="relative overflow-hidden rounded-3xl bg-gradient-to-b from-emerald-500/10 to-transparent px-8 py-16 text-center ring-1 ring-emerald-500/20 sm:px-16">
            <div className="pointer-events-none absolute left-1/2 top-0 h-48 w-[36rem] -translate-x-1/2 rounded-full bg-emerald-500/20 blur-3xl" />
            <h2 className="relative font-display text-3xl font-extrabold tracking-tight l-head sm:text-4xl">Ready to automate your <span className="gradient-text">study notes?</span></h2>
            <p className="relative mx-auto mt-4 max-w-xl l-muted">Join thousands of users who are saving hours every week. Create your first smart presentation in seconds.</p>
            <Link href="/register" className="btn mt-8 bg-ink-900 text-white shadow-glow hover:-translate-y-0.5 dark:bg-white dark:text-ink-900">Start Generating for Free <ArrowRight className="h-4 w-4" /></Link>
            <p className="relative mt-4 text-xs l-muted">No credit card required for the Free plan.</p>
          </motion.div>
        </div>
      </section>

      {/* ============ FOOTER ============ */}
      <footer className="border-t border-black/5 bg-slate-50 py-12 dark:border-white/10 dark:bg-ink-900/60">
        <div className="container-x grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <span className="text-ink-900 dark:text-white"><Logo /></span>
            <p className="mt-3 max-w-sm text-sm l-muted">Revolutionizing education and content creation with advanced AI OCR and presentation generation.</p>
          </div>
          <div>
            <p className="font-display text-sm font-bold l-head">Product</p>
            <ul className="mt-3 space-y-2 text-sm l-muted">
              <li><a href="#features" className="hover:text-brand-500">Features</a></li>
              <li><a href="#pricing" className="hover:text-brand-500">Pricing</a></li>
            </ul>
          </div>
          <div>
            <p className="font-display text-sm font-bold l-head">Legal</p>
            <ul className="mt-3 space-y-2 text-sm l-muted">
              <li><a href="#" className="hover:text-brand-500">Privacy Policy</a></li>
              <li><a href="#" className="hover:text-brand-500">Terms of Service</a></li>
              <li><a href="#" className="hover:text-brand-500">Contact Us</a></li>
            </ul>
          </div>
        </div>
        <div className="container-x mt-10 border-t border-black/5 pt-6 text-center text-xs l-muted dark:border-white/10">
          <p>© {new Date().getFullYear()} SlideBaba. All rights reserved.</p>
          <p className="mt-1">Created by Mehi tech Ai Digital Solution Pvt Ltd</p>
        </div>
      </footer>
    </div>
  );
}

/* ---------- plan card ---------- */
function Feat({ ok, children }) {
  return (
    <li className={`flex items-start gap-2 ${ok ? "l-muted" : "text-slate-400 line-through dark:text-slate-600"}`}>
      {ok
        ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        : <XIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400 dark:text-slate-600" />}
      <span>{children}</span>
    </li>
  );
}

function PlanCard({ p, period, i }) {
  const Icon = p.icon;
  const popular = p.popular;
  const yearly = period === "yearly";
  const k = yearly ? "y" : "m";
  const price = p[k];
  const per = yearly ? "/year" : "/month";
  const docsLabel = yearly ? "Documents/year" : "Documents/month";
  const badge = popular ? (yearly ? "Best Value" : "Most Popular") : null;

  return (
    <motion.div custom={i} variants={fade} initial="hidden" whileInView="show" viewport={vp}
      className={`relative flex flex-col rounded-3xl bg-white p-6 shadow-card ring-1 dark:bg-ink-850 ${popular ? "ring-2 ring-emerald-400/60 dark:ring-emerald-400/60" : "ring-black/5 dark:ring-white/10"}`}>
      {badge && <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow-soft">★ {badge}</span>}
      <span className={`grid h-12 w-12 place-items-center rounded-2xl ring-1 ring-inset ${popular ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" : "bg-sky-500/15 text-sky-300 ring-sky-500/20"}`}><Icon className="h-6 w-6" /></span>
      <h3 className={`mt-4 font-display text-lg font-bold ${popular ? "text-emerald-500 dark:text-emerald-400" : "l-head"}`}>{p.name}</h3>
      <p className="mt-1 font-display text-4xl font-extrabold l-head">{price}<span className="text-sm l-muted">{per}</span></p>
      {yearly && p.ym ? <p className="mt-0.5 text-xs font-semibold text-emerald-500">{p.ym} billed yearly</p> : <p className="mt-0.5 text-xs l-muted">&nbsp;</p>}

      <ul className="mt-4 flex-1 space-y-3 text-sm">
        <li className="flex items-start gap-2 l-muted">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          <span>Up to <b className={popular ? "text-emerald-500 dark:text-emerald-400" : "text-brand-500 dark:text-brand-300"}>{p.maxSlidesPerDoc[k]}</b> slides per document</span>
        </li>
        <Feat ok>{p.credits[k]} AI Credits</Feat>
        <Feat ok>{p.docs[k]} {docsLabel}</Feat>
        <Feat ok={p.pdf}>PDF Export</Feat>
        <Feat ok={p.ppt}>PPT Export</Feat>
        <Feat ok={p.branding}>Custom Branding</Feat>
        <Feat ok={p.teaching}>Teaching Mode</Feat>
      </ul>

      <div className={`mt-5 flex items-center gap-3 rounded-2xl border-2 border-dashed p-4 ${popular ? "border-emerald-400/40 bg-emerald-500/5" : "border-sky-400/40 bg-sky-500/5 dark:border-white/15"}`}>
        <MonitorPlay className={`h-8 w-8 shrink-0 ${popular ? "text-emerald-400" : "text-sky-400"}`} />
        <div className="min-w-0 leading-tight">
          <p className="text-xs font-medium l-muted">Create</p>
          <p className="font-display text-2xl font-extrabold l-head">
            <span className={popular ? "text-emerald-400" : "text-sky-400"}>{p.slides[k]}</span>
            <span className="ml-1.5 text-base font-semibold l-muted">Slides</span>
          </p>
        </div>
      </div>

      <Link href="/register" className={`mt-4 flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-base font-bold transition ${popular ? "bg-gradient-to-r from-emerald-500 to-cyan-500 text-white shadow-soft hover:-translate-y-0.5" : "bg-ink-800 text-white hover:bg-ink-700"}`}>
        Subscribe to {p.name} <ArrowRight className="h-5 w-5" />
      </Link>
    </motion.div>
  );
}
