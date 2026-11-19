"use client";
/**
 * Signed-in persistence: the user's own rows in Supabase (supabase/schema.sql, RLS-limited to
 * auth.uid()). Watched movies are watch_history rows at season 0 / episode 0 and watched episodes
 * are rows at their season / episode, exactly like the desktop app's "Mark as Watched".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaType } from "@/lib/media";
import { emptyData, epKey, episodeRuntimeKey, itemKey, movieRuntimeKey, parseEpKey, parseItemKey, validRuntime, type TrackerData } from "@/lib/tracker";

const PAGE = 1000;
const HISTORY_CONFLICT = "profile_id,tmdb_id,media_type,season_number,episode_number";

export interface CloudCtx {
  sb: SupabaseClient;
  userId: string;
  profileId: number;
}

/** The user's first profile (the sign-up trigger creates one; make it if the trigger isn't installed). */
export async function resolveProfile(sb: SupabaseClient, userId: string, email: string | null): Promise<number> {
  const { data, error } = await sb.from("app_profiles").select("profile_id").order("profile_id").limit(1).maybeSingle();
  if (error) throw error;
  if (data) return data.profile_id as number;
  const name = (email?.split("@")[0] || "Me").slice(0, 32);
  const { data: created, error: insErr } = await sb.from("app_profiles").insert({ user_id: userId, profile_name: name }).select("profile_id").single();
  if (insErr) throw insErr;
  return created.profile_id as number;
}

async function all<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

type WatchlistRow = { tmdb_id: number; media_type: MediaType; added_at: string };
type HistoryRow = { tmdb_id: number; media_type: MediaType; season_number: number; episode_number: number; last_watched_at: string; duration_seconds: number | null };

export async function loadCloud({ sb, profileId }: CloudCtx): Promise<TrackerData> {
  const [wl, hist] = await Promise.all([
    all<WatchlistRow>((a, b) => sb.from("watchlist").select("tmdb_id, media_type, added_at").eq("profile_id", profileId).order("added_at").range(a, b)),
    all<HistoryRow>((a, b) =>
      sb
        .from("watch_history")
        .select("tmdb_id, media_type, season_number, episode_number, last_watched_at, duration_seconds")
        .eq("profile_id", profileId)
        .eq("is_completed", true)
        .order("id")
        .range(a, b),
    ),
  ]);
  const d = emptyData();
  for (const r of wl) d.watchlist[itemKey(r.media_type, r.tmdb_id)] = r.added_at;
  for (const r of hist) {
    // duration_seconds holds the TMDB runtime (1 = unknown, as in older rows).
    const mins = r.duration_seconds && r.duration_seconds > 60 ? validRuntime(r.duration_seconds / 60) : undefined;
    if (r.media_type === "movie") {
      d.movies[r.tmdb_id] = r.last_watched_at;
      if (mins) d.runtimes[movieRuntimeKey(r.tmdb_id)] = mins;
    } else if (r.episode_number > 0) {
      (d.episodes[r.tmdb_id] ??= {})[epKey(r.season_number, r.episode_number)] = r.last_watched_at;
      if (mins) d.runtimes[episodeRuntimeKey(r.tmdb_id, r.season_number, r.episode_number)] = mins;
    }
  }
  return d;
}

const check = ({ error }: { error: unknown }) => {
  if (error) throw error;
};

export async function addWatchlist(c: CloudCtx, mediaType: MediaType, id: number, at: string) {
  check(await c.sb.from("watchlist").upsert({ user_id: c.userId, profile_id: c.profileId, tmdb_id: id, media_type: mediaType, added_at: at }, { onConflict: "profile_id,tmdb_id,media_type" }));
}

export async function removeWatchlist(c: CloudCtx, mediaType: MediaType, id: number) {
  check(await c.sb.from("watchlist").delete().eq("profile_id", c.profileId).eq("tmdb_id", id).eq("media_type", mediaType));
}

/** A completed watch: progress = duration = the TMDB runtime (1 s when unknown). */
const historyRow = (c: CloudCtx, mediaType: MediaType, id: number, season: number, episode: number, at: string, runtimeMins?: number) => ({
  user_id: c.userId,
  profile_id: c.profileId,
  tmdb_id: id,
  media_type: mediaType,
  season_number: season,
  episode_number: episode,
  progress_seconds: runtimeMins ? runtimeMins * 60 : 1,
  duration_seconds: runtimeMins ? runtimeMins * 60 : 1,
  is_completed: true,
  last_watched_at: at,
});

async function upsertHistory(c: CloudCtx, rows: ReturnType<typeof historyRow>[]) {
  for (let i = 0; i < rows.length; i += 500) check(await c.sb.from("watch_history").upsert(rows.slice(i, i + 500), { onConflict: HISTORY_CONFLICT }));
}

export async function setMovieWatched(c: CloudCtx, id: number, at: string | null, runtimeMins?: number) {
  if (at) await upsertHistory(c, [historyRow(c, "movie", id, 0, 0, at, runtimeMins)]);
  else check(await c.sb.from("watch_history").delete().eq("profile_id", c.profileId).eq("tmdb_id", id).eq("media_type", "movie"));
}

export async function setEpisodesWatched(c: CloudCtx, id: number, eps: { season: number; episode: number; runtime?: number | null }[], at: string | null) {
  if (at) return upsertHistory(c, eps.map((e) => historyRow(c, "tv", id, e.season, e.episode, at, validRuntime(e.runtime))));
  const bySeason = new Map<number, number[]>();
  for (const e of eps) bySeason.set(e.season, [...(bySeason.get(e.season) ?? []), e.episode]);
  for (const [season, list] of bySeason) {
    check(await c.sb.from("watch_history").delete().eq("profile_id", c.profileId).eq("tmdb_id", id).eq("media_type", "tv").eq("season_number", season).in("episode_number", list));
  }
}

/** Uploads a whole library (guest data on sign-in, or an imported file). */
export async function pushAll(c: CloudCtx, d: TrackerData) {
  const wl = Object.entries(d.watchlist).flatMap(([k, at]) => {
    const p = parseItemKey(k);
    return p ? [{ user_id: c.userId, profile_id: c.profileId, tmdb_id: p.id, media_type: p.mediaType, added_at: at }] : [];
  });
  for (let i = 0; i < wl.length; i += 500) check(await c.sb.from("watchlist").upsert(wl.slice(i, i + 500), { onConflict: "profile_id,tmdb_id,media_type" }));
  const rows = [
    ...Object.entries(d.movies).map(([id, at]) => historyRow(c, "movie", Number(id), 0, 0, at, d.runtimes[movieRuntimeKey(id)])),
    ...Object.entries(d.episodes).flatMap(([id, eps]) =>
      Object.entries(eps).map(([k, at]) => {
        const { season, episode } = parseEpKey(k);
        return historyRow(c, "tv", Number(id), season, episode, at, d.runtimes[episodeRuntimeKey(id, season, episode)]);
      }),
    ),
  ];
  await upsertHistory(c, rows);
}

/** "Clear my library": the web tracker's own rows (watchlist and completed history). */
export async function clearCloud(c: CloudCtx) {
  check(await c.sb.from("watchlist").delete().eq("profile_id", c.profileId));
  check(await c.sb.from("watch_history").delete().eq("profile_id", c.profileId).eq("is_completed", true));
}
