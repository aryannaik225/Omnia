/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** TMDB v3 API key or v4 read access token (used by src/services/tmdbClient.ts). */
  readonly VITE_TMDB_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
