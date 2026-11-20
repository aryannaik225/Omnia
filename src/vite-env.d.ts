/// <reference types="vite/client" />

/**
 * Only `VITE_OMNIA_*` / `TAURI_ENV_*` variables reach the bundle (vite.config.ts `envPrefix`).
 * Secrets never do: TMDB_API_KEY and the Supabase values are compiled into the Rust binary by
 * src-tauri/build.rs.
 */
interface ImportMetaEnv {
  /** "1" in the Android TV build: a thin client of the desktop's LAN server. */
  readonly VITE_OMNIA_THIN_CLIENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** package.json version, injected at build time. */
declare const __APP_VERSION__: string;
