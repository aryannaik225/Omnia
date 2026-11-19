import "server-only";

/** A poster for the landing page: real TMDB art when a key is configured, generated art otherwise. */
export interface ShowPoster {
  id: string;
  title: string;
  year: number | null;
  /** Same-origin URL (through Next's image optimizer) so WebGL can sample it without CORS. */
  poster: string | null;
  backdrop: string | null;
  /** Two colours for generated art and the ambient light before the image has been sampled. */
  hues: [string, string];
  /** US certification (G, PG, PG-13, R, TV-14, TV-MA). */
  cert?: string;
}

export interface Spotlight {
  title: string;
  year: number;
  backdrop: string | null;
}

const optimized = (path: string, size: "w342" | "w780" | "w1280", w: number) =>
  `/_next/image?url=${encodeURIComponent(`https://image.tmdb.org/t/p/${size}${path}`)}&w=${w}&q=75`;

type Entry = { type: "movie" | "tv"; id: number; title: string; year: number; cert: string; hues: [string, string] };

/**
 * Every title the landing page names, with its real TMDB id and US certification (checked
 * against TMDB). Components look titles up by slug, so a card can never show the wrong film.
 */
const CATALOG = {
  // the theater wall
  "dune-part-two": { type: "movie", id: 693134, title: "Dune: Part Two", year: 2024, cert: "PG-13", hues: ["#ffb347", "#2a1405"] },
  "stranger-things": { type: "tv", id: 66732, title: "Stranger Things", year: 2016, cert: "TV-14", hues: ["#ff3b30", "#1a0303"] },
  oppenheimer: { type: "movie", id: 872585, title: "Oppenheimer", year: 2023, cert: "R", hues: ["#ff9f0a", "#1d0d02"] },
  "the-last-of-us": { type: "tv", id: 100088, title: "The Last of Us", year: 2023, cert: "TV-MA", hues: ["#8fbf6a", "#0b140a"] },
  "spider-verse": { type: "movie", id: 569094, title: "Spider-Man: Across the Spider-Verse", year: 2023, cert: "PG", hues: ["#ff2d55", "#0b0a26"] },
  severance: { type: "tv", id: 95396, title: "Severance", year: 2022, cert: "TV-MA", hues: ["#64d2ff", "#04121d"] },
  "the-batman": { type: "movie", id: 414906, title: "The Batman", year: 2022, cert: "PG-13", hues: ["#ff453a", "#120202"] },
  "the-bear": { type: "tv", id: 136315, title: "The Bear", year: 2022, cert: "TV-MA", hues: ["#5ac8fa", "#06121a"] },
  interstellar: { type: "movie", id: 157336, title: "Interstellar", year: 2014, cert: "PG-13", hues: ["#a1c4fd", "#0b1020"] },
  andor: { type: "tv", id: 83867, title: "Andor", year: 2022, cert: "TV-14", hues: ["#ffcc80", "#1a1006"] },
  "top-gun-maverick": { type: "movie", id: 361743, title: "Top Gun: Maverick", year: 2022, cert: "PG-13", hues: ["#ff9f0a", "#1a0f04"] },
  "house-of-the-dragon": { type: "tv", id: 94997, title: "House of the Dragon", year: 2022, cert: "TV-MA", hues: ["#ff6b35", "#1a0805"] },
  "everything-everywhere": { type: "movie", id: 545611, title: "Everything Everywhere All at Once", year: 2022, cert: "R", hues: ["#bf5af2", "#120424"] },
  "the-boys": { type: "tv", id: 76479, title: "The Boys", year: 2019, cert: "TV-MA", hues: ["#ffd60a", "#1d1400"] },
  "blade-runner-2049": { type: "movie", id: 335984, title: "Blade Runner 2049", year: 2017, cert: "R", hues: ["#ff9f0a", "#200d00"] },
  wednesday: { type: "tv", id: 119051, title: "Wednesday", year: 2022, cert: "TV-14", hues: ["#7d7aff", "#0b0a26"] },
  "avengers-endgame": { type: "movie", id: 299534, title: "Avengers: Endgame", year: 2019, cert: "PG-13", hues: ["#bf5af2", "#0f0420"] },
  "breaking-bad": { type: "tv", id: 1396, title: "Breaking Bad", year: 2008, cert: "TV-MA", hues: ["#32d74b", "#031a08"] },
  // kids & family
  coco: { type: "movie", id: 354912, title: "Coco", year: 2017, cert: "PG", hues: ["#ff9f0a", "#210d00"] },
  "paddington-2": { type: "movie", id: 346648, title: "Paddington 2", year: 2017, cert: "PG", hues: ["#ff453a", "#1c0303"] },
  // the dialogue reel
  casablanca: { type: "movie", id: 289, title: "Casablanca", year: 1942, cert: "PG", hues: ["#d1d1d6", "#111"] },
  "star-wars": { type: "movie", id: 11, title: "Star Wars", year: 1977, cert: "PG", hues: ["#ffd60a", "#0a0a0a"] },
  godfather: { type: "movie", id: 238, title: "The Godfather", year: 1972, cert: "R", hues: ["#e9c45c", "#0a0702"] },
  jaws: { type: "movie", id: 578, title: "Jaws", year: 1975, cert: "PG", hues: ["#0a84ff", "#020a1a"] },
  "the-dark-knight": { type: "movie", id: 155, title: "The Dark Knight", year: 2008, cert: "PG-13", hues: ["#5ac8fa", "#04080d"] },
  "toy-story": { type: "movie", id: 862, title: "Toy Story", year: 1995, cert: "G", hues: ["#64d2ff", "#04121d"] },
  titanic: { type: "movie", id: 597, title: "Titanic", year: 1997, cert: "PG-13", hues: ["#a1c4fd", "#0b1020"] },
  "iron-man": { type: "movie", id: 1726, title: "Iron Man", year: 2008, cert: "PG-13", hues: ["#ff453a", "#1c0303"] },
  "taxi-driver": { type: "movie", id: 103, title: "Taxi Driver", year: 1976, cert: "R", hues: ["#ffd60a", "#1d1400"] },
  "apollo-13": { type: "movie", id: 568, title: "Apollo 13", year: 1995, cert: "PG", hues: ["#ff9f0a", "#210d00"] },
  shawshank: { type: "movie", id: 278, title: "The Shawshank Redemption", year: 1994, cert: "R", hues: ["#8e8e93", "#0a0a0a"] },
  terminator: { type: "movie", id: 218, title: "The Terminator", year: 1984, cert: "R", hues: ["#0a84ff", "#020a1a"] },
  "finding-nemo": { type: "movie", id: 12, title: "Finding Nemo", year: 2003, cert: "G", hues: ["#ff9f0a", "#04121d"] },
  "wizard-of-oz": { type: "movie", id: 630, title: "The Wizard of Oz", year: 1939, cert: "G", hues: ["#32d74b", "#031a08"] },
  "sixth-sense": { type: "movie", id: 745, title: "The Sixth Sense", year: 1999, cert: "PG-13", hues: ["#8e8e93", "#0a0a0a"] },
  "forrest-gump": { type: "movie", id: 13, title: "Forrest Gump", year: 1994, cert: "PG-13", hues: ["#a1c4fd", "#0b1020"] },
  "the-shining": { type: "movie", id: 694, title: "The Shining", year: 1980, cert: "R", hues: ["#ff453a", "#1c0303"] },
  "a-few-good-men": { type: "movie", id: 881, title: "A Few Good Men", year: 1992, cert: "R", hues: ["#d1d1d6", "#111"] },
} satisfies Record<string, Entry>;

export type CatalogKey = keyof typeof CATALOG;
export type Catalog = Record<CatalogKey, ShowPoster>;

/** Titles on the theater wall, in order. Hollywood-forward, every one a real title. */
export const WALL: CatalogKey[] = [
  "dune-part-two",
  "stranger-things",
  "oppenheimer",
  "the-last-of-us",
  "spider-verse",
  "severance",
  "the-batman",
  "the-bear",
  "interstellar",
  "andor",
  "top-gun-maverick",
  "house-of-the-dragon",
  "everything-everywhere",
  "the-boys",
  "blade-runner-2049",
  "wednesday",
  "avengers-endgame",
  "breaking-bad",
];

async function tmdbJson<T>(path: string): Promise<T | null> {
  const key = process.env.TMDB_API_KEY ?? "";
  if (!key) return null;
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  const bearer = key.length > 60;
  if (!bearer) url.searchParams.set("api_key", key);
  try {
    const res = await fetch(url, { headers: bearer ? { Authorization: `Bearer ${key}` } : undefined, next: { revalidate: 86400 } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * The whole curated catalog with TMDB artwork (or generated art when no key is configured).
 * Cached for a day: the ids never change, only the art might.
 */
export async function getCatalog(): Promise<Catalog> {
  const keys = Object.keys(CATALOG) as CatalogKey[];
  const art = await Promise.all(
    keys.map((k) => {
      const e: Entry = CATALOG[k];
      return tmdbJson<{ poster_path?: string | null; backdrop_path?: string | null }>(`/${e.type}/${e.id}`);
    }),
  );
  return Object.fromEntries(
    keys.map((k, i) => {
      const e: Entry = CATALOG[k];
      const a = art[i];
      const p: ShowPoster = {
        id: `${e.type}-${e.id}`,
        title: e.title,
        year: e.year,
        poster: a?.poster_path ? optimized(a.poster_path, "w342", 384) : null,
        backdrop: a?.backdrop_path ? optimized(a.backdrop_path, "w780", 828) : null,
        hues: e.hues,
        cert: e.cert,
      };
      return [k, p];
    }),
  ) as Catalog;
}

/** The Best Picture showcase (Parasite, TMDB 496243): backdrop from TMDB when configured. */
export async function getSpotlight(): Promise<Spotlight> {
  const data = await tmdbJson<{ backdrop_path?: string | null }>("/movie/496243");
  return { title: "Parasite", year: 2019, backdrop: data?.backdrop_path ? optimized(data.backdrop_path, "w1280", 1920) : null };
}
