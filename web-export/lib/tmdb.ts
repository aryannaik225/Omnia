import "server-only";

/** Server-side TMDB client: the API key never reaches the browser. Responses cache for an hour. */
const BASE = "https://api.themoviedb.org/3";

export interface Title {
  id: number;
  mediaType: "movie" | "tv";
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

const toTitle = (r: Raw, fallback?: "movie" | "tv"): Title | null => {
  const mediaType = (r.media_type ?? fallback) as Title["mediaType"] | undefined;
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

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const key = process.env.TMDB_API_KEY ?? "";
  const url = new URL(BASE + path);
  const bearer = key.length > 60; // v4 read token
  if (!bearer) url.searchParams.set("api_key", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: bearer ? { Authorization: `Bearer ${key}` } : undefined,
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`TMDB ${path} failed (${res.status})`);
  return res.json() as Promise<T>;
}

export async function trending(): Promise<Title[]> {
  const raw = await get<{ results: Raw[] }>("/trending/all/week");
  return raw.results.map((r) => toTitle(r)).filter((t): t is Title => !!t);
}

export async function popular(mediaType: "movie" | "tv", region: string): Promise<Title[]> {
  const raw = await get<{ results: Raw[] }>(`/discover/${mediaType}`, { sort_by: "popularity.desc", watch_region: region });
  return raw.results.map((r) => toTitle(r, mediaType)).filter((t): t is Title => !!t);
}

export const img = (path: string | null, size: "w342" | "w780" | "w1280" | "original" = "w342") =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
