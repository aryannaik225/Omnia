/**
 * Series progress, shared with the web tracker (web-export/lib/tracker.ts): aired episodes from
 * TMDB's season sizes and latest aired episode, against the episodes this profile has watched
 * (`watched` is keyed `${season}:${episode}`).
 */

export const epKey = (season: number, episode: number) => `${season}:${episode}`;

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
  for (const ep of aired.slice(latest + 1)) {
    if (!w[epKey(ep.season, ep.episode)]) {
      next = ep;
      break;
    }
  }
  const ended = show.status === "Ended" || show.status === "Canceled";
  return { airedTotal: aired.length, watchedAired, next, started, caughtUp: started && !next && aired.length > 0, ended };
}
