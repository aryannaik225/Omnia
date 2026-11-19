import "server-only";

/**
 * Server-side TMDB lookups for the tracker's title summaries (/app/api/titles). The catalog UI
 * itself runs the desktop's TMDB client in the browser through /app/api/tmdb.
 * The API key never reaches the browser; responses cache for an hour.
 */
const BASE = "https://api.themoviedb.org/3";

import type { MediaType } from "@/lib/media";

export type { MediaType };

export interface Title {
  id: number;
  mediaType: MediaType;
  title: string;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  year: number | null;
  voteAverage: number | null;
}

type Raw = {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
};

const toTitle = (r: Raw, fallback?: MediaType): Title | null => {
  const mediaType = (r.media_type ?? fallback) as MediaType | undefined;
  if (mediaType !== "movie" && mediaType !== "tv") return null;
  const date = r.release_date || r.first_air_date || "";
  return {
    id: r.id,
    mediaType,
    title: r.title ?? r.name ?? "Untitled",
    overview: r.overview ?? "",
    posterPath: r.poster_path ?? null,
    backdropPath: r.backdrop_path ?? null,
    year: date ? Number(date.slice(0, 4)) || null : null,
    voteAverage: r.vote_average ?? null,
  };
};

export const tmdbConfigured = () => Boolean(process.env.TMDB_API_KEY);

async function get<T>(path: string, params: Record<string, string> = {}, revalidate = 3600): Promise<T> {
  const key = process.env.TMDB_API_KEY ?? "";
  if (!key) throw new Error("TMDB_API_KEY is not set");
  const url = new URL(BASE + path);
  const bearer = key.length > 60; // v4 read token
  if (!bearer) url.searchParams.set("api_key", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: bearer ? { Authorization: `Bearer ${key}` } : undefined,
    next: { revalidate },
  });
  if (!res.ok) throw new Error(`TMDB ${path} failed (${res.status})`);
  return res.json() as Promise<T>;
}

export interface NextEpisode {
  season: number;
  episode: number;
  name: string;
  airDate: string | null;
}

type RawEpisodeRef = { season_number: number; episode_number: number; name: string; air_date: string | null; runtime?: number | null } | null;
type RawDetails = Raw & {
  runtime?: number;
  episode_run_time?: number[];
  status?: string;
  seasons?: { season_number: number; episode_count: number }[];
  next_episode_to_air?: RawEpisodeRef;
  last_episode_to_air?: RawEpisodeRef;
  release_dates?: { results?: { iso_3166_1: string; release_dates: { type: number; release_date: string; note?: string }[] }[] };
};

/** Streaming platforms TMDB names in a digital release's note ("Netflix"). */
const PLATFORM = /netflix|prime video|amazon|apple tv|disney|hulu|hbo|max|peacock|paramount|hotstar|jiocinema|zee5|sony ?liv|mubi|youtube|crunchyroll|shudder|starz|britbox|now tv|sky|canal|stan|crave|viaplay|tubi|iqiyi|viu|tving|u-next|mgm\+|discovery\+/i;

/**
 * A movie's next release in the region, or null once it has come out there. TMDB types:
 * 1 premiere, 2 limited theatrical, 3 theatrical, 4 digital, 5 physical, 6 TV. Without regional
 * data, worldwide dates are used and only a wide (3) release counts as "in cinemas" (a
 * streaming film's limited qualifying run abroad doesn't). Mirrors omnia/lib/releaseStatus.ts.
 */
function regionalRelease(raw: RawDetails, region: string): { date: string; label: string } | null {
  const all = (raw.release_dates?.results ?? []).flatMap((r) =>
    r.release_dates
      .filter((d) => d.release_date?.length >= 10)
      .map((d) => ({ region: r.iso_3166_1, type: d.type, date: d.release_date.slice(0, 10), note: (d.note ?? "").trim() })),
  );
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
  const today = new Date().toISOString().slice(0, 10);
  if (list.some((d) => d.type !== 1 && d.date <= today && (d.type !== 2 || cinemaTypes.has(2)))) return null;
  const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
  const cinema = list.filter((d) => cinemaTypes.has(d.type) && d.date > today).sort(byDate)[0];
  const home = list.filter((d) => [4, 5, 6].includes(d.type) && d.date > today).sort(byDate)[0];
  const platform = (() => {
    const counts = new Map<string, number>();
    for (const d of all) if (d.type === 4 && d.note && d.note.length <= 40 && PLATFORM.test(d.note)) counts.set(d.note, (counts.get(d.note) ?? 0) + 1);
    const own = home?.note && PLATFORM.test(home.note) ? home.note : null;
    return own ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  })();
  const streamingFirst = home?.type === 4 && (!cinema || (cinema.type === 2 && Math.abs(Date.parse(cinema.date) - Date.parse(home.date)) <= 30 * 86_400_000));
  if (home && (streamingFirst || !cinema)) return { date: home.date, label: home.type === 4 ? (platform ? `On ${platform}` : "Streaming release") : home.type === 6 ? "TV premiere" : "Digital release" };
  return cinema ? { date: cinema.date, label: "In cinemas" } : null;
}

const toEpisodeRef = (e: RawEpisodeRef): NextEpisode | null =>
  e ? { season: e.season_number, episode: e.episode_number, name: e.name, airDate: e.air_date || null } : null;

// ---------------------------------------------------------------------------------------------
// Library summaries (Up Next, Upcoming, Library grid)
// ---------------------------------------------------------------------------------------------

export interface TitleSummary extends Title {
  runtime: number | null;
  status: string | null;
  releaseDate: string | null;
  /** TV: aired episode count per regular season (season 0 / specials excluded). */
  seasonEpisodeCounts: { season: number; count: number }[];
  nextEpisode: NextEpisode | null;
  lastEpisode: NextEpisode | null;
  /** Movies: the next release in the requested region, while it hasn't come out there yet. */
  upcomingRelease: { date: string; label: string } | null;
}

export async function summary(mediaType: MediaType, id: number, region = "US"): Promise<TitleSummary | null> {
  let raw: RawDetails;
  try {
    raw = await get<RawDetails>(`/${mediaType}/${id}`, mediaType === "movie" ? { append_to_response: "release_dates" } : {});
  } catch {
    return null;
  }
  const base = toTitle(raw, mediaType);
  if (!base) return null;
  return {
    ...base,
    // Series: TMDB's typical episode length, else the latest episode's own runtime.
    runtime: raw.runtime || raw.episode_run_time?.[0] || raw.last_episode_to_air?.runtime || raw.next_episode_to_air?.runtime || null,
    status: raw.status ?? null,
    releaseDate: raw.release_date || raw.first_air_date || null,
    seasonEpisodeCounts: (raw.seasons ?? []).filter((s) => s.season_number > 0 && s.episode_count > 0).map((s) => ({ season: s.season_number, count: s.episode_count })),
    nextEpisode: toEpisodeRef(raw.next_episode_to_air ?? null),
    lastEpisode: toEpisodeRef(raw.last_episode_to_air ?? null),
    upcomingRelease: mediaType === "movie" ? regionalRelease(raw, region) : null,
  };
}
