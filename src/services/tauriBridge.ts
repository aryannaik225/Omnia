/**
 * Typed wrappers for every Rust `#[tauri::command]` in `src-tauri/src/lib.rs`.
 * Argument keys are camelCase (Tauri maps them to the Rust snake_case parameters).
 * All data stays on-device: on the desktop these calls only cross the in-process IPC boundary;
 * on a paired phone / TV they go to the desktop over the local network (see `platform.ts`).
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { handOffPlayback } from "./handoff";
import { invoke, isRemote, platformMode } from "./platform";

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

/** A history row with its parent title's name and artwork (joined from media_catalog). */
export interface HistoryWithMedia extends WatchHistoryEntry {
  title: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseYear: number | null;
}

export interface ContinueWatchingItem extends WatchHistoryEntry {
  title: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseYear: number | null;
  runtimeMins: number | null;
  /** The latest episode was finished: offer the next one. */
  upNext: boolean;
  /** Recorded with "Mark as Watched". */
  isManual: boolean;
  /** A caught-up airing series has a new episode out. */
  newEpisode: { seasonNumber: number; episodeNumber: number; airDate: string } | null;
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
  ottProfileConnected: "omnia://ott-profile-connected",
  historyImportProgress: "omnia://history-import-progress",
  historyImportFinished: "omnia://history-import-finished",
  backgroundSync: "omnia://background-sync",
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
  switchingProfile: boolean;
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
  tracking: "recording" | "mismatch" | "unlinked" | "unverified" | "pending";
}

export interface DetectedMedia {
  title: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  ottTitleId: string | null;
  /** From the provider's own metadata when known. */
  mediaType?: MediaType | null;
  releaseYear?: number | null;
  confidence: "high" | "low";
}

export interface IdentifiedTitle {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  originalTitle: string | null;
  releaseYear: number | null;
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
  /** True for the Connect-accounts handshake (history import follows); false for in-player linking. */
  importing: boolean;
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
/** A backend is reachable: the desktop app itself, or a paired phone / TV (see `platform.ts`). */
export const isTauri = (): boolean => platformMode !== "desktop" || (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);

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

/** The OTT a profile chose for a title; `providerId` is canonical (covers ad / store variants). */
export interface PreferredProvider {
  appProfileId: number;
  tmdbId: number;
  mediaType: MediaType;
  providerId: number;
  providerName: string;
  updatedAt: string;
}

export const preferredProviders = {
  get: (appProfileId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<PreferredProvider | null>("get_preferred_provider", { appProfileId, tmdbId, mediaType }),
  set: (appProfileId: number, tmdbId: number, mediaType: MediaType, providerId: number, providerName: string) =>
    invoke<PreferredProvider>("set_preferred_provider", { appProfileId, tmdbId, mediaType, providerId, providerName }),
  clear: (appProfileId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<boolean>("clear_preferred_provider", { appProfileId, tmdbId, mediaType }),
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

/** One "Recently watched" card: the title's latest row plus how many rows it has. */
export interface HistoryTitle extends HistoryWithMedia {
  entryCount: number;
}

export interface ProviderHistoryCount {
  providerId: number;
  rows: number;
}

export interface ClearedHistory {
  historyRows: number;
  playbackEvents: number;
}

export const history = {
  recordProgress: (update: ProgressUpdate) => invoke<WatchHistoryEntry>("record_watch_progress", { update }),
  markCompleted: (appProfileId: number, tmdbId: number, mediaType: MediaType, seasonNumber = 0, episodeNumber = 0) =>
    invoke<boolean>("mark_title_completed", { appProfileId, tmdbId, mediaType, seasonNumber, episodeNumber }),
  continueWatching: (appProfileId: number, limit = 20) =>
    invoke<ContinueWatchingItem[]>("get_continue_watching", { appProfileId, limit }),
  list: (appProfileId: number, limit = 100, offset = 0) =>
    invoke<HistoryWithMedia[]>("get_watch_history", { appProfileId, limit, offset }),
  titleProgress: (appProfileId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<WatchHistoryEntry[]>("get_title_progress", { appProfileId, tmdbId, mediaType }),
  remove: (appProfileId: number, id: number) => invoke<boolean>("delete_watch_history_entry", { appProfileId, id }),
  /** One row per title (newest first), paged by title, so lifetime imports show every show. */
  /** `providerId`: one provider family, `0` = Offline / Manual, `null` = everything. */
  titles: (appProfileId: number, limit = 60, offset = 0, providerId: number | null = null) =>
    invoke<HistoryTitle[]>("get_history_titles", { appProfileId, limit, offset, providerId }),
  removeTitle: (appProfileId: number, tmdbId: number, mediaType: MediaType) => invoke<number>("delete_title_history", { appProfileId, tmdbId, mediaType }),
  /** "Mark as Watched" (cinema, local file, another device): history + Continue Watching. */
  markWatched: (appProfileId: number, tmdbId: number, mediaType: MediaType, opts: { seasonNumber?: number; episodeNumber?: number; episodeTitle?: string | null; durationSeconds?: number | null } = {}) =>
    invoke<WatchHistoryEntry>("mark_watched", {
      appProfileId,
      tmdbId,
      mediaType,
      seasonNumber: opts.seasonNumber ?? null,
      episodeNumber: opts.episodeNumber ?? null,
      episodeTitle: opts.episodeTitle ?? null,
      durationSeconds: opts.durationSeconds ?? null,
    }),
  /** "Mark season as watched": all listed episodes in one transaction (stamped in episode order). */
  markEpisodesWatched: (
    appProfileId: number,
    tmdbId: number,
    episodes: { seasonNumber: number; episodeNumber: number; episodeTitle?: string | null; durationSeconds?: number | null }[],
  ) => invoke<number>("mark_episodes_watched", { appProfileId, tmdbId, episodes }),
  unmarkWatched: (appProfileId: number, tmdbId: number, mediaType: MediaType, seasonNumber = 0, episodeNumber = 0) =>
    invoke<boolean>("unmark_watched", { appProfileId, tmdbId, mediaType, seasonNumber, episodeNumber }),
  /** Caught-up airing series with a new episode come back to Continue Watching. */
  checkAiringShows: (appProfileId: number) => invoke<number>("check_airing_shows", { appProfileId }),
  /** History rows per provider family (canonical id; 0 = Offline / Manual). */
  providerCounts: (appProfileId: number) => invoke<ProviderHistoryCount[]>("get_history_provider_counts", { appProfileId }),
  /** Deletes only this profile's rows recorded on one provider family. */
  clearProvider: (appProfileId: number, providerId: number) => invoke<number>("clear_provider_history", { appProfileId, providerId }),
  /** "Clear Watch History": wipes this profile's history + playback events (other profiles untouched). */
  clearAll: (appProfileId: number) => invoke<ClearedHistory>("clear_watch_history", { appProfileId }),
  /** "Remove from Continue Watching": hidden until watched again; history is kept. */
  hideFromContinueWatching: (appProfileId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<void>("hide_from_continue_watching", { appProfileId, tmdbId, mediaType }),
  unhideFromContinueWatching: (appProfileId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<boolean>("unhide_from_continue_watching", { appProfileId, tmdbId, mediaType }),
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

/** "Paste an image URL" avatar: Rust downloads it once and returns a data URL. */
export const fetchAvatarImage = (url: string) => invoke<string>("fetch_avatar_image", { url });

export const favorites = {
  set: (appProfileId: number, tmdbId: number, mediaType: MediaType, favorite: boolean) =>
    invoke<boolean>("set_favorite", { appProfileId, tmdbId, mediaType, favorite }),
  contains: (appProfileId: number, tmdbId: number, mediaType: MediaType) => invoke<boolean>("is_favorite", { appProfileId, tmdbId, mediaType }),
  list: (appProfileId: number) => invoke<WatchlistItem[]>("get_favorites", { appProfileId }),
};

export interface Collection {
  collectionId: number;
  appProfileId: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  coverPosters: string[];
}

export const collections = {
  list: (appProfileId: number) => invoke<Collection[]>("get_collections", { appProfileId }),
  create: (appProfileId: number, name: string) => invoke<Collection>("create_collection", { appProfileId, name }),
  rename: (appProfileId: number, collectionId: number, name: string) => invoke<void>("rename_collection", { appProfileId, collectionId, name }),
  remove: (appProfileId: number, collectionId: number) => invoke<boolean>("delete_collection", { appProfileId, collectionId }),
  addItem: (appProfileId: number, collectionId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<boolean>("add_to_collection", { appProfileId, collectionId, tmdbId, mediaType }),
  removeItem: (appProfileId: number, collectionId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<boolean>("remove_from_collection", { appProfileId, collectionId, tmdbId, mediaType }),
  items: (appProfileId: number, collectionId: number) => invoke<WatchlistItem[]>("get_collection_items", { appProfileId, collectionId }),
  containing: (appProfileId: number, tmdbId: number, mediaType: MediaType) => invoke<number[]>("get_title_collections", { appProfileId, tmdbId, mediaType }),
};

export const player = {
  /** Desktop: Omnia's player window. Phone / TV: hands the title to the installed OTT app. */
  open: (request: OpenPlayerRequest) =>
    isRemote ? (handOffPlayback(request) as Promise<unknown> as Promise<PlayerOpened>) : invoke<PlayerOpened>("open_player", { request }),
  /** Profile handshake: opens the provider's sign-in / "Who's watching?" page. */
  connect: (appProfileId: number, providerId: number, providerName: string, region?: string) =>
    invoke<PlayerOpened>("open_player", {
      request: { appProfileId, providerId, providerName, mode: "connect", region } satisfies OpenPlayerRequest,
    }),
  close: () => invoke<void>("close_player"),
  status: () => invoke<PlayerStatus | null>("get_player_status"),
  rebind: (request: RebindRequest) => invoke<PlayerStatus>("player_rebind_title", { request }),
  /** Strict TMDB identification in Rust: /search/tv or /search/movie only, with the release year. */
  identify: (title: string, mediaType: MediaType, releaseYear: number | null = null) =>
    invoke<IdentifiedTitle | null>("identify_title", { title, mediaType, releaseYear }),
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
    // Phones / TVs get no desktop events: their views refresh when they are opened.
    isRemote ? Promise.resolve(() => {}) : listen<T>(name, (e) => handler(e.payload));

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
    reason: "mismatch" | "unlinked";
    observedOttProfileName: string | null;
  }>(OmniaEvents.ottProfileMismatch),
  onOttProfileConnected: on<OttProfileConnectedEvent>(OmniaEvents.ottProfileConnected),
  onHistoryImportProgress: on<ImportProgressEvent>(OmniaEvents.historyImportProgress),
  onHistoryImportFinished: on<ImportFinishedEvent>(OmniaEvents.historyImportFinished),
  /** A quiet background delta sync stored new activity (e.g. watched on another device). */
  onBackgroundSync: on<{ appProfileId: number; providerName: string; updated: number }>(OmniaEvents.backgroundSync),
  /** A key from the phone remote aimed at this PC (the open player handles its own keys). */
  onRemoteKey: on<{ key: string }>("omnia://remote-key"),
};

/** Background delta sync status of one linked account (mirrors `queries::OttSyncState`). */
export interface OttSyncState {
  appProfileId: number;
  providerId: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastNewRows: number;
}

export const syncStatus = {
  list: (appProfileId: number) => invoke<OttSyncState[]>("get_sync_states", { appProfileId }),
  /** Delta-sync every linked account of the profile now. `null` when a sync is already running. */
  syncNow: (appProfileId: number) => invoke<number | null>("sync_accounts_now", { appProfileId }),
};

/** `app_settings` key: background sync on startup / tray wake ("false" turns it off). */
export const BACKGROUND_SYNC_SETTING = "background_sync";

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
  /** "More Like This": local nearest neighbours of one title by composite vibe vector. */
  similar: (appProfileId: number, tmdbId: number, mediaType: MediaType) =>
    invoke<SimilarTitles>("get_similar_titles", { appProfileId, tmdbId, mediaType }),
};

export interface SimilarTitles {
  tmdbId: number;
  mediaType: MediaType;
  modelId: string;
  /** How many titles the local search compared against. */
  searched: number;
  items: RecommendedItem[];
}

// ---------------------------------------------------------------------------------------------
// LAN companion server (desktop Settings → Linked Devices; never callable from a LAN device)
// ---------------------------------------------------------------------------------------------

export interface LanDevice {
  deviceId: number;
  deviceName: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

export interface LanStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  address: string | null;
  /** `http://<address>:8765/pair?pin=<pin>`, the QR code's content. */
  pairUrl: string | null;
  pin: string | null;
  pinExpiresInSecs: number | null;
  devices: LanDevice[];
  error: string | null;
}

export const LAN_CHANGED_EVENT = "omnia://lan-changed";

export const lan = {
  status: () => invoke<LanStatus>("lan_status"),
  setEnabled: (enabled: boolean) => invoke<LanStatus>("lan_set_enabled", { enabled }),
  newPin: () => invoke<LanStatus>("lan_new_pin"),
  revoke: (deviceId: number) => invoke<LanStatus>("lan_revoke_device", { deviceId }),
  /** A device paired (refresh the list). */
  onChanged: on<null>(LAN_CHANGED_EVENT),
};
