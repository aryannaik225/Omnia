/**
 * Web stand-in for the desktop's typed Tauri bridge: the shared data shapes only. The browser
 * edition has no Rust backend; tracking lives in components/tracker (localStorage / Supabase).
 */
export type MediaType = "movie" | "tv";

export interface CustomHub {
  hubSlug: string;
  displayName: string;
  categoryType: string;
  logoAsset?: string | null;
  heroVideoAsset?: string | null;
  tmdbFilterRule: Record<string, unknown>;
  sortOrder?: number;
}

export interface SubscribedProvider {
  providerId: number;
  providerName: string;
  logoPath: string | null;
  regionCode: string;
  isActive: boolean;
}

/** A provider link for a title (web: TMDB availability + the provider's own search page). */
export interface ResolvedLink {
  providerId: number;
  providerName: string;
  monetizationType: string;
  directUrl: string;
  quality: string | null;
  isFallback: boolean;
}

export interface WatchHistoryEntry {
  seasonNumber: number;
  episodeNumber: number;
  isCompleted: boolean;
  completionRatio: number;
  progressSeconds: number;
  lastWatchedAt: string;
  providerName: string | null;
}

export interface MediaCatalogEntry {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  originalTitle?: string | null;
  overview?: string | null;
  posterPath?: string | null;
  backdropPath?: string | null;
  releaseYear?: number | null;
  runtimeMins?: number | null;
  genres?: { id: number; name: string }[];
  keywords?: string[];
  credits?: Record<string, unknown>;
  voteAverage?: number | null;
  certification?: string | null;
}

export interface TmdbProviderHint {
  providerId: number;
  providerName: string;
  monetizationType: string;
}
