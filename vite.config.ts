import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Set by `tauri dev` when targeting a physical device on the LAN.
const host = process.env.TAURI_DEV_HOST;

// `--mode tv` builds the Android TV thin client (talks to the desktop's LAN server).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    ...(mode === "tv" ? { "import.meta.env.VITE_OMNIA_THIN_CLIENT": JSON.stringify("1") } : {}),
  },
  // Keep Rust compiler output visible in the same terminal.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // `TMDB_` exposes TMDB_API_KEY from .env to the catalog UI (it is copied into local settings for Rust).
  envPrefix: ["VITE_", "TAURI_ENV_", "TMDB_"],
  build: {
    // WebView2 / Android WebView are evergreen Chromium; iPhones open the LAN companion in Safari.
    target: ["chrome120", "safari16"],
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    cssCodeSplit: true,
  },
}));
