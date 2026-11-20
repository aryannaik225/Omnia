"use client";
/**
 * Signed-in persistence: the user's own rows in Supabase (repo-root supabase/schema.sql, RLS-
 * limited to auth.uid()). The same tables are synced two-way by the desktop app, so the rules
 * here match it exactly:
 *
 * - `watchlist`, `tracked_movies`, `tracked_episodes` carry the device's `updated_at`; the
 *   server ignores a write older than the stored row (last-write-wins).
 * - Removing something writes a tombstone (`deleted_at`) instead of deleting the row, so the
 *   removal reaches the desktop too. Reads skip tombstones.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaType } from "@/lib/media";
import { avatarFileName } from "@/lib/avatar-image";
import { emptyData, epKey, episodeRuntimeKey, itemKey, movieRuntimeKey, parseEpKey, parseItemKey, validRuntime, type TrackerData } from "@/lib/tracker";

const PAGE = 1000;
const CHUNK = 500;
export const SYNC_TABLES = ["watchlist", "tracked_movies", "tracked_episodes", "profiles"] as const;

export interface CloudCtx {
  sb: SupabaseClient;
  userId: string;
}

export interface CloudProfile {
  displayName: string | null;
  avatarUrl: string | null;
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

const check = ({ error }: { error: unknown }) => {
  if (error) throw error;
};

type WatchlistRow = { tmdb_id: number; media_type: MediaType; added_at: string };
type MovieRow = { tmdb_id: number; watched_at: string; runtime_minutes: number | null };
type EpisodeRow = { tmdb_id: number; season_number: number; episode_number: number; watched_at: string; runtime_minutes: number | null };

export async function loadCloud({ sb }: CloudCtx): Promise<TrackerData> {
  const [wl, movies, eps] = await Promise.all([
    all<WatchlistRow>((a, b) => sb.from("watchlist").select("tmdb_id, media_type, added_at").is("deleted_at", null).order("added_at").order("tmdb_id").range(a, b)),
    all<MovieRow>((a, b) => sb.from("tracked_movies").select("tmdb_id, watched_at, runtime_minutes").is("deleted_at", null).order("tmdb_id").range(a, b)),
    all<EpisodeRow>((a, b) =>
      sb
        .from("tracked_episodes")
        .select("tmdb_id, season_number, episode_number, watched_at, runtime_minutes")
        .is("deleted_at", null)
        .order("tmdb_id")
        .order("season_number")
        .order("episode_number")
        .range(a, b),
    ),
  ]);
  const d = emptyData();
  for (const r of wl) d.watchlist[itemKey(r.media_type, r.tmdb_id)] = r.added_at;
  for (const r of movies) {
    d.movies[r.tmdb_id] = r.watched_at;
    const mins = validRuntime(r.runtime_minutes);
    if (mins) d.runtimes[movieRuntimeKey(r.tmdb_id)] = mins;
  }
  for (const r of eps) {
    (d.episodes[r.tmdb_id] ??= {})[epKey(r.season_number, r.episode_number)] = r.watched_at;
    const mins = validRuntime(r.runtime_minutes);
    if (mins) d.runtimes[episodeRuntimeKey(r.tmdb_id, r.season_number, r.episode_number)] = mins;
  }
  return d;
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

async function upsert(c: CloudCtx, table: string, rows: Record<string, unknown>[], onConflict: string) {
  for (let i = 0; i < rows.length; i += CHUNK) check(await c.sb.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict }));
}

const WL_CONFLICT = "user_id,tmdb_id,media_type";
const MOVIE_CONFLICT = "user_id,tmdb_id";
const EP_CONFLICT = "user_id,tmdb_id,season_number,episode_number";

export async function addWatchlist(c: CloudCtx, mediaType: MediaType, id: number, at: string) {
  await upsert(c, "watchlist", [{ user_id: c.userId, tmdb_id: id, media_type: mediaType, added_at: at, updated_at: at, deleted_at: null }], WL_CONFLICT);
}

export async function removeWatchlist(c: CloudCtx, mediaType: MediaType, id: number, at = new Date().toISOString()) {
  await upsert(c, "watchlist", [{ user_id: c.userId, tmdb_id: id, media_type: mediaType, updated_at: at, deleted_at: at }], WL_CONFLICT);
}

const movieRow = (c: CloudCtx, id: number, at: string, runtimeMins?: number, stamp = at) => ({
  user_id: c.userId,
  tmdb_id: id,
  media_type: "movie",
  status: "watched",
  runtime_minutes: runtimeMins ?? null,
  watched_at: at,
  updated_at: stamp,
  deleted_at: null,
});

const episodeRow = (c: CloudCtx, id: number, season: number, episode: number, at: string, runtimeMins?: number, stamp = at) => ({
  user_id: c.userId,
  tmdb_id: id,
  media_type: "tv",
  season_number: season,
  episode_number: episode,
  status: "watched",
  runtime_minutes: runtimeMins ?? null,
  watched_at: at,
  updated_at: stamp,
  deleted_at: null,
});

export async function setMovieWatched(c: CloudCtx, id: number, at: string | null, runtimeMins?: number) {
  if (at) return upsert(c, "tracked_movies", [movieRow(c, id, at, runtimeMins)], MOVIE_CONFLICT);
  const now = new Date().toISOString();
  return upsert(c, "tracked_movies", [{ user_id: c.userId, tmdb_id: id, media_type: "movie", updated_at: now, deleted_at: now }], MOVIE_CONFLICT);
}

export async function setEpisodesWatched(c: CloudCtx, id: number, eps: { season: number; episode: number; runtime?: number | null }[], at: string | null) {
  if (at) return upsert(c, "tracked_episodes", eps.map((e) => episodeRow(c, id, e.season, e.episode, at, validRuntime(e.runtime))), EP_CONFLICT);
  const now = new Date().toISOString();
  return upsert(
    c,
    "tracked_episodes",
    eps.map((e) => ({ user_id: c.userId, tmdb_id: id, media_type: "tv", season_number: e.season, episode_number: e.episode, updated_at: now, deleted_at: now })),
    EP_CONFLICT,
  );
}

/**
 * Uploads a whole library (guest data on sign-in, or an imported file). Each row keeps its own
 * timestamp as `updated_at`, so anything the account changed more recently (on the desktop or
 * another browser) wins and nothing newer is overwritten. `stamp` overrides `updated_at` (an
 * import that replaces the library must win).
 */
export async function pushAll(c: CloudCtx, d: TrackerData, stamp?: string) {
  const wl = Object.entries(d.watchlist).flatMap(([k, at]) => {
    const p = parseItemKey(k);
    return p ? [{ user_id: c.userId, tmdb_id: p.id, media_type: p.mediaType, added_at: at, updated_at: stamp ?? at, deleted_at: null }] : [];
  });
  await upsert(c, "watchlist", wl, WL_CONFLICT);
  await upsert(
    c,
    "tracked_movies",
    Object.entries(d.movies).map(([id, at]) => movieRow(c, Number(id), at, d.runtimes[movieRuntimeKey(id)], stamp ?? at)),
    MOVIE_CONFLICT,
  );
  await upsert(
    c,
    "tracked_episodes",
    Object.entries(d.episodes).flatMap(([id, eps]) =>
      Object.entries(eps).map(([k, at]) => {
        const { season, episode } = parseEpKey(k);
        return episodeRow(c, Number(id), season, episode, at, d.runtimes[episodeRuntimeKey(id, season, episode)], stamp ?? at);
      }),
    ),
    EP_CONFLICT,
  );
}

/** "Clear my library": tombstones every live row, so the desktop clears them too. */
export async function clearCloud(c: CloudCtx) {
  const now = new Date().toISOString();
  for (const table of ["watchlist", "tracked_movies", "tracked_episodes"]) {
    check(await c.sb.from(table).update({ updated_at: now, deleted_at: now }).eq("user_id", c.userId).is("deleted_at", null));
  }
}

// ---------------------------------------------------------------------------------------------
// Profile (display name + avatar URL)
// ---------------------------------------------------------------------------------------------

export async function loadProfile({ sb, userId }: CloudCtx): Promise<CloudProfile> {
  const { data, error } = await sb.from("profiles").select("display_name, avatar_url").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return { displayName: data?.display_name ?? null, avatarUrl: data?.avatar_url ?? null };
}

/**
 * Uploads an already-compressed 256×256 WebP to `avatars/<uid>/avatar.webp` and saves only its
 * public URL (cache-busted) in `profiles.avatar_url`.
 */
export async function uploadAvatar(c: CloudCtx, webp: Blob): Promise<string> {
  const path = `${c.userId}/${avatarFileName(webp)}`;
  const { error } = await c.sb.storage.from("avatars").upload(path, webp, { upsert: true, contentType: webp.type || "image/webp", cacheControl: "3600" });
  if (error) throw error;
  const { data } = c.sb.storage.from("avatars").getPublicUrl(path);
  const url = `${data.publicUrl}?v=${Date.now()}`;
  const now = new Date().toISOString();
  check(await c.sb.from("profiles").upsert({ user_id: c.userId, avatar_url: url, updated_at: now }, { onConflict: "user_id" }));
  return url;
}

/**
 * Deletes the account for good: the avatar files (Storage API), then the auth user, which
 * cascades to the profile and every synced row (supabase/schema.sql → delete_my_account).
 */
export async function deleteAccount(c: CloudCtx) {
  await c.sb.storage.from("avatars").remove([`${c.userId}/avatar.webp`, `${c.userId}/avatar.jpg`, `${c.userId}/avatar.png`]);
  check(await c.sb.rpc("delete_my_account"));
  await c.sb.auth.signOut();
}

export async function removeAvatar(c: CloudCtx) {
  await c.sb.storage.from("avatars").remove([`${c.userId}/avatar.webp`, `${c.userId}/avatar.jpg`]);
  check(await c.sb.from("profiles").upsert({ user_id: c.userId, avatar_url: null, updated_at: new Date().toISOString() }, { onConflict: "user_id" }));
}
