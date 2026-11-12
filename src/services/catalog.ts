/**
 * Higher-level catalog queries composed from the TMDB client: hub feeds, region detection,
 * provider preference ordering, and "what to play next" for a series.
 */
import { hubRule } from "../config/hubsRegistry";
import {
  collectionParts,
  discover,
  searchKeywordId,
  type CatalogContext,
  type MediaSummary,
  type Paged,
} from "./tmdbClient";
import { providerFamily } from "../lib/providers";
import type { CustomHub, MediaType, ResolvedLink, SubscribedProvider, WatchHistoryEntry } from "./tauriBridge";

// ---------------------------------------------------------------------------------------------
// Region detection (IP geolocation; only the request IP is visible to the service)
// ---------------------------------------------------------------------------------------------

export async function detectRegionByIp(): Promise<string | null> {
  const attempts: [string, (j: Record<string, unknown>) => unknown][] = [
    ["https://ipwho.is/?fields=success,country_code", (j) => (j.success ? j.country_code : null)],
    ["http://ip-api.com/json/?fields=status,countryCode", (j) => (j.status === "success" ? j.countryCode : null)],
  ];
  for (const [url, pick] of attempts) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const code = pick((await res.json()) as Record<string, unknown>);
      if (typeof code === "string" && /^[A-Z]{2}$/.test(code)) return code;
    } catch {
      /* try the next endpoint */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Hub feeds
// ---------------------------------------------------------------------------------------------

export interface HubFacets {
  mediaType: "all" | MediaType;
  runtime: "any" | "short" | "epic";
  era: "any" | "2020s" | "2010s" | "2000s" | "1990s" | "classic";
  language: "any" | string;
  kidsSafe: boolean;
}

export const DEFAULT_FACETS: HubFacets = { mediaType: "all", runtime: "any", era: "any", language: "any", kidsSafe: false };

const ERA_RANGES: Record<Exclude<HubFacets["era"], "any">, [string, string]> = {
  "2020s": ["2020-01-01", "2029-12-31"],
  "2010s": ["2010-01-01", "2019-12-31"],
  "2000s": ["2000-01-01", "2009-12-31"],
  "1990s": ["1990-01-01", "1999-12-31"],
  classic: ["1900-01-01", "1989-12-31"],
};

/** Facet filters as discover params (shared by hubs and provider rows). */
export function facetParams(mt: MediaType, f: HubFacets): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.runtime === "short") p["with_runtime.lte"] = "90";
  if (f.runtime === "epic") p["with_runtime.gte"] = "150";
  if (f.era !== "any") {
    const [from, to] = ERA_RANGES[f.era];
    const field = mt === "movie" ? "primary_release_date" : "first_air_date";
    p[`${field}.gte`] = from;
    p[`${field}.lte`] = to;
  }
  if (f.language !== "any") p.with_original_language = f.language;
  return p;
}

const keywordIdCache = new Map<string, Promise<number | null>>();
const keywordId = (q: string) => {
  if (!keywordIdCache.has(q)) keywordIdCache.set(q, searchKeywordId(q).catch(() => null));
  return keywordIdCache.get(q)!;
};

/** Discover params for one media type of a hub, or null if the hub doesn't cover that type. */
async function hubDiscoverParams(h: CustomHub, mt: MediaType): Promise<Record<string, string> | null> {
  const rule = hubRule(h);
  const base = rule[mt];
  if (base === undefined || base === null) return null;
  const params: Record<string, string> = { ...base };
  if (rule.keywordQueries?.length) {
    const ids = (await Promise.all(rule.keywordQueries.map(keywordId))).filter((x): x is number => x !== null);
    if (ids.length) {
      params.with_keywords = [params.with_keywords, ...ids.map(String)].filter(Boolean).join("|");
    }
  }
  // Never run an unfiltered discover (e.g. keyword lookup failed): that would be "everything".
  const filtering = Object.keys(params).some((k) => k.startsWith("with_"));
  return filtering ? params : null;
}

export interface HubPage extends Paged<MediaSummary> {
  pinned: MediaSummary[];
}

/** One page of a hub feed: collections (page 1 only) + interleaved movie/tv discover results. */
export async function loadHubPage(h: CustomHub, ctx: CatalogContext, facets: HubFacets, page: number): Promise<HubPage> {
  const rule = hubRule(h);
  const effectiveCtx = { ...ctx, kids: ctx.kids || facets.kidsSafe || !!rule.kidsSafe };
  const types: MediaType[] = facets.mediaType === "all" ? ["movie", "tv"] : [facets.mediaType];

  const pinned: MediaSummary[] =
    page === 1 && facets.mediaType !== "tv" && rule.collections?.length
      ? (await Promise.all(rule.collections.map((c) => collectionParts(c).catch(() => []))))
          .flat()
          .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
      : [];

  const pages = await Promise.all(
    types.map(async (mt) => {
      const params = await hubDiscoverParams(h, mt);
      if (!params) return null;
      if (mt === "tv" && facets.runtime !== "any") return null;
      return discover(mt, effectiveCtx, { ...params, ...facetParams(mt, facets) }, page).catch(() => null);
    }),
  );
  const valid = pages.filter((p): p is Paged<MediaSummary> => !!p);
  const results: MediaSummary[] = [];
  const longest = Math.max(0, ...valid.map((p) => p.results.length));
  for (let i = 0; i < longest; i++) for (const p of valid) {
    const item = p.results[i];
    if (item) results.push(item);
  }

  const pinnedKeys = new Set(pinned.map((m) => `${m.mediaType}-${m.id}`));
  return {
    page,
    totalPages: Math.max(page, ...valid.map((p) => p.totalPages)),
    pinned,
    results: results.filter((m) => !pinnedKeys.has(`${m.mediaType}-${m.id}`)),
  };
}

// ---------------------------------------------------------------------------------------------
// Playback helpers
// ---------------------------------------------------------------------------------------------

const MONETIZATION_RANK: Record<string, number> = { flatrate: 0, free: 1, ads: 2, rent: 3, buy: 4, search: 5 };

/** Orders resolved links: subscribed streaming first, direct links before search fallbacks. */
const subscribedFamilies = (subs: SubscribedProvider[]) =>
  new Set(subs.filter((s) => s.isActive).map((s) => providerFamily(s.providerId, s.providerName).key));

export function rankLinks(links: ResolvedLink[], subs: SubscribedProvider[]): ResolvedLink[] {
  const families = subscribedFamilies(subs);
  const subscribed = (l: ResolvedLink) => families.has(providerFamily(l.providerId, l.providerName).key);
  return [...links].sort(
    (a, b) =>
      Number(subscribed(b)) - Number(subscribed(a)) ||
      (MONETIZATION_RANK[a.monetizationType] ?? 9) - (MONETIZATION_RANK[b.monetizationType] ?? 9) ||
      Number(a.isFallback) - Number(b.isFallback) ||
      a.providerName.localeCompare(b.providerName),
  );
}

/** Subscription checks are per family: a "Prime Video" subscription covers "Prime Video with Ads". */
export const isSubscribedLink = (l: ResolvedLink, subs: SubscribedProvider[]) =>
  subscribedFamilies(subs).has(providerFamily(l.providerId, l.providerName).key);

export interface LinkGroup {
  key: string;
  name: string;
  /** Best link for the family (links arrive ranked). */
  primary: ResolvedLink;
  /** Other monetisation options of the same family (e.g. Rent / Buy). */
  alternatives: ResolvedLink[];
}

/** Collapses "Amazon Prime Video", "... with Ads", "Amazon Video" into one "Prime Video" option. */
export function groupLinks(ranked: ResolvedLink[]): LinkGroup[] {
  const groups = new Map<string, LinkGroup>();
  for (const l of ranked) {
    const fam = providerFamily(l.providerId, l.providerName);
    const g = groups.get(fam.key);
    if (g) g.alternatives.push(l);
    else groups.set(fam.key, { key: fam.key, name: fam.name, primary: l, alternatives: [] });
  }
  return [...groups.values()];
}

/**
 * The episode to start for a series: resume an unfinished episode, otherwise the one after the
 * latest finished episode, otherwise S1E1.
 */
export function nextEpisode(
  progress: WatchHistoryEntry[],
  seasons: { seasonNumber: number; episodeCount: number }[],
): { seasonNumber: number; episodeNumber: number; resume: boolean } {
  const watched = progress.filter((p) => p.episodeNumber > 0);
  const latest = [...watched].sort((a, b) => b.lastWatchedAt.localeCompare(a.lastWatchedAt))[0];
  const firstSeason = seasons.find((s) => s.seasonNumber > 0)?.seasonNumber ?? 1;
  if (!latest) return { seasonNumber: firstSeason, episodeNumber: 1, resume: false };
  if (!latest.isCompleted) return { seasonNumber: latest.seasonNumber, episodeNumber: latest.episodeNumber, resume: true };
  const season = seasons.find((s) => s.seasonNumber === latest.seasonNumber);
  if (season && latest.episodeNumber < season.episodeCount) {
    return { seasonNumber: latest.seasonNumber, episodeNumber: latest.episodeNumber + 1, resume: false };
  }
  const next = seasons.find((s) => s.seasonNumber === latest.seasonNumber + 1);
  return next
    ? { seasonNumber: next.seasonNumber, episodeNumber: 1, resume: false }
    : { seasonNumber: latest.seasonNumber, episodeNumber: latest.episodeNumber, resume: false };
}
