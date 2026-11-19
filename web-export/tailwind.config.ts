import type { Config } from "tailwindcss";

// The desktop app's "Liquid Glass" tokens (src/styles/liquid-glass.css, tailwind.config.js).
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 900: "#0b0b0f" },
        label: { primary: "#f5f5f7", secondary: "rgba(235,235,245,0.72)", tertiary: "rgba(235,235,245,0.5)" },
        gold: { 200: "#fff1b8", 300: "#f4dc9a", 400: "#e9c45c", 600: "#8a6417" },
      },
      borderRadius: { panel: "24px", card: "16px", pill: "12px" },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "Inter", "system-ui", "sans-serif"],
        display: ["var(--font-grotesk)", "-apple-system", "system-ui", "sans-serif"],
        grotesk: ["var(--font-grotesk)", "-apple-system", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
