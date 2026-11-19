/**
 * Home row registry: every catalog row on Home maps to a TMDB query here, and the same entry
 * feeds the row's full-page "View More" grid (paged), so a row and its grid never disagree.
 *
 * "IMDb" / "Rotten Tomatoes" rows are approximations built from TMDB signals (popularity,
 * vote average and vote count); no IMDb or RT data is requested.
 *
 * Regional mixing: outside the US, global rows blend ~30% titles produced in the active region
 * (`with_origin_country`) into ~70% global ones (3 of every 10 slots). It is a soft target: if
 * the regional query comes back short, global titles fill the gaps (and vice versa past the
 * last global page), so a row never breaks for lack of regional data.
 */
import {
  discover,
  nowPlaying,
  titleRecommendations,
  titleSummary,
  trending,
  type CatalogContext,
  type MediaSummary,
  type Paged,
} from "../services/tmdbClient";
import type { MediaType } from "../services/tauriBridge";
import type { RowRef } from "../store/useAppStore";

export interface RowEnv {
  ctx: CatalogContext;
  /** Titles kept out of discovery-style personal rows (`mediaType:id`, already watched). */
  exclude?: Set<string>;
}

export interface RowSpec {
  title: string;
  subtitle?: string;
  /** The query applies the "My Subscriptions" provider filter itself (TMDB discover). */
  sourceFiltered: boolean;
  /** Shown regardless of "My Subscriptions" (e.g. films in cinemas, not streaming yet). */
  ignoreSubscriptions?: boolean;
  load: (page: number) => Promise<Paged<MediaSummary>>;
}

type Loader = (page: number) => Promise<Paged<MediaSummary>>;
type Params = Record<string, string | number | boolean>;

/** Items per Home row; the next slot is the "View More" card. */
export const ROW_CAP = 20;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const keyOf = (m: MediaSummary) => `${m.mediaType}:${m.id}`;

const isoDaysFromNow = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

export function regionName(code: string): string {
  try {
    return displayNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export function dedupe(items: MediaSummary[]): MediaSummary[] {
  const seen = new Set<string>();
  return items.filter((m) => (seen.has(keyOf(m)) ? false : (seen.add(keyOf(m)), true)));
}

export function interleave(...lists: MediaSummary[][]): MediaSummary[] {
  const out: MediaSummary[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (l[i]) out.push(l[i]!);
  return dedupe(out);
}

/** Slots (mod 10) that take a regional title: 3 in 10 ≈ 30%. */
const REGIONAL_SLOTS = new Set([2, 5, 8]);

/**
 * Blends regional titles into a global list at ~30%. Regional shortfalls are filled from the
 * global list; once the global list runs out the row ends (keeping the ratio), unless there was
 * no global data at all, in which case the regional titles are used as they are.
 */
export function mixRegional(global: MediaSummary[], regional: MediaSummary[]): MediaSummary[] {
  if (!global.length) return dedupe(regional);
  const seen = new Set<string>();
  const cursor = { g: 0, r: 0 };
  const pull = (list: MediaSummary[], which: "g" | "r") => {
    while (cursor[which] < list.length) {
      const m = list[cursor[which]++]!;
      if (!seen.has(keyOf(m))) {
        seen.add(keyOf(m));
        return m;
      }
    }
    return null;
  };
  const out: MediaSummary[] = [];
  for (let slot = 0; ; slot++) {
    const m = REGIONAL_SLOTS.has(slot % 10) ? (pull(regional, "r") ?? pull(global, "g")) : pull(global, "g");
    if (!m) break;
    out.push(m);
  }
  return out;
}

/** The US catalog *is* TMDB's global default, so there is nothing to blend in. */
const shouldMix = (env: RowEnv) => env.ctx.region.toUpperCase() !== "US";

/** The same query restricted to titles produced in the region, with vote floors scaled down. */
function regionalize(params: Params, region: string): Params {
  const p: Params = { ...params, with_origin_country: region };
  for (const k of ["vote_count.gte", "vote_count.lte"] as const) {
    if (typeof p[k] === "number") p[k] = Math.max(20, Math.round((p[k] as number) / 6));
  }
  return p;
}

const disc = (env: RowEnv, mt: MediaType, params: Params = {}): Loader => (page) => discover(mt, env.ctx, params, page);

function mixed(env: RowEnv, global: Loader, regional: Loader | null): Loader {
  if (!regional || !shouldMix(env)) return global;
  return async (page) => {
    const [g, r] = await Promise.all([global(page), regional(page).catch(() => null)]);
    return { page, totalPages: Math.max(g.totalPages, r?.totalPages ?? 0), results: mixRegional(g.results, r?.results ?? []) };
  };
}

/** Discover with the regional blend applied. */
const mixedDisc = (env: RowEnv, mt: MediaType, params: Params = {}): Loader =>
  mixed(env, disc(env, mt, params), disc(env, mt, regionalize(params, env.ctx.region)));

/** Movies and series side by side, page by page. */
const both = (...loaders: Loader[]): Loader => async (page) => {
  const pages = await Promise.all(loaders.map((l) => l(page)));
  return { page, totalPages: Math.max(...pages.map((p) => p.totalPages)), results: interleave(...pages.map((p) => p.results)) };
};

const fromList = (items: MediaSummary[]): Paged<MediaSummary> => ({ page: 1, totalPages: 1, results: items });

/** A curated list of TMDB ids, paged 20 at a time. */
const idList = (mt: MediaType, ids: number[]): Loader => async (page) => {
  const slice = ids.slice((page - 1) * ROW_CAP, page * ROW_CAP);
  const items = await Promise.all(slice.map((id) => titleSummary(mt, id).catch(() => null)));
  return { page, totalPages: Math.ceil(ids.length / ROW_CAP), results: items.filter((m): m is MediaSummary => !!m) };
};

/** Seeds encoded in a row's `arg`: "movie:603,tv:1396". */
export const encodeSeeds = (seeds: { id: number; mediaType: MediaType }[]) => seeds.map((s) => `${s.mediaType}:${s.id}`).join(",");
const decodeSeeds = (arg = "") =>
  arg
    .split(",")
    .map((s) => s.split(":"))
    .filter(([mt, id]) => (mt === "movie" || mt === "tv") && Number(id) > 0)
    .map(([mt, id]) => ({ mediaType: mt as MediaType, id: Number(id) }));

/**
 * Aggregate "more like these": TMDB recommendations of every seed, ranked by how many seeds
 * point to a title and how high (reciprocal rank), minus the seeds and anything excluded.
 */
const fromSeeds = (env: RowEnv, arg: string | undefined): Loader => async (page) => {
  const seeds = decodeSeeds(arg);
  const pages = await Promise.all(seeds.map((s) => titleRecommendations(s.mediaType, s.id, page).catch(() => null)));
  const score = new Map<string, { m: MediaSummary; s: number }>();
  const skip = new Set(seeds.map((s) => `${s.mediaType}:${s.id}`));
  for (const p of pages) {
    p?.results.forEach((m, rank) => {
      const k = keyOf(m);
      if (skip.has(k) || env.exclude?.has(k)) return;
      const prev = score.get(k);
      score.set(k, { m, s: (prev?.s ?? 0) + 1 / (rank + 4) });
    });
  }
  return {
    page,
    totalPages: Math.max(1, ...pages.map((p) => p?.totalPages ?? 1)),
    results: [...score.values()].sort((a, b) => b.s - a.s).map((x) => x.m),
  };
};

const streamingParams = (ids: string, extra: Params = {}): Params => ({
  with_watch_providers: ids,
  with_watch_monetization_types: "flatrate|free|ads",
  ...extra,
});

// ---------------------------------------------------------------------------------------------
// Curated data
// ---------------------------------------------------------------------------------------------

/** Academy Award for Best Picture winners, newest first (TMDB movie ids, verified). */
const OSCAR_BEST_PICTURE = [
  1054867, // One Battle After Another (2025)
  1064213, // Anora
  872585, // Oppenheimer
  545611, // Everything Everywhere All at Once
  776503, // CODA
  581734, // Nomadland
  496243, // Parasite
  490132, // Green Book
  399055, // The Shape of Water
  376867, // Moonlight
  314365, // Spotlight
  194662, // Birdman
  76203, // 12 Years a Slave
  68734, // Argo
  74643, // The Artist
  45269, // The King's Speech
  12162, // The Hurt Locker
  12405, // Slumdog Millionaire
  6977, // No Country for Old Men
  1422, // The Departed
  1640, // Crash
  70, // Million Dollar Baby
  122, // The Lord of the Rings: The Return of the King
  1574, // Chicago
  453, // A Beautiful Mind
  98, // Gladiator
  14, // American Beauty
  1934, // Shakespeare in Love
  597, // Titanic
  409, // The English Patient
  197, // Braveheart
  13, // Forrest Gump
  424, // Schindler's List
  33, // Unforgiven
  274, // The Silence of the Lambs
  581, // Dances with Wolves
  403, // Driving Miss Daisy
  380, // Rain Man
  746, // The Last Emperor
  792, // Platoon
  279, // Amadeus
  240, // The Godfather Part II
  238, // The Godfather
];

/** TMDB keywords: anime, sitcom; haunted house, demonic possession, ghost. */
const KW_ANIME = 210024;
const KW_SITCOM = 193171;
const KW_HAUNTING = "3358|161261|162846";
/** Documentary, music (concert films), TV movie: kept out of "best film" style rankings. */
const NOT_FEATURES = "99|10402|10770";

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

export function resolveRow(ref: RowRef, env: RowEnv): RowSpec | null {
  const region = env.ctx.region;
  const place = regionName(region);
  const year = new Date().getFullYear();

  switch (ref.id) {
    case "top10":
      return {
        title: "Top 10 Today",
        subtitle: "The movies and series everyone is watching today",
        sourceFiltered: false,
        // Global chart (no regional blend), released titles only: trending lists also carry
        // upcoming films whose trailers are buzzing. Two trending pages per page keep 10 after filtering.
        load: async (page) => {
          const today = isoDaysFromNow(0);
          const [a, b] = await Promise.all([trending("all", "day", page * 2 - 1), trending("all", "day", page * 2)]);
          const released = (m: MediaSummary) => !!m.releaseDate && m.releaseDate <= today;
          return { page, totalPages: Math.ceil(a.totalPages / 2), results: dedupe([...a.results, ...b.results]).filter(released) };
        },
      };
    case "in-theatres":
      return {
        title: "In Theatres Now",
        subtitle: `Now showing in cinemas in ${place}`,
        sourceFiltered: false,
        ignoreSubscriptions: true,
        load: (page) => nowPlaying(region, page),
      };
    case "acclaimed-films":
      return {
        title: "Acclaimed Films",
        subtitle: "The highest-rated films, with thousands of votes",
        sourceFiltered: true,
        load: mixedDisc(env, "movie", { sort_by: "vote_average.desc", "vote_count.gte": 2500 }),
      };
    case "airing":
      return {
        title: "Currently Airing",
        subtitle: "Series with new episodes this week",
        sourceFiltered: true,
        load: mixedDisc(env, "tv", { "air_date.gte": isoDaysFromNow(-7), "air_date.lte": isoDaysFromNow(7), "vote_count.gte": 30 }),
      };
    case "acclaimed-series":
      return {
        title: "Critically Acclaimed Series",
        subtitle: "Top-rated series, loved by critics and audiences",
        sourceFiltered: true,
        load: mixedDisc(env, "tv", { sort_by: "vote_average.desc", "vote_count.gte": 800 }),
      };
    case "region-movies":
      return {
        title: `Top Movies in ${place}`,
        subtitle: `Trending films from ${place}`,
        sourceFiltered: true,
        load: disc(env, "movie", { with_origin_country: region, "primary_release_date.gte": isoDaysFromNow(-3 * 365), "vote_count.gte": 10 }),
      };
    case "region-series":
      return {
        title: `Top Series in ${place}`,
        subtitle: `Trending series from ${place}`,
        sourceFiltered: true,
        load: disc(env, "tv", { with_origin_country: region, "first_air_date.gte": isoDaysFromNow(-4 * 365), "vote_count.gte": 5 }),
      };
    case "imdb-popular":
      return {
        title: "IMDb Most Popular Movies",
        subtitle: "Popular right now, with a big audience behind them",
        sourceFiltered: true,
        load: mixedDisc(env, "movie", { "vote_count.gte": 1500 }),
      };
    case "rt-fresh":
      return {
        title: "Rotten Tomatoes Certified Fresh Movies",
        subtitle: "Well reviewed and widely seen",
        sourceFiltered: true,
        load: mixedDisc(env, "movie", { "vote_average.gte": 7.4, "vote_count.gte": 800 }),
      };
    case "moviemeter":
      return {
        title: "IMDb Moviemeter",
        subtitle: "The films people are looking up this week",
        sourceFiltered: false,
        load: mixed(
          env,
          (page) => trending("movie", "week", page),
          disc(env, "movie", { with_origin_country: region, "primary_release_date.gte": isoDaysFromNow(-120) }),
        ),
      };
    case "hidden-gems":
      return {
        title: "IMDb Hidden Gems",
        subtitle: "Highly rated films most people haven't found yet",
        sourceFiltered: true,
        load: mixedDisc(env, "movie", { sort_by: "vote_average.desc", without_genres: NOT_FEATURES, "vote_average.gte": 7.3, "vote_count.gte": 150, "vote_count.lte": 1500 }),
      };
    case "streaming":
      return {
        title: ref.label ? `IMDb Popular on ${ref.label}` : "IMDb Popular on Streaming",
        subtitle: "Big-audience hits you can stream right now",
        sourceFiltered: true,
        load: both(
          mixedDisc(env, "movie", streamingParams(ref.arg ?? "8", { "vote_count.gte": 300 })),
          mixedDisc(env, "tv", streamingParams(ref.arg ?? "8", { "vote_count.gte": 150 })),
        ),
      };
    case "service":
      return {
        title: `Popular on ${ref.label ?? "this service"}`,
        subtitle: `Movies and series streaming on ${ref.label ?? "this service"} in ${place}`,
        sourceFiltered: true,
        load: both(
          mixedDisc(env, "tv", streamingParams(ref.arg ?? "", { "vote_count.gte": 20 })),
          mixedDisc(env, "movie", streamingParams(ref.arg ?? "", { "vote_count.gte": 20 })),
        ),
      };
    case "anime":
      return {
        title: "Trending Animes",
        subtitle: "Popular anime series and films",
        sourceFiltered: true,
        load: both(
          disc(env, "tv", { with_genres: 16, with_keywords: KW_ANIME, "vote_count.gte": 30 }),
          disc(env, "tv", { with_genres: 16, with_original_language: "ja", "first_air_date.gte": isoDaysFromNow(-3 * 365) }),
          disc(env, "movie", { with_genres: 16, with_keywords: KW_ANIME, "vote_count.gte": 100 }),
        ),
      };
    case "oscars":
      return {
        title: "Oscar Movies",
        subtitle: "Every Academy Award for Best Picture winner, newest first",
        sourceFiltered: false,
        load: idList("movie", OSCAR_BEST_PICTURE),
      };
    case "laugh":
      return {
        title: "Laugh out Loud Shows",
        subtitle: "Comedy series that never miss",
        sourceFiltered: true,
        load: both(
          mixedDisc(env, "tv", { with_genres: 35, without_genres: "10763|10764|10767", "vote_average.gte": 7.2, "vote_count.gte": 250 }),
          disc(env, "tv", { with_keywords: KW_SITCOM, "vote_count.gte": 150 }),
        ),
      };
    case "millennial":
      return {
        title: "Millennial Rewatch Favourites",
        subtitle: "The '90s and 2000s comfort classics",
        sourceFiltered: true,
        load: both(
          mixedDisc(env, "tv", { sort_by: "vote_count.desc", "first_air_date.gte": "1994-01-01", "first_air_date.lte": "2012-12-31", "vote_count.gte": 600 }),
          mixedDisc(env, "movie", {
            sort_by: "vote_count.desc",
            with_genres: "35|10749|10751|12",
            "primary_release_date.gte": "1995-01-01",
            "primary_release_date.lte": "2012-12-31",
            "vote_count.gte": 4000,
          }),
        ),
      };
    case "scifi-tv":
      return {
        title: "TV Sci-Fi & Fantasy",
        subtitle: "Other worlds, other times",
        sourceFiltered: true,
        load: mixedDisc(env, "tv", { with_genres: 10765, "vote_count.gte": 150 }),
      };
    case "horror":
      return {
        title: "If These Walls Could Scream",
        subtitle: "Haunted houses, possessions and things that go bump",
        sourceFiltered: true,
        load: mixed(
          env,
          disc(env, "movie", { with_genres: 27, with_keywords: KW_HAUNTING, "vote_count.gte": 150 }),
          disc(env, "movie", { with_genres: 27, with_origin_country: region, "vote_count.gte": 20 }),
        ),
      };
    case "rt-hot":
      return {
        title: "Rotten Tomatoes Verified Hot",
        subtitle: "Recent releases audiences are raving about",
        sourceFiltered: true,
        load: mixedDisc(env, "movie", {
          "primary_release_date.gte": isoDaysFromNow(-150),
          "primary_release_date.lte": isoDaysFromNow(0),
          "vote_average.gte": 7,
          "vote_count.gte": 80,
        }),
      };
    case "best-year":
      return {
        title: `Best of ${year}`,
        subtitle: `The top-rated films released in ${year}`,
        sourceFiltered: true,
        load: mixedDisc(env, "movie", { sort_by: "vote_average.desc", without_genres: NOT_FEATURES, primary_release_year: year, "vote_count.gte": 150 }),
      };
    case "worst":
      return {
        title: "Worst Reviewed",
        subtitle: "So bad they're (almost) good",
        sourceFiltered: true,
        load: mixedDisc(env, "movie", { sort_by: "vote_average.asc", "vote_average.lte": 4.8, "vote_count.gte": 400 }),
      };
    case "popular-tv":
      return {
        title: "Most Popular TV",
        subtitle: "The series with the most buzz right now",
        sourceFiltered: true,
        load: mixedDisc(env, "tv", { "vote_count.gte": 100 }),
      };
    case "because":
    case "because-watched": {
      const [seed] = decodeSeeds(ref.arg);
      if (!seed) return null;
      return {
        title: `Because you ${ref.id === "because" ? "liked" : "watched"} ${ref.label ?? "this"}`,
        subtitle: "More titles in the same vein",
        sourceFiltered: false,
        load: async (page) => {
          const p = await titleRecommendations(seed.mediaType, seed.id, page);
          return { ...p, results: p.results.filter((m) => !env.exclude?.has(keyOf(m))) };
        },
      };
    }
    case "next-watch":
      return {
        title: "Your Next Watch",
        subtitle: ref.label ? `Picked from what you watched last, like ${ref.label}` : "Picked from what you watched last",
        sourceFiltered: false,
        load: fromSeeds(env, ref.arg),
      };
    case "love":
      return {
        title: "We Think You'll Love These",
        subtitle: ref.label ?? "Based on everything you've loved",
        sourceFiltered: false,
        load: fromSeeds(env, ref.arg),
      };
    case "trending-week":
      return {
        title: "Your Next Watch",
        subtitle: "Popular picks to start with",
        sourceFiltered: false,
        load: (page) => trending("all", "week", page),
      };
    default:
      return null;
  }
}

/** A static list as a paged source (backend ML rows, watchlist). */
export const staticLoader = (items: MediaSummary[]): Loader => async () => fromList(items);
