/**
 * Home page layout: the rows after "Browse by service" can be reordered in Settings → Home Page
 * Layout. Hero, Continue Watching, Top 10, hubs, My List and Browse by service stay fixed above.
 *
 * Keep this file identical in src/config/ and web-export/omnia/config/: the order syncs between
 * Omnia Desktop and the web app (profiles.home_row_order), so both must know the same ids.
 */

export interface HomeSlot {
  id: string;
  /** Settings label (region-specific titles are generalised). */
  label: string;
  hint?: string;
}

/** Default order. Append new rows at the end; never reuse or rename an id. */
export const HOME_SLOTS: readonly HomeSlot[] = [
  { id: "in-theatres", label: "In Theatres Now" },
  { id: "acclaimed-films", label: "Acclaimed Films" },
  { id: "airing", label: "Currently Airing" },
  { id: "acclaimed-series", label: "Critically Acclaimed Series" },
  { id: "next-watch", label: "Your Next Watch", hint: "Personal" },
  { id: "because", label: "Because you watched / liked…", hint: "Personal" },
  { id: "region-movies", label: "Top Movies in your region" },
  { id: "region-series", label: "Top Series in your region" },
  { id: "imdb-popular", label: "IMDb Most Popular Movies" },
  { id: "rt-fresh", label: "Rotten Tomatoes Certified Fresh Movies" },
  { id: "moviemeter", label: "IMDb Moviemeter" },
  { id: "hidden-gems", label: "IMDb Hidden Gems" },
  { id: "streaming", label: "IMDb Popular on Streaming" },
  { id: "anime", label: "Trending Animes" },
  { id: "love", label: "We Think You'll Love These", hint: "Personal" },
  { id: "oscars", label: "Oscar Movies" },
  { id: "laugh", label: "Laugh out Loud Shows" },
  { id: "millennial", label: "Millennial Rewatch Favourites" },
  { id: "scifi-tv", label: "TV Sci-Fi & Fantasy" },
  { id: "horror", label: "If These Walls Could Scream" },
  { id: "rt-hot", label: "Rotten Tomatoes Verified Hot" },
  { id: "best-year", label: "Best of the Year" },
  { id: "worst", label: "Worst Reviewed" },
  { id: "popular-tv", label: "Most Popular TV" },
];

export const DEFAULT_HOME_ORDER: readonly string[] = HOME_SLOTS.map((s) => s.id);
const KNOWN = new Set(DEFAULT_HOME_ORDER);
const MAX_IDS = 100;

/**
 * A saved order made usable: unknown ids (a row only another app version has) are skipped,
 * duplicates dropped, and rows added since it was saved appended in their default place order.
 */
export function resolveHomeOrder(saved: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of Array.isArray(saved) ? saved.slice(0, MAX_IDS) : []) {
    if (typeof id === "string" && KNOWN.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const id of DEFAULT_HOME_ORDER) if (!seen.has(id)) out.push(id);
  return out;
}

/** Parses a stored order (JSON array of ids); null when absent or invalid. */
export function parseHomeOrder(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 64).slice(0, MAX_IDS) : null;
  } catch {
    return null;
  }
}

/**
 * What to store: the user's order, keeping ids this app doesn't know (another version's rows)
 * after the known ones so a round trip through an older app never loses them.
 */
export function mergeForSave(order: readonly string[], previous: readonly string[] | null): string[] {
  const unknown = (previous ?? []).filter((id) => !KNOWN.has(id) && !order.includes(id));
  return [...order, ...unknown].slice(0, MAX_IDS);
}

export const isDefaultOrder = (order: readonly string[]) => order.length === DEFAULT_HOME_ORDER.length && order.every((id, i) => id === DEFAULT_HOME_ORDER[i]);

export const slotLabel = (id: string) => HOME_SLOTS.find((s) => s.id === id);

/** Swaps a row with its neighbour (dir -1 = up, 1 = down). */
export function moveSlot(order: readonly string[], index: number, dir: -1 | 1): string[] {
  const j = index + dir;
  if (index < 0 || j < 0 || j >= order.length) return [...order];
  const next = [...order];
  [next[index], next[j]] = [next[j]!, next[index]!];
  return next;
}
