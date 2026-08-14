"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid, FolderOpen, Wand2, Download, Crown, Settings, LogOut, Sun, Moon, X, ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { isAdmin } from "@/lib/admin";
import { useTheme } from "@/context/ThemeContext";
import { useSidebar } from "@/components/dashboard/sidebarStore";

const MENU = [
  { label: "Overview", href: "/dashboard", icon: LayoutGrid },
  { label: "My Documents", href: "/dashboard/documents", icon: FolderOpen },
  { label: "AI Studio", href: "/dashboard/studio", icon: Wand2 },
  { label: "My Downloads", href: "/dashboard/downloads", icon: Download },
];
const ACCOUNT = [
  { label: "Subscription", href: "/dashboard/subscription", icon: Crown },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { profile, user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { open, setOpen } = useSidebar();
  const isDark = theme === "dark";
  const close = () => setOpen(false);
  const isActive = (href) => (href === "/dashboard" ? pathname === href : pathname.startsWith(href));

  return (
    <>
      {/* backdrop (mobile) */}
      {open && <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={close} />}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-full w-64 shrink-0 transform flex-col border-r border-white/10 bg-ink-900 p-4 transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 lg:bg-ink-900/80 ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between">
          <Link href="/dashboard" onClick={close} className="flex items-center gap-2.5 px-2 py-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="SlideBaba" className="h-9 w-9 rounded-xl shadow-soft" />
            <span>
              <span className="block font-display text-base font-extrabold leading-none text-white">Slide<span className="gradient-text">Baba</span></span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-brand-400">Workspace</span>
            </span>
          </Link>
          <button onClick={close} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-ink-700 hover:text-white lg:hidden" aria-label="Close menu"><X className="h-5 w-5" /></button>
        </div>

        <p className="mb-2 mt-5 px-3 text-[10px] font-bold uppercase tracking-widest text-slate-600">Menu</p>
        <nav className="space-y-1">
          {MENU.map((m) => (
            <Link key={m.href} href={m.href} onClick={close} className={`nav-item ${isActive(m.href) ? "nav-item-active" : ""}`}>
              <m.icon className="h-4 w-4" /> {m.label}
            </Link>
          ))}
        </nav>

        <p className="mb-2 mt-6 px-3 text-[10px] font-bold uppercase tracking-widest text-slate-600">Account</p>
        <nav className="space-y-1">
          {ACCOUNT.map((m) => (
            <Link key={m.href} href={m.href} onClick={close} className={`nav-item ${isActive(m.href) ? "nav-item-active" : ""}`}>
              <m.icon className="h-4 w-4" /> {m.label}
            </Link>
          ))}
          {isAdmin(profile) && (
            <Link href="/dashboard/admin" onClick={close} className={`nav-item ${isActive("/dashboard/admin") ? "nav-item-active" : ""}`}>
              <ShieldCheck className="h-4 w-4 text-emerald-400" /> Admin
            </Link>
          )}
          <button onClick={toggle} className="nav-item w-full">
            {isDark ? <Sun className="h-4 w-4 text-flame-400" /> : <Moon className="h-4 w-4 text-brand-300" />}
            {isDark ? "Light Mode" : "Dark Mode"}
          </button>
        </nav>

        <div className="mt-auto rounded-2xl bg-ink-800/70 p-3 ring-1 ring-white/10">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-gradient text-sm font-bold text-white">
              {(profile?.fullName || user?.displayName || "U").charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">{profile?.fullName || user?.displayName || "SlideBaba User"}</p>
              <p className="text-xs capitalize text-slate-400">{profile?.plan || "free"}</p>
            </div>
            <button onClick={logout} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-ink-700 hover:text-white" aria-label="Log out"><LogOut className="h-4 w-4" /></button>
          </div>
        </div>
      </aside>
    </>
  );
}
