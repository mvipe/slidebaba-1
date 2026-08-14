"use client";

import { Sun, Moon } from "lucide-react";
import { useTheme } from "@/context/ThemeContext";

// Compact light/dark toggle for editor headers.
export default function ThemeToggleButton({ className = "" }) {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      onClick={toggle}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={`grid h-9 w-9 place-items-center rounded-lg text-slate-300 ring-1 ring-inset ring-white/10 transition hover:bg-ink-700 hover:text-white ${className}`}
    >
      {isDark ? <Sun className="h-4 w-4 text-flame-400" /> : <Moon className="h-4 w-4 text-brand-300" />}
    </button>
  );
}
