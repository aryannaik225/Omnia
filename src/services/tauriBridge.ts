/**
 * Typed wrappers for every Rust `#[tauri::command]` in `src-tauri/src/lib.rs`.
 * Argument keys are camelCase (Tauri maps them to the Rust snake_case parameters).
 * All data stays on-device: these calls only cross the in-process IPC boundary.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type MediaType = "movie" | "tv";
export type MonetizationType = "flatrate" | "free" | "ads" | "rent" | "buy" | "search";
export type TimeOfDayBucket = "Morning" | "Afternoon" | "Evening" | "PrimeTime" | "LateNight";

// ---------------------------------------------------------------------------------------------
// Models (mirror src-tauri/src/db/queries.rs and resolver/justwatch.rs)
// ---------------------------------------------------------------------------------------------

export interface AppProfile {
  profileId: number;
  profileName: string;
  avatarAsset: string | null;
  isKidsProfile: boolean;
  createdAt: string;
}

export interface OttProfileMapping {
  appProfileId: number;
  providerId: number;
  ottNativeProfileId: string;
  ottNativeProfileName: string | null;
}

export interface SubscribedProvider {
  providerId: number;
  providerName: string;
  logoPath: string | null;
  regionCode: string;
  isActive: boolean;
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
  genres?: unknown;
  keywords?: unknown;
  credits?: unknown;
  voteAverage?: number | null;
  certification?: string | null;
  updatedAt?: string | null;
}

export interface WatchHistoryEntry {
  id: number;
  appProfileId: number;
  tmdbId: number;
  mediaType: MediaType;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  providerName: string | null;
  directUrl: string | null;
  progressSeconds: number;
  durationSeconds: number;
  completionRatio: number;
  isCompleted: boolean;
  watchCount: number;
  abandoned: boolean;
  lastWatchedAt: string;
  timeOfDayBucket: TimeOfDayBucket | null;
}

export interface ContinueWatchingItem extends WatchHistoryEntry {
  title: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseYear: number | null;
  runtimeMins: number | null;
  /** The latest episode was finished: offer the next one. */
  upNext: boolean;
}

export interface ProgressUpdate {
  appProfileId: number;
  tmdbId: number;
  mediaType: MediaType;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string | null;
  providerName?: string | null;
  directUrl?: string | null;
  progressSeconds: number;
  durationSeconds: number;
}

export interface HistoryImport {
  appProfileId: number;
  tmdbId: number;
  mediaType: MediaType;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string | null;
  providerName?: string | null;
  directUrl?: string | null;
  progressSeconds?: number;
  durationSeconds?: number;
  isCompleted?: boolean;
  /** ISO-8601 timestamp; defaults to now. */
  watchedAt?: string | null;
  timeOfDayBucket?: TimeOfDayBucket | null;
}

export interface PlaybackEvent {
  id: number;
  appProfileId: number;
  tmdbId: number;
  mediaType: MediaType;
  eventType: string;
  sessionWatchDurationSec: number;
  timestamp: string;
}

export interface CustomHub {
  hubSlug: string;
  displayName: string;
  categoryType: string;
  logoAsset?: string | null;
  heroVideoAsset?: string | null;
  tmdbFilterRule: Record<string, unknown>;
  sortOrder?: number;
}

export interface WatchlistItem {
  appProfileId: number;
  tmdbId: number;
  mediaType: MediaType;
  addedAt: string;
  title: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseYear: number | null;
  voteAverage: number | null;
}

export interface TmdbProviderHint {
  providerId: number;
  providerName: string;
  monetizationType: Exclude<MonetizationType, "search">;
}

export interface ResolveRequest {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  originalTitle?: string | null;
  releaseYear?: number | null;
  region: string;
  tmdbProviders?: TmdbProviderHint[];
  forceRefresh?: boolean;
}

export interface ResolvedLink {
  providerId: number;
  providerName: string;
  monetizationType: MonetizationType;
  directUrl: string;
  quality: "4K" | "HD" | "SD" | null;
  /** The URL is a provider search page rather than the title itself. */
  isFallback: boolean;
  expiresAt: string | null;
}

export interface ResolveResponse {
  tmdbId: number;
  mediaType: MediaType;
  regionCode: string;
  source: "cache" | "justwatch" | "fallback";
  justwatchUrl: string | null;
  links: ResolvedLink[];
}

export const SettingKeys = {
  activeProfileId: "active_profile_id",
  regionCode: "region_code",
  regionSource: "region_source",
  subscriptionsOnly: "subscriptions_only",
  lanServerEnabled: "lan_server_enabled",
  kidsSafeMode: "kids_safe_mode",
  tmdbApiKey: "tmdb_api_key",
} as const;

export const OmniaEvents = {
  backToHub: "omnia://back-to-hub",
  playerOpened: "omnia://player-opened",
  playerClosed: "omnia://player-closed",
  playbackProgress: "omnia://playback-progress",
  playerTitleChanged: "omnia://player-title-changed",
  ottProfileMismatch: "omnia://ott-profile-mismatch",
  ottProfileRerouted: "omnia://ott-profile-rerouted",
  ottProfileConnected: "omnia://ott-profile-connected",
  historyImportProgress: "omnia://history-import-progress",
  historyImportFinished: "omnia://history-import-finished",
} as const;

export const BACK_TO_HUB_EVENT = OmniaEvents.backToHub;

// ---------------------------------------------------------------------------------------------
// Player & import models (mirror player/window_manager.rs and sync/history_importer.rs)
// ---------------------------------------------------------------------------------------------

export type PlayerMode = "play" | "connect";

export interface OpenPlayerRequest {
  appProfileId: number;
  providerId: number;
  providerName: string;
  mode?: PlayerMode;
  tmdbId?: number;
  mediaType?: MediaType;
  title?: string;
  originalTitle?: string | null;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string | null;
  /** Required for `play`; optional landing-page override for `connect`. */
  directUrl?: string;
  /** Defaults to the saved local progress for this item. */
  resumeAtSeconds?: number | null;
  region?: string;
}

export interface PlayerOpened {
  label: string;
  mode: PlayerMode;
  resumeAtSeconds: number | null;
  mappedOttProfileId: string | null;
}

export interface PlayerStatus {
  label: string;
  mode: PlayerMode;
  appProfileId: number;
  providerId: number;
  providerName: string;
  tmdbId: number | null;
  mediaType: MediaType | null;
  title: string | null;
  seasonNumber: number;
  episodeNumber: number;
  progressSeconds: number;
  durationSeconds: number;
  activeWatchSeconds: number;
  awaitingRebind: boolean;
}

export interface DetectedMedia {
  title: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  ottTitleId: string | null;
  confidence: "high" | "low";
}

export interface RebindRequest {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  originalTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  episodeTitle?: string | null;
}

export interface ImportReport {
  appProfileId: number;
  providerName: string;
  ottProfileId: string | null;
  fetched: number;
  imported: number;
  matchedTitles: number;
  unmatchedTitles: string[];
}

export interface PlaybackProgressEvent {
  appProfileId: number;
  tmdbId: number;
  mediaType: MediaType;
  seasonNumber: number;
  episodeNumber: number;
  progressSeconds: number;
  durationSeconds: number;
  paused: boolean;
}

export interface TitleChangedEvent {
  appProfileId: number;
  providerId: number;
  providerName: string;
  previousTmdbId: number;
  detected: DetectedMedia;
}

export interface OttProfileConnectedEvent {
  appProfileId: number;
  providerId: number;
  providerName: string;
  ottProfileId: string;
  ottProfileName: string | null;
}

export interface ImportProgressEvent {
  appProfileId: number;
  providerName: string;
  stage: "fetching" | "matching" | "saving";
  done: number;
  total: number;
}

export type ImportFinishedEvent =
  | { ok: true; report: ImportReport }
  | { ok: false; appProfileId: number; providerId: number; providerName: string; error: string };

/** True when running inside the Tauri shell (false in a plain browser / LAN companion). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

export const profiles = {
  list: () => invoke<AppProfile[]>("list_profiles"),
  create: (profileName: string, isKidsProfile = false, avatarAsset: string | null = null) =>
    invoke<AppProfile>("create_profile", { profileName, avatarAsset, isKidsProfile }),
  update: (profileId: number, profileName: string, isKidsProfile: boolean, avatarAsset: string | null = null) =>
    invoke<AppProfile>("update_profile", { profileId, profileName, avatarAsset, isKidsProfile }),
  remove: (profileId: number) => invoke<boolean>("delete_profile", { profileId }),
};

export const settings = {
  get: (key: string) => invoke<string | null>("get_setting", { key }),
  set: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  getAll: () => invoke<Record<string, string>>("get_all_settings"),
  remove: (key: string) => invoke<boolean>("delete_setting", { key }),
};

export const ottMappings = {
  list: (appProfileId: number) => invoke<OttProfileMapping[]>("list_ott_profile_mappings", { appProfileId }),
  upsert: (mapping: OttProfileMapping) => invoke<void>("upsert_ott_profile_mapping", { mapping }),
  remove: (appProfileId: number, providerId: number) =>
    invoke<boolean>("delete_ott_profile_mapping", { appProfileId, providerId }),
};

export const subscriptions = {
  list: (regionCode: string, activeOnly = true) =>
    invoke<SubscribedProvider[]>("list_subscribed_providers", { regionCode, activeOnly }),
  replace: (regionCode: string, providers: SubscribedProvider[]) =>
    invoke<SubscribedProvider[]>("set_subscribed_providers", { regionCode, providers }),
  setActive: (providerId: number, regionCode: string, isActive: boolean) =>
    invoke<boolean>("set_provider_active", { providerId, regionCode, isActive }),
};

export const catalog = {
  cache: (entries: MediaCatalogEntry[]) => invoke<number>("cache_media_metadata", { entries }),
  get: (tmdbId: number, mediaType: MediaType) =>
    invoke<MediaCatalogEntry | null>("get_cached_media", { tmdbId, mediaType }),
};

export const deepLinks = {
  resolve: (request: ResolveRequest) => invoke<ResolveResponse>("resolve_deep_links", { request }),
  cached: (tmdbId: number, mediaType: MediaType, regionCode: string) =>
    invoke<ResolvedLink[]>("get_cached_deep_links", { tmdbId, mediaType, regionCode }),
};

export const history = {
  recordProgress: (update: ProgressUpdate) => invoke<WatchHistoryEntry>("record_watch_progress", { update }),
  markCompleted: (appProfileId: number, tmdbId: number, mediaType: MediaType, seasonNumber = 0, episodeNumber = 0) =>
    invoke<boolean>("mark_title_completed", { appProfileId, tmdbId, mediaType, seasonNumber, episodeNumber }),
  continueWatching: (appProfileId: number, limit = 20) =>
    invoke<ContinueWatchingItem[]>("get_continue_watching", { appProfileId, limit }),
  list: (appProfileId: number, limit = 100, offset = 0) =>
    invoke<WatchHistoryEntry[]>("get_watch_history", { appProfileId, limit, offset }),
  titleProgress: (appProfileId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<WatchHistoryEntry[]>("get_title_progress", { appProfileId, tmdbId, mediaType }),
  remove: (appProfileId: number, id: number) => invoke<boolean>("delete_watch_history_entry", { appProfileId, id }),
  importRows: (rows: HistoryImport[]) => invoke<number>("import_watch_history", { rows }),
  exportAll: (appProfileId: number) => invoke<WatchHistoryEntry[]>("export_watch_history", { appProfileId }),
};

export const playbackEvents = {
  log: (appProfileId: number, tmdbId: number, mediaType: MediaType, eventType: string, sessionWatchDurationSec = 0) =>
    invoke<number>("log_playback_event", { appProfileId, tmdbId, mediaType, eventType, sessionWatchDurationSec }),
  list: (appProfileId: number, since: string | null = null, limit = 500) =>
    invoke<PlaybackEvent[]>("list_playback_events", { appProfileId, since, limit }),
};

export const hubs = {
  list: (categoryType: string | null = null) => invoke<CustomHub[]>("list_custom_hubs", { categoryType }),
  upsert: (items: CustomHub[]) => invoke<number>("upsert_custom_hubs", { hubs: items }),
  remove: (hubSlug: string) => invoke<boolean>("delete_custom_hub", { hubSlug }),
};

export const watchlist = {
  add: (appProfileId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<void>("add_to_watchlist", { appProfileId, tmdbId, mediaType }),
  remove: (appProfileId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<boolean>("remove_from_watchlist", { appProfileId, tmdbId, mediaType }),
  list: (appProfileId: number) => invoke<WatchlistItem[]>("get_watchlist", { appProfileId }),
  contains: (appProfileId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<boolean>("is_in_watchlist", { appProfileId, tmdbId, mediaType }),
};

export const player = {
  open: (request: OpenPlayerRequest) => invoke<PlayerOpened>("open_player", { request }),
  /** Profile handshake: opens the provider's sign-in / "Who's watching?" page. */
  connect: (appProfileId: number, providerId: number, providerName: string, region?: string) =>
    invoke<PlayerOpened>("open_player", {
      request: { appProfileId, providerId, providerName, mode: "connect", region } satisfies OpenPlayerRequest,
    }),
  close: () => invoke<void>("close_player"),
  status: () => invoke<PlayerStatus | null>("get_player_status"),
  rebind: (request: RebindRequest) => invoke<PlayerStatus>("player_rebind_title", { request }),
};

export const importer = {
  /** Imports history for the OTT account linked (via ott_profile_mappings) to this profile. */
  fromProvider: (appProfileId: number, providerId: number, providerName: string) =>
    invoke<ImportReport>("import_ott_history", { appProfileId, providerId, providerName }),
  /** Netflix viewing-activity CSV or an Omnia JSON export. */
  fromFile: (appProfileId: number, fileName: string, contents: string, providerName: string | null = null) =>
    invoke<ImportReport>("import_history_file", { appProfileId, providerName, fileName, contents }),
};

type Payload<T> = (payload: T) => void;
const on =
  <T>(name: string) =>
  (handler: Payload<T>): Promise<UnlistenFn> =>
    listen<T>(name, (e) => handler(e.payload));

export const events = {
  onBackToHub: on<{ tmdbId: number | null; mediaType: MediaType | null }>(OmniaEvents.backToHub),
  onPlayerOpened: on<PlayerOpened>(OmniaEvents.playerOpened),
  onPlayerClosed: on<{ reason: string; status: PlayerStatus }>(OmniaEvents.playerClosed),
  onPlaybackProgress: on<PlaybackProgressEvent>(OmniaEvents.playbackProgress),
  onPlayerTitleChanged: on<TitleChangedEvent>(OmniaEvents.playerTitleChanged),
  onOttProfileMismatch: on<{
    appProfileId: number;
    providerId: number;
    providerName: string;
    expectedOttProfileId: string | null;
    observedOttProfileName: string | null;
  }>(OmniaEvents.ottProfileMismatch),
  onOttProfileRerouted: on<{ fromAppProfileId: number; toAppProfileId: number; providerName: string }>(
    OmniaEvents.ottProfileRerouted,
  ),
  onOttProfileConnected: on<OttProfileConnectedEvent>(OmniaEvents.ottProfileConnected),
  onHistoryImportProgress: on<ImportProgressEvent>(OmniaEvents.historyImportProgress),
  onHistoryImportFinished: on<ImportFinishedEvent>(OmniaEvents.historyImportFinished),
};

// ---------------------------------------------------------------------------------------------
// Recommendations (mirror src-tauri/src/ml/recommender.rs)
// ---------------------------------------------------------------------------------------------

export interface RecommendedItem {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseYear: number | null;
  voteAverage: number | null;
  score: number;
  matchPercent: number;
  /** Closest liked title, for "Because you liked …" micro-copy. */
  becauseOf: string | null;
}

export interface RecommendationRow {
  id: string;
  kind: "taste" | "context" | "binge" | "because" | "comfort" | "popular";
  title: string;
  subtitle: string | null;
  items: RecommendedItem[];
}

export interface RecommendationsResponse {
  appProfileId: number;
  modelId: string;
  contextBucket: TimeOfDayBucket;
  coldStart: boolean;
  generatedAt: string;
  rows: RecommendationRow[];
}

export interface Affinity {
  weight: number;
  completion: number;
  partial: number;
  comfort: number;
  watchlist: number;
  engagement: number;
  bingeMultiplier: number;
  abandonment: number;
  skimming: number;
  recency: number;
}

export interface TasteSummary {
  appProfileId: number;
  titles: {
    tmdbId: number;
    mediaType: MediaType;
    title: string | null;
    affinity: Affinity;
    dominantBucket: TimeOfDayBucket | null;
  }[];
  bucketWeights: [TimeOfDayBucket, number][];
}

export interface EmbeddingStatus {
  ready: boolean;
  modelId: string | null;
  backend: "onnx" | "hashed" | null;
  modelDir: string;
}

export const recommendations = {
  /** Cached for 30 min per profile; new telemetry/imports invalidate it automatically. */
  get: (appProfileId: number, forceRefresh = false) =>
    invoke<RecommendationsResponse>("get_recommendations", { appProfileId, forceRefresh }),
  tasteSummary: (appProfileId: number, limit = 50) =>
    invoke<TasteSummary>("get_taste_summary", { appProfileId, limit }),
  embeddingStatus: () => invoke<EmbeddingStatus>("get_embedding_status"),
};
