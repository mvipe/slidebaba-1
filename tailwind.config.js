/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,jsx}",
    "./components/**/*.{js,jsx}",
    "./lib/**/*.{js,jsx}",
    "./context/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "system-ui", "sans-serif"],
      },
      colors: {
        // Thumbnail BABA inspired: indigo/violet primary, fuchsia + orange accents
        brand: {
          50: "#f3f1ff",
          100: "#ebe7ff",
          200: "#d9d2ff",
          300: "#bcaeff",
          400: "#9a82ff",
          500: "#7c5cff",
          600: "#6d3aed",
          700: "#5b2bd6",
          800: "#4a25ab",
          900: "#3d2189",
          950: "#241152",
        },
        accent: {
          400: "#f472b6",
          500: "#ec4899",
          600: "#db2777",
        },
        flame: {
          400: "#fb923c",
          500: "#f97316",
          600: "#ea580c",
        },
        // dark surface scale (driven by CSS variables so it can switch themes)
        ink: {
          950: "rgb(var(--ink-950) / <alpha-value>)",
          900: "rgb(var(--ink-900) / <alpha-value>)",
          850: "rgb(var(--ink-850) / <alpha-value>)",
          800: "rgb(var(--ink-800) / <alpha-value>)",
          700: "rgb(var(--ink-700) / <alpha-value>)",
          600: "rgb(var(--ink-600) / <alpha-value>)",
          500: "rgb(var(--ink-500) / <alpha-value>)",
        },
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(124,92,255,0.18), 0 18px 50px -16px rgba(124,92,255,0.55)",
        soft: "0 10px 40px -12px rgba(109,58,237,0.45)",
        card: "0 1px 2px rgba(0,0,0,0.4), 0 12px 40px -16px rgba(0,0,0,0.6)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #6d3aed 0%, #8b5cf6 45%, #ec4899 100%)",
        "brand-cool": "linear-gradient(135deg, #6d3aed 0%, #7c5cff 50%, #4f46e5 100%)",
        "flame-gradient": "linear-gradient(135deg, #f97316 0%, #fb923c 100%)",
      },
      keyframes: {
        floaty: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-10px)" } },
        pulseglow: {
          "0%,100%": { opacity: "0.5" },
          "50%": { opacity: "1" },
        },
        gridmove: { "0%": { backgroundPosition: "0 0" }, "100%": { backgroundPosition: "40px 40px" } },
      },
      animation: {
        floaty: "floaty 6s ease-in-out infinite",
        pulseglow: "pulseglow 3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
