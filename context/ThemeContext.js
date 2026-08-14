"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

const ThemeContext = createContext(null);

function applyTheme(t) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (t === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState("dark");

  // Sync state with whatever the pre-hydration script already applied.
  useEffect(() => {
    const isDark = document.documentElement.classList.contains("dark");
    setTheme(isDark ? "dark" : "light");
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem("slidebaba-theme", next);
      } catch {}
      return next;
    });
  }, []);

  const setMode = useCallback((mode) => {
    applyTheme(mode);
    try {
      localStorage.setItem("slidebaba-theme", mode);
    } catch {}
    setTheme(mode);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggle, setMode }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
