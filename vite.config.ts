import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Set by `tauri dev` when targeting a physical device on the LAN.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
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
    // WebView2 is evergreen Chromium.
    target: "chrome120",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    cssCodeSplit: true,
  },
});
