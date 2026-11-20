/**
 * My Library data (desktop): the profile's local SQLite history and watchlist — OTT-synced rows
 * from the smart player and history importer, hand-made "Mark as Watched" rows and anything the
 * optional cloud sync brought in — joined with TMDB title summaries. Same rules as the web
 * tracker (web-export/components/tracker/useLibrary.ts), so both apps show the same library.
 *
 * Watched = a completed history row (a movie at S0 E0, an episode at its S/E). The stats count
 * only those. Shelves are wider: a series is started (Ongoing) as soon as any of its rows is
 * finished or has real progress, including an episode still playing and an episode the importer
 * couldn't match to a number (stored at episode 0, e.g. when TMDB only has "Episode 1…" names);
 * a movie that's been started shows in Tracked Movies with its progress.
 */
import { useEffect, useMemo, useState } from "react";
import { useAsync } from "../../lib/hooks";
import { daysUntil } from "../../lib/dates";
import { epKey, showProgress, type ShowProgress } from "../../lib/tracker";
import { cachedSummary, loadSummaries, type TitleSummary } from "../../services/librarySummary";
import { history, type MediaType, type WatchHistoryEntry } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";

/** Used only when neither the history row nor TMDB has a runtime. */
const FALLBACK_MOVIE_MINUTES = 110;
const FALLBACK_EPISODE_MINUTES = 45;

/** The series' latest activity, for the card's subtitle. */
export interface CurrentEpisode {
  season: number;
  /** 0 when the episode couldn't be matched to a number. */
  episode: number;
  name: string | null;
  completed: boolean;
  /** 0..1 for an episode still in progress. */
  ratio: number;
}
export interface LibraryShow {
  key: string;
  title: TitleSummary;
  progress: ShowProgress;
  lastWatchedAt: string | null;
  inWatchlist: boolean;
  current: CurrentEpisode | null;
}
export interface LibraryMovie {
  key: string;
  title: TitleSummary;
  /** Set once the movie is finished. */
  watchedAt: string | null;
  /** Started but not finished: progress 0..1 and when. */
  inProgress: { ratio: number; at: string } | null;
  inWatchlist: boolean;
}
export interface UpcomingItem {
  key: string;
  title: TitleSummary;
  date: string;
  days: number;
  label: string;
}
export interface WatchStats {
  minutes: number;
  movies: number;
  episodes: number;
  /** Entries whose runtime is an estimate. */
  estimated: number;
  /** Watches the importer couldn't match to an episode number (not counted above). */
  unplaced: number;
}

const keyOf = (t: MediaType, id: number) => `${t}:${id}`;
/** A real runtime recorded with the row (1 s = unknown, as in hand-made marks). */
const rowMinutes = (r: WatchHistoryEntry) => (r.durationSeconds > 60 ? Math.round(r.durationSeconds / 60) : null);

interface LocalState {
  watchlist: Map<string, string>;
  movies: Map<number, WatchHistoryEntry>;
  /** Movies started but not finished. */
  moviesInProgress: Map<number, WatchHistoryEntry>;
  /** Series id → `${season}:${episode}` → completed row. */
  episodes: Map<number, Map<string, WatchHistoryEntry>>;
  /** Latest activity (any row, finished or not) per title key. */
  lastActivity: Map<string, string>;
  /** Latest episode row per series (placed or not). */
  latestEpisode: Map<number, WatchHistoryEntry>;
  startedSeries: Set<number>;
  /** Completed episode rows without an episode number. */
  unplaced: number;
}

/** Real playback, not a 2-second accidental open (same 30 s floor as Continue Watching). */
const MIN_PROGRESS_SECONDS = 30;

function indexHistory(rows: WatchHistoryEntry[], watchlist: { tmdbId: number; mediaType: MediaType; addedAt: string }[]): LocalState {
  const st: LocalState = {
    watchlist: new Map(),
    movies: new Map(),
    moviesInProgress: new Map(),
    episodes: new Map(),
    lastActivity: new Map(),
    latestEpisode: new Map(),
    startedSeries: new Set(),
    unplaced: 0,
  };
  for (const w of watchlist) st.watchlist.set(keyOf(w.mediaType, w.tmdbId), w.addedAt);
  const newer = (a: WatchHistoryEntry | undefined, b: WatchHistoryEntry) => !a || a.lastWatchedAt < b.lastWatchedAt || (a.lastWatchedAt === b.lastWatchedAt && a.id < b.id);
  for (const r of rows) {
    const active = r.isCompleted || r.progressSeconds >= MIN_PROGRESS_SECONDS;
    if (!active) continue;
    const k = keyOf(r.mediaType, r.tmdbId);
    if ((st.lastActivity.get(k) ?? "") < r.lastWatchedAt) st.lastActivity.set(k, r.lastWatchedAt);
    if (r.mediaType === "movie") {
      if (r.isCompleted) st.movies.set(r.tmdbId, r);
      else if (newer(st.moviesInProgress.get(r.tmdbId), r)) st.moviesInProgress.set(r.tmdbId, r);
      continue;
    }
    // Series: every active row starts it, placed (S/E known) or not.
    st.startedSeries.add(r.tmdbId);
    if (newer(st.latestEpisode.get(r.tmdbId), r)) st.latestEpisode.set(r.tmdbId, r);
    if (!r.isCompleted) continue;
    if (r.episodeNumber > 0) {
      let m = st.episodes.get(r.tmdbId);
      if (!m) st.episodes.set(r.tmdbId, (m = new Map()));
      m.set(epKey(r.seasonNumber, r.episodeNumber), r);
    } else {
      st.unplaced++;
    }
  }
  // Finished after all: not "in progress" any more.
  for (const id of st.movies.keys()) st.moviesInProgress.delete(id);
  return st;
}

export function useLibrary() {
  const profileId = useAppStore((s) => s.activeProfile?.profileId);
  const region = useAppStore((s) => s.region);
  const watchlistItems = useAppStore((s) => s.watchlist);
  const version = useAppStore((s) => s.libraryVersion);
  const rows = useAsync(() => history.exportAll(profileId!), [profileId, version], !!profileId);

  const local = useMemo(() => (rows.data ? indexHistory(rows.data, watchlistItems) : null), [rows.data, watchlistItems]);
  const keys = useMemo(() => {
    if (!local) return [];
    const set = new Set<string>(local.watchlist.keys());
    for (const id of local.movies.keys()) set.add(keyOf("movie", id));
    for (const id of local.moviesInProgress.keys()) set.add(keyOf("movie", id));
    for (const id of local.startedSeries) set.add(keyOf("tv", id));
    return [...set];
  }, [local]);

  // Title summaries (cached across visits); re-render as batches arrive.
  const [tick, setTick] = useState(0);
  const [loadingSummaries, setLoadingSummaries] = useState(false);
  const sig = keys.join(",");
  useEffect(() => {
    if (!keys.length) return;
    let alive = true;
    setLoadingSummaries(true);
    void loadSummaries(keys, region, () => alive && setTick((n) => n + 1)).finally(() => alive && setLoadingSummaries(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, region]);

  return useMemo(() => {
    const shows: LibraryShow[] = [];
    const movies: LibraryMovie[] = [];
    let pending = 0;
    if (local) {
      for (const key of keys) {
        const title = cachedSummary(region, key);
        if (title === undefined) pending++;
        if (!title) continue;
        const inWatchlist = local.watchlist.has(key);
        if (title.mediaType === "tv") {
          const eps = local.episodes.get(title.id);
          const watched: Record<string, string> = {};
          for (const [k, r] of eps ?? []) watched[k] = r.lastWatchedAt;
          const progress = showProgress(title, watched);
          // An episode still playing, or one the importer couldn't number, still means started.
          if (local.startedSeries.has(title.id)) progress.started = true;
          const latest = local.latestEpisode.get(title.id);
          const current: CurrentEpisode | null = latest
            ? {
                season: latest.seasonNumber,
                episode: latest.episodeNumber,
                name: latest.episodeTitle,
                completed: latest.isCompleted,
                ratio: latest.isCompleted ? 1 : Math.min(0.99, latest.completionRatio),
              }
            : null;
          shows.push({ key, title, progress, lastWatchedAt: local.lastActivity.get(key) ?? null, inWatchlist, current });
        } else {
          const p = local.moviesInProgress.get(title.id);
          movies.push({
            key,
            title,
            watchedAt: local.movies.get(title.id)?.lastWatchedAt ?? null,
            inProgress: p ? { ratio: Math.min(0.99, p.completionRatio), at: p.lastWatchedAt } : null,
            inWatchlist,
          });
        }
      }
    }
    const byRecent = <T extends { lastWatchedAt?: string | null; watchedAt?: string | null }>(a: T, b: T) =>
      (b.lastWatchedAt ?? b.watchedAt ?? "").localeCompare(a.lastWatchedAt ?? a.watchedAt ?? "");

    const addedAt = (k: string) => local?.watchlist.get(k) ?? "";
    const watchlist = [...shows.filter((s) => s.inWatchlist && !s.progress.started), ...movies.filter((m) => m.inWatchlist && !m.watchedAt && !m.inProgress)].sort((a, b) =>
      addedAt(b.key).localeCompare(addedAt(a.key)),
    );

    const upcoming: UpcomingItem[] = [];
    for (const s of shows) {
      const n = s.title.nextEpisode;
      const days = daysUntil(n?.airDate);
      // Series you follow (started) or saved.
      if ((s.progress.started || s.inWatchlist) && n?.airDate && days != null && days >= 0) {
        upcoming.push({ key: s.key, title: s.title, date: n.airDate, days, label: `S${n.season} E${n.episode}${n.name && !/^Episode \d+$/.test(n.name) ? ` · ${n.name}` : ""}` });
      }
    }
    for (const m of movies) {
      if (m.watchedAt || !m.inWatchlist) continue;
      const rel = m.title.upcomingRelease;
      const date = rel?.date ?? (m.title.releaseDate && (daysUntil(m.title.releaseDate) ?? -1) >= 0 ? m.title.releaseDate : null);
      const days = daysUntil(date);
      if (date && days != null && days >= 0) upcoming.push({ key: m.key, title: m.title, date, days, label: rel?.label ?? "Release" });
    }
    upcoming.sort((a, b) => a.date.localeCompare(b.date));

    const started = shows.filter((s) => s.progress.started).sort(byRecent);
    // Completed = every aired episode finished and nothing newer still playing.
    const completed = started.filter(
      (s) => s.progress.airedTotal > 0 && s.progress.watchedAired >= s.progress.airedTotal && (!s.current || (s.current.completed && s.current.episode > 0)),
    );
    const ongoing = started.filter((s) => !completed.includes(s));
    const movieAt = (m: LibraryMovie) => m.watchedAt ?? m.inProgress?.at ?? "";
    const watchedMovies = movies.filter((m) => m.watchedAt || m.inProgress).sort((a, b) => movieAt(b).localeCompare(movieAt(a)));

    // Watch time from real runtimes: the played duration recorded with each row (OTT player /
    // importer / hand-made marks with a runtime), else TMDB's runtime, a default only as a last resort.
    // Strictly finished watches: in-progress rows and unnumbered episodes aren't counted.
    const stats: WatchStats = { minutes: 0, movies: 0, episodes: 0, estimated: 0, unplaced: local?.unplaced ?? 0 };
    if (local) {
      for (const [id, r] of local.movies) {
        const mins = rowMinutes(r) ?? cachedSummary(region, keyOf("movie", id))?.runtime ?? null;
        if (mins == null) stats.estimated++;
        stats.minutes += mins ?? FALLBACK_MOVIE_MINUTES;
        stats.movies++;
      }
      for (const [id, eps] of local.episodes) {
        const typical = cachedSummary(region, keyOf("tv", id))?.runtime ?? null;
        for (const r of eps.values()) {
          const mins = rowMinutes(r) ?? typical;
          if (mins == null) stats.estimated++;
          stats.minutes += mins ?? FALLBACK_EPISODE_MINUTES;
          stats.episodes++;
        }
      }
    }

    return {
      ready: !!local && !rows.loading && (!loadingSummaries || pending === 0),
      error: rows.error,
      watchlist,
      upcoming,
      ongoing,
      completed,
      watchedMovies,
      stats,
      seriesCount: local?.episodes.size ?? 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, keys, region, tick, loadingSummaries, rows.loading, rows.error]);
}
