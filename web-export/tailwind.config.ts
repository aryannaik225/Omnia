import type { Config } from "tailwindcss";

// The desktop app's "Liquid Glass" tokens (src/styles/liquid-glass.css, tailwind.config.js).
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 900: "#0b0b0f" },
        label: { primary: "#f5f5f7", secondary: "rgba(235,235,245,0.72)", tertiary: "rgba(235,235,245,0.5)" },
      },
      borderRadius: { panel: "24px", card: "16px", pill: "12px" },
      fontFamily: { sans: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "Inter", "system-ui", "sans-serif"] },
    },
  },
  plugins: [],
} satisfies Config;
