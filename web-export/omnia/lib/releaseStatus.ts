/**
 * What "Where to watch" should say when a title has no providers in the region yet:
 * upcoming (exact date, cinemas vs streaming, the platform when TMDB names it), in theatres now,
 * or genuinely unavailable.
 *
 * Movies use TMDB's /movie/{id}/release_dates. Types: 1 premiere, 2 limited theatrical,
 * 3 theatrical, 4 digital, 5 physical, 6 TV. Only 2 and 3 ever mean "in cinemas":
 *   - in the viewer's region, a limited (2) or wide (3) theatrical release counts;
 *   - without regional data we fall back to worldwide dates, where only a wide (3) release
 *     counts: a streaming film's one-week qualifying run in New York (2) doesn't put it in
 *     cinemas anywhere near the viewer.
 * A digital (4) release names its platform from TMDB's `note` ("Netflix") when it is one.
 * Series use first_air_date, next_episode_to_air and status.
 */
import type { MediaDetails, ReleaseDate } from "../services/tmdbClient";

export type ReleaseChannel = "cinemas" | "digital" | "tv" | "unknown";

export type ReleaseStatus =
  | {
      kind: "upcoming";
      date: string | null;
      days: number | null;
      channel: ReleaseChannel;
      /** Streaming platform from TMDB's note on the digital release ("Netflix"). */
      platform: string | null;
      /** Digital release following a cinema release. */
      digital: string | null;
      /** A limited cinema run alongside a streaming release. */
      alsoInCinemas: boolean;
      regional: boolean;
      /** Series: "Series premiere" / status. */
      label: string | null;
    }
  | { kind: "theatres"; since: string; digital: string | null; platform: string | null; regional: boolean }
  | { kind: "airing"; date: string; days: number; label: string }
  | { kind: "none" };

/** How long after a theatrical release a title without providers still counts as "in theatres". */
export const THEATRICAL_WINDOW_DAYS = 60;

const HOME = new Set([4, 5, 6]);
const DIGITAL = 4;

/** Streaming / digital platforms TMDB writes into release notes. */
const PLATFORM =
  /netflix|prime video|amazon|apple tv|disney|hulu|hbo|\bmax\b|peacock|paramount|hotstar|jiocinema|zee5|sony ?liv|mubi|youtube|crunchyroll|shudder|starz|showtime|amc\+|britbox|now tv|sky|canal|stan\b|crave|viaplay|aha\b|sun ?nxt|hoichoi|voot|mx player|tubi|pluto|roku|plex|curiosity|discovery\+|itv|bbc iplayer|channel 4|all 4|rtl|joyn|movistar|globoplay|vix|iqiyi|viu|wetv|tving|wavve|coupang|u-next|hulu japan|lionsgate|epix|mgm\+|acorn|sundance now|kanopy|fandango|vudu|google play|itunes/i;

export const todayIso = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** Whole calendar days from `from` to `to` (negative = past). */
export function daysBetween(from: string, to: string): number {
  const [a, b] = [from, to].map((d) => {
    const [y, m, day] = d.split("-").map(Number);
    return Date.UTC(y!, m! - 1, day!);
  });
  return Math.round((b! - a!) / 86_400_000);
}

/** "Releasing today", "Releasing tomorrow", "In 28 days", "In 4 months". */
export function relativeRelease(days: number | null, verb = "Releasing"): string | null {
  if (days == null) return null;
  if (days <= 0) return `${verb} today`;
  if (days === 1) return `${verb} tomorrow`;
  if (days <= 90) return `In ${days} days`;
  const months = Math.round(days / 30.4);
  return months < 24 ? `In ${months} months` : `In ${Math.round(days / 365)} years`;
}

/** The platform a digital release note names, or null ("Netflix" yes, "Premiere at TIFF" no). */
export function platformFromNote(note: string | null | undefined): string | null {
  const n = note?.trim();
  return n && n.length <= 40 && PLATFORM.test(n) ? n : null;
}

interface Scope {
  list: ReleaseDate[];
  regional: boolean;
  /** Types that mean "in cinemas" for this scope. */
  theatrical: Set<number>;
}

/** The region's releases; without them, the earliest date per type worldwide (wide releases only count as cinema). */
function scopeFor(dates: ReleaseDate[], region: string): Scope {
  const regional = dates.filter((d) => d.region === region);
  if (regional.length) return { list: regional, regional: true, theatrical: new Set([2, 3]) };
  const byType = new Map<number, ReleaseDate>();
  for (const d of dates) {
    const prev = byType.get(d.type);
    if (!prev || d.date < prev.date) byType.set(d.type, d);
  }
  return { list: [...byType.values()], regional: false, theatrical: new Set([3]) };
}

/** The platform named most often on digital releases (worldwide), as a fallback for the scope. */
function commonPlatform(dates: ReleaseDate[]): string | null {
  const counts = new Map<string, number>();
  for (const d of dates) {
    const p = d.type === DIGITAL ? platformFromNote(d.note) : null;
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const earliest = (list: ReleaseDate[], types: Set<number>) => list.filter((d) => types.has(d.type)).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;

/** Release status for a title that has no streaming / rent / buy providers in `region`. */
export function releaseStatus(d: MediaDetails, region: string, today = todayIso()): ReleaseStatus {
  if (d.mediaType === "movie") {
    const all = d.releaseDates ?? [];
    const { list, regional, theatrical: cinemaTypes } = scopeFor(all, region);
    const platformOf = (r: ReleaseDate | null) => (r ? platformFromNote(r.note) ?? (r.type === DIGITAL ? commonPlatform(all) : null) : null);
    const cinema = earliest(list, cinemaTypes);
    const home = earliest(list, HOME);
    const homeOut = !!home && home.date <= today;

    // Already in cinemas (and not yet out on digital / disc / TV here).
    if (cinema && cinema.date <= today && !homeOut && daysBetween(cinema.date, today) <= THEATRICAL_WINDOW_DAYS) {
      const next = home && home.date > today ? home : null;
      return { kind: "theatres", since: cinema.date, digital: next?.date ?? null, platform: platformOf(next), regional };
    }

    const outAlready = list.some((x) => x.type !== 1 && x.date <= today && (x.type !== 2 || cinemaTypes.has(2)));
    const futureCinema = list.filter((x) => cinemaTypes.has(x.type) && x.date > today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
    const futureHome = list.filter((x) => HOME.has(x.type) && x.date > today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;

    if (!outAlready && (futureCinema || futureHome)) {
      // A streaming premiere with a limited cinema run around the same time is a streaming release.
      const streamingFirst =
        futureHome?.type === DIGITAL && (!futureCinema || (futureCinema.type === 2 && Math.abs(daysBetween(futureCinema.date, futureHome.date)) <= 30));
      if (streamingFirst || !futureCinema) {
        const h = futureHome!;
        return {
          kind: "upcoming",
          date: h.date,
          days: daysBetween(today, h.date),
          channel: h.type === 6 ? "tv" : "digital",
          platform: platformOf(h),
          digital: null,
          alsoInCinemas: !!futureCinema,
          regional,
          label: null,
        };
      }
      const laterHome = futureHome && futureHome.date > futureCinema.date ? futureHome : null;
      return {
        kind: "upcoming",
        date: futureCinema.date,
        days: daysBetween(today, futureCinema.date),
        channel: "cinemas",
        platform: platformOf(laterHome),
        digital: laterHome?.date ?? null,
        alsoInCinemas: false,
        regional,
        label: null,
      };
    }

    // No release-date data: TMDB's primary date, without assuming how it's released.
    if (!all.length && d.releaseDate && d.releaseDate > today) {
      return { kind: "upcoming", date: d.releaseDate, days: daysBetween(today, d.releaseDate), channel: "unknown", platform: null, digital: null, alsoInCinemas: false, regional: false, label: null };
    }
    if (!all.length && !d.releaseDate && d.status && ["Planned", "In Production", "Post Production", "Rumored"].includes(d.status)) {
      return { kind: "upcoming", date: null, days: null, channel: "unknown", platform: null, digital: null, alsoInCinemas: false, regional: false, label: d.status };
    }
    return { kind: "none" };
  }

  // Series
  const first = d.releaseDate ?? null;
  if (first && first > today) {
    return { kind: "upcoming", date: first, days: daysBetween(today, first), channel: "tv", platform: null, digital: null, alsoInCinemas: false, regional: false, label: "Series premiere" };
  }
  if (!first && d.status && d.status !== "Ended" && d.status !== "Canceled") {
    return { kind: "upcoming", date: null, days: null, channel: "tv", platform: null, digital: null, alsoInCinemas: false, regional: false, label: d.status === "Returning Series" ? "Premiere" : d.status };
  }
  const next = d.nextEpisodeToAir;
  if (next?.airDate && next.airDate >= today) {
    return {
      kind: "airing",
      date: next.airDate,
      days: daysBetween(today, next.airDate),
      label: next.episodeNumber === 1 ? `Season ${next.seasonNumber} premiere` : `S${next.seasonNumber} E${next.episodeNumber}${next.name && !/^Episode \d+$/.test(next.name) ? ` · ${next.name}` : ""}`,
    };
  }
  return { kind: "none" };
}
