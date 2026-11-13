/**
 * TMDB client for the catalog UI: regional discovery, search, details, hubs.
 * Only public catalog metadata is requested; no user data is ever sent.
 * Responses are cached in memory (with in-flight de-duplication) to keep the UI instant.
 */
import type { MediaCatalogEntry, MediaType, TmdbProviderHint } from "./tauriBridge";

const ENV_KEY = (import.meta.env.TMDB_API_KEY || import.meta.env.VITE_TMDB_API_KEY || "").trim();
let credential = ENV_KEY;

export const envTmdbKey = ENV_KEY;
export const setTmdbCredential = (key: string) => {
  credential = key.trim();
  cache.clear();
};
export const hasTmdbCredential = () => credential.length > 0;

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";

export type ImageSize = "w92" | "w154" | "w185" | "w300" | "w342" | "w500" | "w780" | "w1280" | "original" | "h632";
export const img = (path: string | null | undefined, size: ImageSize = "w342") =>
  path ? `${IMG}/${size}${path}` : null;

export class TmdbError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;
const cache = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const DEFAULT_TTL = 10 * 60_000;

async function request<T>(path: string, params: Params = {}, ttl = DEFAULT_TTL): Promise<T> {
  if (!credential) throw new TmdbError("TMDB API key missing. Add TMDB_API_KEY to .env or in Settings.");
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const bearer = credential.startsWith("eyJ");
  if (!bearer) url.searchParams.set("api_key", credential);
  const key = url.toString();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const run = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(key, {
        headers: bearer ? { Authorization: `Bearer ${credential}`, Accept: "application/json" } : { Accept: "application/json" },
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      if (res.status === 401) throw new TmdbError("TMDB rejected the API key.", 401);
      if (!res.ok) throw new TmdbError(`TMDB request failed (${res.status})`, res.status);
      const data = (await res.json()) as T;
      cache.set(key, { at: Date.now(), data });
      if (cache.size > 800) cache.delete(cache.keys().next().value as string);
      return data;
    }
    throw new TmdbError("TMDB rate limit exceeded.", 429);
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

// ---------------------------------------------------------------------------------------------
// Normalised types
// ---------------------------------------------------------------------------------------------

export interface MediaSummary {
  id: number;
  mediaType: MediaType;
  title: string;
  originalTitle: string | null;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  year: number | null;
  /** Full release / first-air date ("YYYY-MM-DD") when TMDB provides one. */
  releaseDate?: string | null;
  voteAverage: number | null;
  genreIds: number[];
  originalLanguage: string | null;
  popularity: number;
}

interface RawListItem {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  genre_ids?: number[];
  original_language?: string;
  popularity?: number;
  adult?: boolean;
}

export interface Paged<T> {
  page: number;
  totalPages: number;
  results: T[];
}

interface RawPaged {
  page: number;
  total_pages: number;
  results: RawListItem[];
}

export function toSummary(r: RawListItem, fallbackType?: MediaType): MediaSummary | null {
  const mediaType = (r.media_type ?? fallbackType) as MediaType | undefined;
  if (mediaType !== "movie" && mediaType !== "tv") return null;
  if (r.adult) return null;
  const date = r.release_date || r.first_air_date || "";
  return {
    id: r.id,
    mediaType,
    title: r.title ?? r.name ?? "Untitled",
    originalTitle: r.original_title ?? r.original_name ?? null,
    overview: r.overview ?? "",
    posterPath: r.poster_path ?? null,
    backdropPath: r.backdrop_path ?? null,
    year: date ? Number(date.slice(0, 4)) || null : null,
    releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    voteAverage: r.vote_average ?? null,
    genreIds: r.genre_ids ?? [],
    originalLanguage: r.original_language ?? null,
    popularity: r.popularity ?? 0,
  };
}

const toPaged = (raw: RawPaged, type?: MediaType): Paged<MediaSummary> => ({
  page: raw.page,
  totalPages: Math.min(raw.total_pages, 500),
  results: raw.results.map((r) => toSummary(r, type)).filter((x): x is MediaSummary => !!x),
});

// ---------------------------------------------------------------------------------------------
// Catalog filters (region, subscriptions, kids safety)
// ---------------------------------------------------------------------------------------------

export interface CatalogContext {
  region: string;
  /** Provider ids to restrict to (empty = all platforms). */
  providers: number[];
  kids: boolean;
}

/** Genres never shown to kids profiles. */
const KIDS_EXCLUDED_GENRES = [27, 53, 80, 10752, 10768];
const KIDS_SAFE_GENRES = new Set([16, 10751, 10762, 35, 12, 14, 10402]);

export function catalogParams(mt: MediaType, ctx: CatalogContext, extra: Params = {}): Params {
  const p: Params = {
    watch_region: ctx.region,
    include_adult: false,
    ...extra,
  };
  // A hub that is itself defined by providers (e.g. "Netflix Exclusives") keeps its own filter.
  if (ctx.providers.length && !extra.with_watch_providers) {
    p.with_watch_providers = ctx.providers.join("|");
    p.with_watch_monetization_types = "flatrate|free|ads";
  }
  if (ctx.kids) {
    if (mt === "movie") {
      p.certification_country = "US";
      p["certification.lte"] = "PG";
    } else {
      p.with_genres = extra.with_genres ? `${extra.with_genres}` : "10762|10751|16";
    }
    p.without_genres = KIDS_EXCLUDED_GENRES.join("|");
  }
  return p;
}

export const isKidsSafe = (m: MediaSummary) =>
  !m.genreIds.some((g) => KIDS_EXCLUDED_GENRES.includes(g)) && m.genreIds.some((g) => KIDS_SAFE_GENRES.has(g));

// ---------------------------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------------------------

export async function trending(type: "all" | MediaType = "all", window: "day" | "week" = "week") {
  return toPaged(await request<RawPaged>(`/trending/${type}/${window}`), type === "all" ? undefined : type);
}

export async function discover(mt: MediaType, ctx: CatalogContext, params: Params = {}, page = 1) {
  const raw = await request<RawPaged>(`/discover/${mt}`, {
    sort_by: "popularity.desc",
    ...catalogParams(mt, ctx, params),
    page,
  });
  return toPaged(raw, mt);
}

export async function searchMulti(query: string, page = 1) {
  const raw = await request<RawPaged>("/search/multi", { query, page, include_adult: false }, 2 * 60_000);
  return toPaged(raw);
}

export async function searchTitle(query: string, mt: MediaType, year?: number | null) {
  const raw = await request<RawPaged>(`/search/${mt}`, {
    query,
    include_adult: false,
    ...(year ? (mt === "movie" ? { year } : { first_air_date_year: year }) : {}),
  });
  return toPaged(raw, mt).results;
}

// --- details ---------------------------------------------------------------------------------

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
}

export interface VideoInfo {
  key: string;
  name: string;
  type: string;
}

export interface ProviderEntry {
  providerId: number;
  providerName: string;
  logoPath: string | null;
  displayPriority: number;
}

export interface RegionProviders {
  link: string | null;
  flatrate: ProviderEntry[];
  free: ProviderEntry[];
  ads: ProviderEntry[];
  rent: ProviderEntry[];
  buy: ProviderEntry[];
}

export interface SeasonSummary {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  posterPath: string | null;
  airDate: string | null;
}

export interface MediaDetails extends MediaSummary {
  tagline: string | null;
  runtimeMins: number | null;
  genres: { id: number; name: string }[];
  keywords: string[];
  cast: CastMember[];
  directors: string[];
  creators: string[];
  studios: string[];
  certification: string | null;
  spokenLanguages: string[];
  videos: VideoInfo[];
  similar: MediaSummary[];
  seasons: SeasonSummary[];
  numberOfSeasons: number | null;
  imdbId: string | null;
  providersByRegion: Record<string, RegionProviders>;
  status: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapProviders(raw: any): Record<string, RegionProviders> {
  const out: Record<string, RegionProviders> = {};
  const list = (arr: any[] | undefined): ProviderEntry[] =>
    (arr ?? []).map((p) => ({
      providerId: p.provider_id,
      providerName: p.provider_name,
      logoPath: p.logo_path ?? null,
      displayPriority: p.display_priority ?? 99,
    }));
  for (const [region, r] of Object.entries<any>(raw?.results ?? {})) {
    out[region] = {
      link: r.link ?? null,
      flatrate: list(r.flatrate),
      free: list(r.free),
      ads: list(r.ads),
      rent: list(r.rent),
      buy: list(r.buy),
    };
  }
  return out;
}

function pickCertification(raw: any, mt: MediaType, region: string): string | null {
  if (mt === "movie") {
    const results: any[] = raw?.release_dates?.results ?? [];
    for (const code of [region, "US"]) {
      const r = results.find((x) => x.iso_3166_1 === code);
      const cert = r?.release_dates?.map((d: any) => d.certification).find((c: string) => c);
      if (cert) return cert;
    }
    return null;
  }
  const results: any[] = raw?.content_ratings?.results ?? [];
  for (const code of [region, "US"]) {
    const r = results.find((x) => x.iso_3166_1 === code);
    if (r?.rating) return r.rating;
  }
  return null;
}

export async function details(mt: MediaType, id: number, region: string): Promise<MediaDetails> {
  const append =
    mt === "movie"
      ? "videos,credits,keywords,similar,release_dates,external_ids,watch/providers"
      : "videos,aggregate_credits,credits,keywords,similar,content_ratings,external_ids,watch/providers";
  const raw = await request<any>(`/${mt}/${id}`, { append_to_response: append });
  const base = toSummary({ ...raw, media_type: mt }, mt)!;
  const castSource: any[] = mt === "tv" ? raw.aggregate_credits?.cast ?? raw.credits?.cast ?? [] : raw.credits?.cast ?? [];
  const cast: CastMember[] = castSource.slice(0, 20).map((c) => ({
    id: c.id,
    name: c.name,
    character: c.character ?? c.roles?.[0]?.character ?? "",
    profilePath: c.profile_path ?? null,
  }));
  const keywords: string[] = (raw.keywords?.keywords ?? raw.keywords?.results ?? []).map((k: any) => k.name);
  const videos: VideoInfo[] = (raw.videos?.results ?? [])
    .filter((v: any) => v.site === "YouTube")
    .sort((a: any, b: any) => Number(b.type === "Trailer") - Number(a.type === "Trailer") || Number(b.official) - Number(a.official))
    .map((v: any) => ({ key: v.key, name: v.name, type: v.type }));
  return {
    ...base,
    genreIds: (raw.genres ?? []).map((g: any) => g.id),
    tagline: raw.tagline || null,
    runtimeMins: mt === "movie" ? raw.runtime || null : raw.episode_run_time?.[0] ?? null,
    genres: raw.genres ?? [],
    keywords,
    cast,
    directors: (raw.credits?.crew ?? []).filter((c: any) => c.job === "Director").map((c: any) => c.name).slice(0, 3),
    creators: (raw.created_by ?? []).map((c: any) => c.name),
    studios: [...(raw.production_companies ?? []), ...(raw.networks ?? [])].map((c: any) => c.name).slice(0, 4),
    certification: pickCertification(raw, mt, region),
    spokenLanguages: (raw.spoken_languages ?? []).map((l: any) => l.english_name || l.name).filter(Boolean),
    videos,
    similar: (raw.similar?.results ?? []).map((r: RawListItem) => toSummary(r, mt)).filter(Boolean) as MediaSummary[],
    seasons: (raw.seasons ?? [])
      .filter((s: any) => s.season_number > 0 || (raw.seasons ?? []).length === 1)
      .map((s: any) => ({
        seasonNumber: s.season_number,
        name: s.name,
        episodeCount: s.episode_count,
        posterPath: s.poster_path ?? null,
        airDate: s.air_date ?? null,
      })),
    numberOfSeasons: raw.number_of_seasons ?? null,
    imdbId: raw.external_ids?.imdb_id ?? raw.imdb_id ?? null,
    providersByRegion: mapProviders(raw["watch/providers"]),
    status: raw.status ?? null,
  };
}

export interface EpisodeInfo {
  episodeNumber: number;
  seasonNumber: number;
  name: string;
  overview: string;
  stillPath: string | null;
  runtimeMins: number | null;
  airDate: string | null;
}

export async function season(tvId: number, seasonNumber: number): Promise<EpisodeInfo[]> {
  const raw = await request<any>(`/tv/${tvId}/season/${seasonNumber}`);
  return (raw.episodes ?? []).map((e: any) => ({
    episodeNumber: e.episode_number,
    seasonNumber: e.season_number,
    name: e.name,
    overview: e.overview ?? "",
    stillPath: e.still_path ?? null,
    runtimeMins: e.runtime ?? null,
    airDate: e.air_date ?? null,
  }));
}

export interface PersonDetails {
  id: number;
  name: string;
  biography: string;
  profilePath: string | null;
  knownFor: string | null;
  credits: MediaSummary[];
}

export async function person(id: number): Promise<PersonDetails> {
  const raw = await request<any>(`/person/${id}`, { append_to_response: "combined_credits" });
  const seen = new Set<string>();
  const credits = [...(raw.combined_credits?.cast ?? []), ...(raw.combined_credits?.crew ?? [])]
    .map((r: RawListItem) => toSummary(r))
    .filter((m): m is MediaSummary => !!m && !!m.posterPath)
    .filter((m) => {
      const k = `${m.mediaType}-${m.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    // Filmography: newest first; undated (announced / in development) titles go last.
    .sort((a, b) => {
      const da = a.releaseDate ?? (a.year ? `${a.year}-00-00` : "");
      const db = b.releaseDate ?? (b.year ? `${b.year}-00-00` : "");
      if (da !== db) return !da ? 1 : !db ? -1 : db.localeCompare(da);
      return b.popularity - a.popularity;
    });
  return {
    id: raw.id,
    name: raw.name,
    biography: raw.biography ?? "",
    profilePath: raw.profile_path ?? null,
    knownFor: raw.known_for_department ?? null,
    credits,
  };
}

export async function collectionParts(id: number): Promise<MediaSummary[]> {
  const raw = await request<any>(`/collection/${id}`, {}, 24 * 3600_000);
  return (raw.parts ?? []).map((r: RawListItem) => toSummary(r, "movie")).filter(Boolean) as MediaSummary[];
}

/** Streaming availability for one title, per region (cached a day; shared with `details`-free rows). */
export async function watchProviders(mt: MediaType, id: number): Promise<Record<string, RegionProviders>> {
  return mapProviders(await request<any>(`/${mt}/${id}/watch/providers`, {}, 24 * 3600_000));
}

export interface CollectionArt {
  name: string;
  posterPath: string | null;
  backdropPath: string | null;
}

export async function collectionArt(id: number): Promise<CollectionArt> {
  const raw = await request<any>(`/collection/${id}`, {}, 7 * 24 * 3600_000);
  return { name: raw.name ?? "", posterPath: raw.poster_path ?? null, backdropPath: raw.backdrop_path ?? null };
}

/** Logo of a TV network (`/network/{id}`) or production company (`/company/{id}`). */
export async function brandLogo(kind: "network" | "company", id: number): Promise<string | null> {
  const raw = await request<any>(`/${kind}/${id}`, {}, 7 * 24 * 3600_000);
  return raw.logo_path ?? null;
}

export async function searchKeywordId(query: string): Promise<number | null> {
  const raw = await request<any>("/search/keyword", { query }, 24 * 3600_000);
  const exact = (raw.results ?? []).find((k: any) => k.name.toLowerCase() === query.toLowerCase());
  return (exact ?? raw.results?.[0])?.id ?? null;
}

export interface WatchProviderOption {
  providerId: number;
  providerName: string;
  logoPath: string | null;
  priority: number;
}

/** Every streaming provider TMDB knows for a region, ordered by local prominence. */
export async function regionProviders(region: string): Promise<WatchProviderOption[]> {
  const [m, t] = await Promise.all([
    request<any>("/watch/providers/movie", { watch_region: region }, 24 * 3600_000),
    request<any>("/watch/providers/tv", { watch_region: region }, 24 * 3600_000),
  ]);
  const map = new Map<number, WatchProviderOption>();
  for (const p of [...(m.results ?? []), ...(t.results ?? [])]) {
    const priority = p.display_priorities?.[region] ?? p.display_priority ?? 999;
    const existing = map.get(p.provider_id);
    if (!existing || priority < existing.priority) {
      map.set(p.provider_id, { providerId: p.provider_id, providerName: p.provider_name, logoPath: p.logo_path ?? null, priority });
    }
  }
  return [...map.values()].sort((a, b) => a.priority - b.priority);
}

export interface RegionOption {
  code: string;
  name: string;
}

export async function availableRegions(): Promise<RegionOption[]> {
  const raw = await request<any>("/watch/providers/regions", {}, 7 * 24 * 3600_000);
  return (raw.results ?? [])
    .map((r: any) => ({ code: r.iso_3166_1, name: r.english_name ?? r.native_name ?? r.iso_3166_1 }))
    .sort((a: RegionOption, b: RegionOption) => a.name.localeCompare(b.name));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------------------------
// Bridges to the Rust side
// ---------------------------------------------------------------------------------------------

/** TMDB providers for a title in a region, as hints for the Rust deep-link resolver. */
export function providerHints(d: MediaDetails, region: string): TmdbProviderHint[] {
  const r = d.providersByRegion[region];
  if (!r) return [];
  const hints: TmdbProviderHint[] = [];
  for (const kind of ["flatrate", "free", "ads", "rent", "buy"] as const) {
    for (const p of r[kind]) hints.push({ providerId: p.providerId, providerName: p.providerName, monetizationType: kind });
  }
  return hints;
}

/** Rich catalog entry (same compact shape the Rust recommender writes). */
export function toCatalogEntry(d: MediaDetails): MediaCatalogEntry {
  return {
    tmdbId: d.id,
    mediaType: d.mediaType,
    title: d.title,
    originalTitle: d.originalTitle,
    overview: d.overview || null,
    posterPath: d.posterPath,
    backdropPath: d.backdropPath,
    releaseYear: d.year,
    runtimeMins: d.runtimeMins,
    genres: d.genres,
    keywords: d.keywords,
    credits: {
      directors: d.directors,
      creators: d.creators,
      cast: d.cast.slice(0, 5).map((c) => c.name),
      studios: d.studios,
    },
    voteAverage: d.voteAverage,
    certification: d.certification,
  };
}

export function summaryToCatalogEntry(m: MediaSummary): MediaCatalogEntry {
  return {
    tmdbId: m.id,
    mediaType: m.mediaType,
    title: m.title,
    originalTitle: m.originalTitle,
    overview: m.overview || null,
    posterPath: m.posterPath,
    backdropPath: m.backdropPath,
    releaseYear: m.year,
    voteAverage: m.voteAverage,
  };
}
