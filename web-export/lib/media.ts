/** Client-safe media helpers (no API keys): image URLs, provider links, dates. */

export type MediaType = "movie" | "tv";

export const img = (path: string | null | undefined, size: "w92" | "w185" | "w342" | "w780" | "w1280" | "original" = "w342") =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

export const titleHref = (mediaType: MediaType, id: number) => `/app/title/${mediaType}/${id}`;

/** Landing page download section ("Available on Omnia Desktop" links here). */
export const DESKTOP_DOWNLOAD_HREF = "/#download";

// ---------------------------------------------------------------------------------------------
// "Open on <provider>": a provider search URL for the title (the desktop resolver's fallback,
// src-tauri/src/resolver/justwatch.rs → fallback_search_url).
// ---------------------------------------------------------------------------------------------

export function providerSearchUrl(providerId: number, providerName: string, title: string, region: string): string {
  const q = encodeURIComponent(title.trim());
  const r = region.toLowerCase();
  const name = providerName.toLowerCase();
  const has = (s: string) => name.includes(s);
  if ([8, 175, 1796].includes(providerId) || has("netflix")) return `https://www.netflix.com/search?q=${q}`;
  if ([122, 220, 2336].includes(providerId) || has("hotstar") || has("jiocinema")) return `https://www.hotstar.com/${r}/explore?search_query=${q}`;
  if ([9, 119, 2100, 10].includes(providerId) || has("prime video") || has("amazon")) return `https://www.primevideo.com/search/?phrase=${q}`;
  if (providerId === 337 || has("disney")) return `https://www.disneyplus.com/search?q=${q}`;
  if ([2, 350].includes(providerId) || has("apple tv") || has("itunes")) return `https://tv.apple.com/${r}/search?term=${q}`;
  if (providerId === 232 || has("zee5")) return `https://www.zee5.com/search?q=${q}`;
  if (providerId === 237 || has("sonyliv") || has("sony liv")) return `https://www.sonyliv.com/search?searchTerm=${q}`;
  if ([1899, 384].includes(providerId) || has("hbo") || name === "max" || name.startsWith("max ")) return `https://play.hbomax.com/search?q=${q}`;
  if (providerId === 15 || has("hulu")) return `https://www.hulu.com/search?q=${q}`;
  if ([386, 387].includes(providerId) || has("peacock")) return `https://www.peacocktv.com/search?q=${q}`;
  if (providerId === 531 || has("paramount")) return `https://www.paramountplus.com/search/?query=${q}`;
  if (providerId === 283 || has("crunchyroll")) return `https://www.crunchyroll.com/search?q=${q}`;
  if (providerId === 11 || has("mubi")) return `https://mubi.com/${r}/search/films?query=${q}`;
  if (providerId === 3 || has("google play")) return `https://play.google.com/store/search?q=${q}&c=movies`;
  if (providerId === 192 || has("youtube")) return `https://www.youtube.com/results?search_query=${q}`;
  if (has("mx player")) return `https://www.mxplayer.in/search?q=${q}`;
  return `https://www.justwatch.com/${r}/search?q=${q}`;
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

/** TMDB air dates are calendar days; treat them as local midnight. */
export const parseDay = (d: string | null | undefined) => {
  if (!d) return null;
  const [y, m, day] = d.split("-").map(Number);
  return y && m && day ? new Date(y, m - 1, day) : null;
};

export const isAired = (d: string | null | undefined, now = new Date()) => {
  const day = parseDay(d);
  return !!day && day.getTime() <= now.getTime();
};

/** Whole days from today until the date (0 = today, negative = past). */
export function daysUntil(d: string | null | undefined, now = new Date()): number | null {
  const day = parseDay(d);
  if (!day) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((day.getTime() - today.getTime()) / 86_400_000);
}

export function countdownLabel(d: string | null | undefined): string | null {
  const n = daysUntil(d);
  if (n == null) return null;
  if (n < 0) return "Out now";
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n < 7) return `In ${n} days`;
  if (n < 60) return `In ${Math.round(n / 7)} week${Math.round(n / 7) === 1 ? "" : "s"}`;
  return `In ${Math.round(n / 30)} months`;
}

export const formatDay = (d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) => {
  const day = parseDay(d);
  return day ? day.toLocaleDateString("en-GB", opts) : null;
};

export const episodeCode = (s: number, e: number) => `S${s} E${e}`;

export const formatRuntime = (mins: number | null | undefined) => {
  if (!mins) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
};
