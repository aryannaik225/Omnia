/**
 * The manual tracker's data model, shared by guest mode (localStorage) and the signed-in
 * Supabase backend. Pure functions only; persistence lives in components/tracker/TrackerProvider.
 */
import type { MediaType } from "@/lib/media";

export interface TrackerData {
  /** `${mediaType}:${tmdbId}` → added at (ISO). */
  watchlist: Record<string, string>;
  /** Movie tmdbId → watched at (ISO). */
  movies: Record<string, string>;
  /** Series tmdbId → `${season}:${episode}` → watched at (ISO). */
  episodes: Record<string, Record<string, string>>;
  /**
   * TMDB runtime in minutes of each watched movie (`m:<id>`) and episode (`e:<id>:<s>:<e>`),
   * recorded when it's marked; drives "Total Days Watched".
   */
  runtimes: Record<string, number>;
  /**
   * Titles of episodes stored without a number (`e:<id>:<s>:0`): a watch synced from Omnia Desktop
   * that the streaming service didn't number and TMDB couldn't match by name.
   */
  episodeTitles?: Record<string, string>;
}

export const emptyData = (): TrackerData => ({ watchlist: {}, movies: {}, episodes: {}, runtimes: {}, episodeTitles: {} });

export const movieRuntimeKey = (id: number | string) => `m:${id}`;
export const episodeRuntimeKey = (id: number | string, season: number, episode: number) => `e:${id}:${season}:${episode}`;
/** A usable runtime in minutes, or undefined. */
export const validRuntime = (mins: number | null | undefined) => (typeof mins === "number" && mins > 0 && mins < 1000 ? Math.round(mins) : undefined);

export const itemKey = (mediaType: MediaType, id: number) => `${mediaType}:${id}`;
export const epKey = (season: number, episode: number) => `${season}:${episode}`;

export const parseItemKey = (k: string): { mediaType: MediaType; id: number } | null => {
  const [t, n] = k.split(":");
  const id = Number(n);
  return (t === "movie" || t === "tv") && Number.isInteger(id) && id > 0 ? { mediaType: t, id } : null;
};
export const parseEpKey = (k: string) => {
  const [s, e] = k.split(":").map(Number);
  return { season: s, episode: e };
};

export const isEmpty = (d: TrackerData) =>
  !Object.keys(d.watchlist).length && !Object.keys(d.movies).length && !Object.values(d.episodes).some((m) => Object.keys(m).length);

export const countItems = (d: TrackerData) =>
  Object.keys(d.watchlist).length + Object.keys(d.movies).length + Object.values(d.episodes).reduce((n, m) => n + Object.keys(m).length, 0);

/** Every title the user tracks: watchlist, watched movies, series with at least one watched episode. */
export function trackedItems(d: TrackerData): { mediaType: MediaType; id: number }[] {
  const keys = new Set<string>(Object.keys(d.watchlist));
  for (const id of Object.keys(d.movies)) keys.add(itemKey("movie", Number(id)));
  for (const [id, eps] of Object.entries(d.episodes)) if (Object.keys(eps).length) keys.add(itemKey("tv", Number(id)));
  return [...keys].map(parseItemKey).filter((x): x is { mediaType: MediaType; id: number } => !!x);
}

// ---------------------------------------------------------------------------------------------
// Series progress
// ---------------------------------------------------------------------------------------------

export interface EpisodeRef {
  season: number;
  episode: number;
  name?: string;
  airDate?: string | null;
}
export interface ShowShape {
  seasonEpisodeCounts: { season: number; count: number }[];
  lastEpisode: EpisodeRef | null;
  nextEpisode: EpisodeRef | null;
  status: string | null;
}
export interface ShowProgress {
  airedTotal: number;
  watchedAired: number;
  /** The episode after the latest one watched (or S1 E1), if it has aired. */
  next: { season: number; episode: number } | null;
  started: boolean;
  caughtUp: boolean;
  ended: boolean;
}

/** Aired regular-season episodes, in order (specials excluded, as in TV trackers). */
function airedEpisodes(show: ShowShape): { season: number; episode: number }[] {
  const last = show.lastEpisode;
  if (!last) return [];
  const out: { season: number; episode: number }[] = [];
  for (const { season, count } of [...show.seasonEpisodeCounts].sort((a, b) => a.season - b.season)) {
    if (season > last.season) break;
    const n = season === last.season ? Math.min(count, last.episode) : count;
    for (let e = 1; e <= n; e++) out.push({ season, episode: e });
  }
  return out;
}

export function showProgress(show: ShowShape, watched: Record<string, string> | undefined): ShowProgress {
  const w = watched ?? {};
  const aired = airedEpisodes(show);
  let watchedAired = 0;
  let latest = -1;
  aired.forEach((ep, i) => {
    if (w[epKey(ep.season, ep.episode)]) {
      watchedAired++;
      latest = i;
    }
  });
  const started = Object.keys(w).length > 0;
  let next: { season: number; episode: number } | null = null;
  for (let i = latest + 1; i < aired.length; i++) {
    if (!w[epKey(aired[i].season, aired[i].episode)]) {
      next = aired[i];
      break;
    }
  }
  const ended = show.status === "Ended" || show.status === "Canceled";
  return { airedTotal: aired.length, watchedAired, next, started, caughtUp: started && !next && aired.length > 0, ended };
}

// ---------------------------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------------------------

export interface ExportFile {
  format: "omnia-web-tracker";
  version: 1;
  exportedAt: string;
  watchlist: { mediaType: MediaType; tmdbId: number; addedAt: string }[];
  movies: { tmdbId: number; watchedAt: string; runtime?: number }[];
  episodes: { tmdbId: number; season: number; episode: number; watchedAt: string; runtime?: number }[];
}

export function toExport(d: TrackerData): ExportFile {
  return {
    format: "omnia-web-tracker",
    version: 1,
    exportedAt: new Date().toISOString(),
    watchlist: Object.entries(d.watchlist).flatMap(([k, addedAt]) => {
      const p = parseItemKey(k);
      return p ? [{ mediaType: p.mediaType, tmdbId: p.id, addedAt }] : [];
    }),
    movies: Object.entries(d.movies).map(([id, watchedAt]) => ({ tmdbId: Number(id), watchedAt, runtime: d.runtimes[movieRuntimeKey(id)] })),
    episodes: Object.entries(d.episodes).flatMap(([id, eps]) =>
      Object.entries(eps).map(([k, watchedAt]) => {
        const { season, episode } = parseEpKey(k);
        return { tmdbId: Number(id), season, episode, watchedAt, runtime: d.runtimes[episodeRuntimeKey(id, season, episode)] };
      }),
    ),
  };
}

const okId = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
const okNum = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
const okDate = (s: unknown) => (typeof s === "string" && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : new Date().toISOString());

/**
 * Accepts this app's export, or the desktop app's "Export history" JSON (an array of
 * watch_history rows: completed rows become watched movies / episodes).
 */
export function fromImport(json: unknown): TrackerData {
  const d = emptyData();
  if (Array.isArray(json)) {
    for (const r of json as Record<string, unknown>[]) {
      if (!r || !okId(r.tmdb_id) || !r.is_completed) continue;
      const at = okDate(r.last_watched_at);
      // The desktop records the real duration of what was played.
      const mins = typeof r.duration_seconds === "number" && r.duration_seconds > 60 ? validRuntime(r.duration_seconds / 60) : undefined;
      if (r.media_type === "movie") {
        d.movies[r.tmdb_id] = at;
        if (mins) d.runtimes[movieRuntimeKey(r.tmdb_id)] = mins;
      } else if (r.media_type === "tv" && okNum(r.season_number) && okNum(r.episode_number)) {
        (d.episodes[r.tmdb_id] ??= {})[epKey(r.season_number, r.episode_number)] = at;
        if (mins) d.runtimes[episodeRuntimeKey(r.tmdb_id, r.season_number, r.episode_number)] = mins;
      }
    }
    return d;
  }
  const f = json as Partial<ExportFile> | null;
  if (!f || f.format !== "omnia-web-tracker") throw new Error("This file isn't an Omnia export.");
  for (const w of f.watchlist ?? []) if ((w.mediaType === "movie" || w.mediaType === "tv") && okId(w.tmdbId)) d.watchlist[itemKey(w.mediaType, w.tmdbId)] = okDate(w.addedAt);
  for (const m of f.movies ?? [])
    if (okId(m.tmdbId)) {
      d.movies[m.tmdbId] = okDate(m.watchedAt);
      const mins = validRuntime(m.runtime);
      if (mins) d.runtimes[movieRuntimeKey(m.tmdbId)] = mins;
    }
  for (const e of f.episodes ?? [])
    if (okId(e.tmdbId) && okNum(e.season) && okNum(e.episode)) {
      (d.episodes[e.tmdbId] ??= {})[epKey(e.season, e.episode)] = okDate(e.watchedAt);
      const mins = validRuntime(e.runtime);
      if (mins) d.runtimes[episodeRuntimeKey(e.tmdbId, e.season, e.episode)] = mins;
    }
  return d;
}

/** Union of two libraries (the earlier timestamp wins, so nothing is lost). */
export function merge(a: TrackerData, b: TrackerData): TrackerData {
  const pick = (x?: string, y?: string) => (!x ? y! : !y ? x : x < y ? x : y);
  const out = emptyData();
  for (const k of new Set([...Object.keys(a.watchlist), ...Object.keys(b.watchlist)])) out.watchlist[k] = pick(a.watchlist[k], b.watchlist[k]);
  for (const k of new Set([...Object.keys(a.movies), ...Object.keys(b.movies)])) out.movies[k] = pick(a.movies[k], b.movies[k]);
  for (const id of new Set([...Object.keys(a.episodes), ...Object.keys(b.episodes)])) {
    const ea = a.episodes[id] ?? {};
    const eb = b.episodes[id] ?? {};
    const m: Record<string, string> = {};
    for (const k of new Set([...Object.keys(ea), ...Object.keys(eb)])) m[k] = pick(ea[k], eb[k]);
    out.episodes[id] = m;
  }
  out.runtimes = { ...b.runtimes, ...a.runtimes };
  out.episodeTitles = { ...(b.episodeTitles ?? {}), ...(a.episodeTitles ?? {}) };
  return out;
}
