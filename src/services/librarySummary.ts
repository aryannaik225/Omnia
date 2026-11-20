/**
 * Title summaries for My Library (season sizes, latest / next episode, runtime, a movie's next
 * regional release). Same shape and rules as the web app's server-side `summary()`
 * (web-export/lib/tmdb.ts), fetched through the Rust TMDB proxy.
 *
 * A library imported from Netflix / Prime can hold hundreds of titles, so summaries are also
 * kept in localStorage for 12 hours (public TMDB metadata only, never anything about the user).
 */
import { tmdbRequest } from "./tmdbClient";
import type { MediaType } from "./tauriBridge";
import { platformFromNote, todayIso } from "../lib/releaseStatus";

export interface EpisodeRef {
  season: number;
  episode: number;
  name: string;
  airDate: string | null;
}

export interface TitleSummary {
  id: number;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  year: number | null;
  voteAverage: number | null;
  /** Minutes: a movie's runtime, a series' typical episode length. */
  runtime: number | null;
  status: string | null;
  releaseDate: string | null;
  seasonEpisodeCounts: { season: number; count: number }[];
  nextEpisode: EpisodeRef | null;
  lastEpisode: EpisodeRef | null;
  /** Movies: the next release in the region, while it hasn't come out there yet. */
  upcomingRelease: { date: string; label: string } | null;
}

type RawRef = { season_number: number; episode_number: number; name: string; air_date: string | null; runtime?: number | null } | null;

const toRef = (e: RawRef | undefined): EpisodeRef | null =>
  e ? { season: e.season_number, episode: e.episode_number, name: e.name ?? "", airDate: e.air_date || null } : null;

/** Mirrors web-export/lib/tmdb.ts → regionalRelease (and lib/releaseStatus.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function regionalRelease(raw: any, region: string): { date: string; label: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = (raw.release_dates?.results ?? []).flatMap((r: any) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r.release_dates ?? []).filter((d: any) => d.release_date?.length >= 10).map((d: any) => ({ region: r.iso_3166_1 as string, type: Number(d.type), date: String(d.release_date).slice(0, 10), note: String(d.note ?? "").trim() })),
  ) as { region: string; type: number; date: string; note: string }[];
  const local = all.filter((d) => d.region === region);
  const regional = local.length > 0;
  const cinemaTypes = new Set(regional ? [2, 3] : [3]);
  let list = local;
  if (!regional) {
    const byType = new Map<number, (typeof all)[number]>();
    for (const d of all) if (!byType.has(d.type) || d.date < byType.get(d.type)!.date) byType.set(d.type, d);
    list = [...byType.values()];
  }
  if (!list.length) return null;
  const today = todayIso();
  if (list.some((d) => d.type !== 1 && d.date <= today && (d.type !== 2 || cinemaTypes.has(2)))) return null;
  const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
  const cinema = list.filter((d) => cinemaTypes.has(d.type) && d.date > today).sort(byDate)[0];
  const home = list.filter((d) => [4, 5, 6].includes(d.type) && d.date > today).sort(byDate)[0];
  const platform = (() => {
    const own = platformFromNote(home?.note);
    if (own) return own;
    const counts = new Map<string, number>();
    for (const d of all) {
      const p = d.type === 4 ? platformFromNote(d.note) : null;
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  })();
  const streamingFirst = home?.type === 4 && (!cinema || (cinema.type === 2 && Math.abs(Date.parse(cinema.date) - Date.parse(home.date)) <= 30 * 86_400_000));
  if (home && (streamingFirst || !cinema)) return { date: home.date, label: home.type === 4 ? (platform ? `On ${platform}` : "Streaming release") : home.type === 6 ? "TV premiere" : "Digital release" };
  return cinema ? { date: cinema.date, label: "In cinemas" } : null;
}

async function fetchSummary(mediaType: MediaType, id: number, region: string): Promise<TitleSummary | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  try {
    raw = await tmdbRequest(`/${mediaType}/${id}`, mediaType === "movie" ? { append_to_response: "release_dates" } : {}, 60 * 60_000);
  } catch {
    return null;
  }
  const date: string = raw.release_date || raw.first_air_date || "";
  return {
    id,
    mediaType,
    title: raw.title ?? raw.name ?? "Untitled",
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    year: date ? Number(date.slice(0, 4)) || null : null,
    voteAverage: raw.vote_average ?? null,
    runtime: raw.runtime || raw.episode_run_time?.[0] || raw.last_episode_to_air?.runtime || raw.next_episode_to_air?.runtime || null,
    status: raw.status ?? null,
    releaseDate: date || null,
    seasonEpisodeCounts: (raw.seasons ?? [])
      .filter((s: { season_number: number; episode_count: number }) => s.season_number > 0 && s.episode_count > 0)
      .map((s: { season_number: number; episode_count: number }) => ({ season: s.season_number, count: s.episode_count })),
    nextEpisode: toRef(raw.next_episode_to_air),
    lastEpisode: toRef(raw.last_episode_to_air),
    upcomingRelease: mediaType === "movie" ? regionalRelease(raw, region) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Cache: memory + localStorage (12 h; airing shows change daily)
// ---------------------------------------------------------------------------------------------

const STORE_KEY = "omnia.librarySummaries.v1";
const TTL = 12 * 60 * 60_000;
const MAX_ENTRIES = 3000;
type Entry = { at: number; v: TitleSummary | null };
let memo: Map<string, Entry> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function cache(): Map<string, Entry> {
  if (memo) return memo;
  memo = new Map();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) for (const [k, e] of Object.entries(JSON.parse(raw) as Record<string, Entry>)) if (Date.now() - e.at < TTL) memo.set(k, e);
  } catch {
    // Storage unavailable / corrupt: start empty.
  }
  return memo;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const entries = [...cache().entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
      localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // Quota / private mode: the in-memory cache still works.
    }
  }, 800);
}

const cacheKey = (region: string, key: string) => `${region}|${key}`;

export function cachedSummary(region: string, key: string): TitleSummary | null | undefined {
  const e = cache().get(cacheKey(region, key));
  return e && Date.now() - e.at < TTL ? e.v : undefined;
}

/** Fetches what's missing (6 at a time); `onProgress` fires as batches land. */
export async function loadSummaries(keys: string[], region: string, onProgress?: () => void): Promise<void> {
  const missing = [...new Set(keys)].filter((k) => cachedSummary(region, k) === undefined);
  let next = 0;
  let landed = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, missing.length) }, async () => {
      while (next < missing.length) {
        const key = missing[next++]!;
        const [type, id] = key.split(":");
        const v = await fetchSummary(type as MediaType, Number(id), region);
        // A failed request isn't cached as "missing" for long: retry on the next visit.
        cache().set(cacheKey(region, key), { at: v ? Date.now() : Date.now() - TTL + 5 * 60_000, v });
        if (++landed % 12 === 0) onProgress?.();
      }
    }),
  );
  persist();
  onProgress?.();
}
