"use client";
/**
 * The library everyone gets, signed in or not.
 *
 * - Guest: saved in this browser (localStorage), no account needed.
 * - Signed in: the user's own Supabase rows (RLS). Anything tracked as a guest in this browser
 *   is uploaded once on sign-in and then cleared locally.
 *
 * Every change is applied optimistically and rolled back if the server refuses it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { MediaType } from "@/lib/media";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseConfigured } from "@/lib/supabase/env";
import { countItems, emptyData, epKey, episodeRuntimeKey, isEmpty, itemKey, merge, movieRuntimeKey, validRuntime, type TrackerData } from "@/lib/tracker";
import * as cloud from "@/lib/tracker-cloud";
import { useAppStore } from "@/omnia/store/useAppStore";

const GUEST_KEY = "omnia.tracker.v1";
const HINT_KEY = "omnia.guest-hint-shown";

export interface SessionUser {
  id: string;
  email: string | null;
}

type Status = "loading" | "ready" | "error";

interface TrackerApi {
  data: TrackerData;
  status: Status;
  mode: "guest" | "cloud";
  user: SessionUser | null;
  canSignIn: boolean;
  inWatchlist: (t: MediaType, id: number) => boolean;
  toggleWatchlist: (t: MediaType, id: number) => void;
  movieWatched: (id: number) => boolean;
  /** `runtimeMins`: the movie's TMDB runtime, kept for the watch-time stats. */
  setMovieWatched: (id: number, watched: boolean, runtimeMins?: number | null) => void;
  watchedEpisodes: (id: number) => Record<string, string>;
  /** `runtime` (minutes) per episode from TMDB, kept for the watch-time stats. */
  setEpisodes: (id: number, eps: { season: number; episode: number; runtime?: number | null }[], watched: boolean) => void;
  replaceAll: (d: TrackerData, mode: "merge" | "replace") => Promise<void>;
  clearAll: () => Promise<void>;
  notify: (msg: string) => void;
}

const Ctx = createContext<TrackerApi | null>(null);

export function useTracker(): TrackerApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTracker must be used inside <TrackerProvider>");
  return v;
}

function readGuest(): TrackerData {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    if (!raw) return emptyData();
    const d = JSON.parse(raw) as Partial<TrackerData>;
    return { watchlist: d.watchlist ?? {}, movies: d.movies ?? {}, episodes: d.episodes ?? {}, runtimes: d.runtimes ?? {} };
  } catch {
    return emptyData();
  }
}
function writeGuest(d: TrackerData | null) {
  try {
    if (d) localStorage.setItem(GUEST_KEY, JSON.stringify(d));
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    // Private mode / storage full: the session still works in memory.
  }
}

const errText = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "Something went wrong");

export function TrackerProvider({ user, children }: { user: SessionUser | null; children: React.ReactNode }) {
  const canSignIn = supabaseConfigured();
  const mode: "guest" | "cloud" = user && canSignIn ? "cloud" : "guest";
  const [data, setData] = useState<TrackerData>(emptyData);
  const [status, setStatus] = useState<Status>("loading");
  const ctxRef = useRef<cloud.CloudCtx | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const userEmail = user?.email ?? null;
  /** Desktop-style toasts (omnia/components/common/Toasts); `cta` adds a "Sign in" action. */
  const notify = useCallback((msg: string, cta = false) => {
    const error = /^Couldn/.test(msg);
    useAppStore.getState().toast({
      kind: error ? "error" : cta ? "info" : "success",
      title: error ? msg.split(":")[0]! : msg.split(". ")[0]!,
      body: error ? msg.split(": ").slice(1).join(": ") || undefined : msg.split(". ").slice(1).join(". ") || undefined,
      action: cta ? { label: "Sign in", href: "/app/login" } : undefined,
    });
  }, []);

  // Load: guest storage, or the account (uploading this browser's guest library first).
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    if (mode === "guest") {
      ctxRef.current = null;
      setData(readGuest());
      setStatus("ready");
      return;
    }
    const userId = user!.id;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const profileId = await cloud.resolveProfile(sb, userId, userEmail);
        const c = { sb, userId, profileId };
        const guest = readGuest();
        if (!isEmpty(guest)) {
          await cloud.pushAll(c, guest);
          writeGuest(null);
          if (!cancelled) notify(`Synced ${countItems(guest)} item${countItems(guest) === 1 ? "" : "s"} from this browser to your account`);
        }
        const d = await cloud.loadCloud(c);
        if (cancelled) return;
        ctxRef.current = c;
        setData(d);
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        console.error(e);
        setStatus("error");
        notify(`Couldn't load your library: ${errText(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by identity, not the prop object
  }, [mode, user?.id, userEmail, notify]);

  /** Optimistic local update, then the remote write (rolled back on failure). */
  const mutate = useCallback(
    (next: (d: TrackerData) => TrackerData, remote: (c: cloud.CloudCtx) => Promise<void>) => {
      const prev = dataRef.current;
      const updated = next(prev);
      dataRef.current = updated;
      setData(updated);
      if (mode === "guest") {
        writeGuest(updated);
        try {
          if (!sessionStorage.getItem(HINT_KEY)) {
            sessionStorage.setItem(HINT_KEY, "1");
            notify(canSignIn ? "Saved in this browser. Sign in to keep it safe and sync across devices." : "Saved in this browser.", canSignIn);
          }
        } catch {
          // ignore
        }
        return;
      }
      const c = ctxRef.current;
      if (!c) return;
      remote(c).catch((e) => {
        console.error(e);
        dataRef.current = prev;
        setData(prev);
        notify(`Couldn't save: ${errText(e)}`);
      });
    },
    [mode, canSignIn, notify],
  );

  const api = useMemo<TrackerApi>(() => {
    const now = () => new Date().toISOString();
    return {
      data,
      status,
      mode,
      user: mode === "cloud" ? user : null,
      canSignIn,
      notify: (m) => notify(m),
      inWatchlist: (t, id) => !!data.watchlist[itemKey(t, id)],
      toggleWatchlist: (t, id) => {
        const k = itemKey(t, id);
        const adding = !dataRef.current.watchlist[k];
        const at = now();
        mutate(
          (d) => {
            const watchlist = { ...d.watchlist };
            if (adding) watchlist[k] = at;
            else delete watchlist[k];
            return { ...d, watchlist };
          },
          (c) => (adding ? cloud.addWatchlist(c, t, id, at) : cloud.removeWatchlist(c, t, id)),
        );
      },
      movieWatched: (id) => !!data.movies[id],
      setMovieWatched: (id, watched, runtimeMins) => {
        const mins = validRuntime(runtimeMins);
        const at = now();
        const k = itemKey("movie", id);
        const wasListed = !!dataRef.current.watchlist[k];
        mutate(
          (d) => {
            const movies = { ...d.movies };
            if (watched) movies[id] = at;
            else delete movies[id];
            // Watching a movie takes it off the watchlist, like any tracker.
            const watchlist = { ...d.watchlist };
            if (watched) delete watchlist[k];
            const runtimes = { ...d.runtimes };
            if (watched && mins) runtimes[movieRuntimeKey(id)] = mins;
            else if (!watched) delete runtimes[movieRuntimeKey(id)];
            return { ...d, movies, watchlist, runtimes };
          },
          async (c) => {
            await cloud.setMovieWatched(c, id, watched ? at : null, mins);
            if (watched && wasListed) await cloud.removeWatchlist(c, "movie", id);
          },
        );
      },
      watchedEpisodes: (id) => data.episodes[id] ?? {},
      setEpisodes: (id, eps, watched) => {
        if (!eps.length) return;
        const at = now();
        mutate(
          (d) => {
            const m: Record<string, string> = { ...(d.episodes[id] ?? {}) };
            const runtimes = { ...d.runtimes };
            for (const e of eps) {
              const rk = episodeRuntimeKey(id, e.season, e.episode);
              if (watched) {
                m[epKey(e.season, e.episode)] ??= at;
                const mins = validRuntime(e.runtime);
                if (mins) runtimes[rk] = mins;
              } else {
                delete m[epKey(e.season, e.episode)];
                delete runtimes[rk];
              }
            }
            const episodes: TrackerData["episodes"] = { ...d.episodes, [id]: m };
            if (!Object.keys(m).length) delete episodes[id];
            return { ...d, episodes, runtimes };
          },
          (c) => cloud.setEpisodesWatched(c, id, eps, watched ? at : null),
        );
      },
      replaceAll: async (incoming, how) => {
        const next = how === "merge" ? merge(dataRef.current, incoming) : incoming;
        const c = ctxRef.current;
        if (mode === "cloud" && c) {
          if (how === "replace") await cloud.clearCloud(c);
          await cloud.pushAll(c, next);
          setData(await cloud.loadCloud(c));
        } else {
          writeGuest(next);
          setData(next);
        }
      },
      clearAll: async () => {
        const c = ctxRef.current;
        if (mode === "cloud" && c) await cloud.clearCloud(c);
        else writeGuest(null);
        setData(emptyData());
      },
    };
  }, [data, status, mode, user, canSignIn, mutate, notify]);

  return (
    <Ctx.Provider value={api}>
      {children}
    </Ctx.Provider>
  );
}
