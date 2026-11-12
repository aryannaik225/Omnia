/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#07070a",
          900: "#0b0b0f",
          800: "#121216",
          700: "#1a1a20",
        },
        glass: {
          base: "rgba(18, 18, 22, 0.65)",
          strong: "rgba(18, 18, 22, 0.82)",
          soft: "rgba(255, 255, 255, 0.06)",
          hover: "rgba(255, 255, 255, 0.12)",
          edge: "rgba(255, 255, 255, 0.22)",
        },
        label: {
          primary: "rgba(255, 255, 255, 0.96)",
          secondary: "rgba(235, 235, 245, 0.72)",
          tertiary: "rgba(235, 235, 245, 0.5)",
        },
        accent: {
          DEFAULT: "#0a84ff",
          soft: "rgba(10, 132, 255, 0.24)",
        },
      },
      borderRadius: {
        panel: "24px",
        card: "16px",
        pill: "12px",
      },
      backdropBlur: {
        glass: "24px",
      },
      backdropSaturate: {
        glass: "180%",
      },
      boxShadow: {
        specular: "inset 0 1px 0 rgba(255, 255, 255, 0.22)",
        glass:
          "inset 0 1px 0 rgba(255, 255, 255, 0.22), inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 12px 40px rgba(0, 0, 0, 0.45)",
        lift: "inset 0 1px 0 rgba(255, 255, 255, 0.28), 0 24px 60px rgba(0, 0, 0, 0.6)",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"SF Pro Display"',
          '"Segoe UI Variable Display"',
          '"Segoe UI"',
          "Inter",
          "system-ui",
          "sans-serif",
        ],
      },
      transitionTimingFunction: {
        spring: "cubic-bezier(0.32, 0.72, 0, 1)",
      },
      keyframes: {
        "ambient-drift": {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)" },
          "50%": { transform: "translate3d(2%, -3%, 0) scale(1.08)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "ambient-drift": "ambient-drift 24s ease-in-out infinite",
        shimmer: "shimmer 1.8s linear infinite",
      },
    },
  },
  plugins: [],
};
