"use client";

import { Sun, Moon } from "lucide-react";
import { useTheme } from "@/context/ThemeContext";

export default function ThemeToggle({ className = "" }) {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      className={`grid h-10 w-10 place-items-center rounded-xl ring-1 transition ring-black/10 hover:bg-black/5 dark:ring-white/10 dark:hover:bg-white/10 ${className}`}
    >
      {isDark ? <Sun className="h-5 w-5 text-flame-400" /> : <Moon className="h-5 w-5 text-brand-600" />}
    </button>
  );
}
