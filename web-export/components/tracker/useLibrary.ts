"use client";
import { useMemo } from "react";
import { useTracker } from "@/components/tracker/TrackerProvider";
import { useSummaries } from "@/components/tracker/useSummaries";
import { daysUntil } from "@/lib/media";
import type { TitleSummary } from "@/lib/tmdb";
import { episodeRuntimeKey, itemKey, movieRuntimeKey, parseEpKey, showProgress, trackedItems, type ShowProgress } from "@/lib/tracker";

/** Used only when TMDB has no runtime for a title at all. */
const FALLBACK_MOVIE_MINUTES = 110;
const FALLBACK_EPISODE_MINUTES = 45;

export interface LibraryShow {
  key: string;
  title: TitleSummary;
  progress: ShowProgress;
  lastWatchedAt: string | null;
  inWatchlist: boolean;
}
export interface LibraryMovie {
  key: string;
  title: TitleSummary;
  watchedAt: string | null;
  inWatchlist: boolean;
}
export interface UpcomingItem {
  key: string;
  title: TitleSummary;
  date: string;
  days: number;
  label: string; // "S3 E4 · Episode name" or "Release"
}

const latest = (m: Record<string, string> | undefined) => (m ? Object.values(m).reduce<string | null>((a, b) => (!a || b > a ? b : a), null) : null);

/** Everything the Library / Upcoming / Home rows need, joined with TMDB summaries. */
export function useLibrary() {
  const t = useTracker();
  const keys = useMemo(() => trackedItems(t.data).map((x) => itemKey(x.mediaType, x.id)), [t.data]);
  const { titles, loading } = useSummaries(keys);

  return useMemo(() => {
    const shows: LibraryShow[] = [];
    const movies: LibraryMovie[] = [];
    for (const key of keys) {
      const title = titles.get(key);
      if (!title) continue;
      const inWatchlist = !!t.data.watchlist[key];
      if (title.mediaType === "tv") {
        const eps = t.data.episodes[title.id];
        shows.push({ key, title, progress: showProgress(title, eps), lastWatchedAt: latest(eps), inWatchlist });
      } else {
        movies.push({ key, title, watchedAt: t.data.movies[title.id] ?? null, inWatchlist });
      }
    }
    const byRecent = <T extends { lastWatchedAt?: string | null; watchedAt?: string | null }>(a: T, b: T) =>
      (b.lastWatchedAt ?? b.watchedAt ?? "").localeCompare(a.lastWatchedAt ?? a.watchedAt ?? "");

    const upNext = shows.filter((s) => s.progress.started && s.progress.next).sort(byRecent);
    const watching = shows.filter((s) => s.progress.started && !(s.progress.caughtUp && s.progress.ended)).sort(byRecent);
    const finishedShows = shows.filter((s) => s.progress.caughtUp && s.progress.ended).sort(byRecent);
    const watchedMovies = movies.filter((m) => m.watchedAt).sort(byRecent);
    const watchlist = [...shows.filter((s) => s.inWatchlist && !s.progress.started), ...movies.filter((m) => m.inWatchlist && !m.watchedAt)].sort((a, b) =>
      (t.data.watchlist[b.key] ?? "").localeCompare(t.data.watchlist[a.key] ?? ""),
    );

    const upcoming: UpcomingItem[] = [];
    for (const s of shows) {
      const n = s.title.nextEpisode;
      const days = daysUntil(n?.airDate);
      if (n?.airDate && days != null && days >= 0) {
        upcoming.push({ key: s.key, title: s.title, date: n.airDate, days, label: `S${n.season} E${n.episode}${n.name && !/^Episode \d+$/.test(n.name) ? ` · ${n.name}` : ""}` });
      }
    }
    for (const m of movies) {
      if (m.watchedAt) continue;
      // The region's own release (in cinemas / digital), else TMDB's primary date if still ahead.
      const rel = m.title.upcomingRelease;
      const date = rel?.date ?? (m.title.releaseDate && (daysUntil(m.title.releaseDate) ?? -1) >= 0 ? m.title.releaseDate : null);
      const days = daysUntil(date);
      if (date && days != null && days >= 0) upcoming.push({ key: m.key, title: m.title, date, days, label: rel?.label ?? "Release" });
    }
    upcoming.sort((a, b) => a.date.localeCompare(b.date));

    // My Library: every aired episode watched = Completed (also a caught-up returning series);
    // anything less = Ongoing. Both newest activity first.
    const started = shows.filter((s) => s.progress.started).sort(byRecent);
    const completed = started.filter((s) => s.progress.airedTotal > 0 && s.progress.watchedAired >= s.progress.airedTotal);
    const ongoing = started.filter((s) => !completed.includes(s));

    // Watch-time stats: each title's runtime recorded when it was marked; for older entries the
    // title's TMDB runtime (a series' typical episode length); a default only as the last resort.
    let minutes = 0;
    let estimated = 0;
    const movieIds = Object.keys(t.data.movies);
    for (const id of movieIds) {
      const mins = t.data.runtimes[movieRuntimeKey(id)] ?? titles.get(itemKey("movie", Number(id)))?.runtime ?? null;
      if (mins == null) estimated++;
      minutes += mins ?? FALLBACK_MOVIE_MINUTES;
    }
    let episodeCount = 0;
    for (const [id, eps] of Object.entries(t.data.episodes)) {
      const typical = titles.get(itemKey("tv", Number(id)))?.runtime ?? null;
      for (const k of Object.keys(eps)) {
        const { season, episode } = parseEpKey(k);
        const mins = t.data.runtimes[episodeRuntimeKey(id, season, episode)] ?? typical;
        if (mins == null) estimated++;
        minutes += mins ?? FALLBACK_EPISODE_MINUTES;
        episodeCount++;
      }
    }
    const stats = { minutes, movies: movieIds.length, episodes: episodeCount, estimated };

    return { ready: t.status !== "loading" && !loading, empty: keys.length === 0, upNext, watching, finishedShows, watchedMovies, watchlist, upcoming, ongoing, completed, stats };
  }, [keys, titles, loading, t.data, t.status]);
}
