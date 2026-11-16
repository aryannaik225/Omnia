/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** TMDB v3 API key or v4 read access token (preferred name). */
  readonly TMDB_API_KEY?: string;
  /** Legacy alias. */
  readonly VITE_TMDB_API_KEY?: string;
  /** "1" in the Android TV build: a thin client of the desktop's LAN server. */
  readonly VITE_OMNIA_THIN_CLIENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** package.json version, injected at build time. */
declare const __APP_VERSION__: string;
