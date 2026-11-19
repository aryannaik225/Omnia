"use client";
/**
 * Web edition of the desktop's personal signals (src/lib/personal.ts), read from the manual
 * tracker instead of SQLite: recently watched titles (distinct, newest first) and the set of
 * titles already watched. "Loved" titles are a desktop feature, so `liked` is always empty.
 */
import { useMemo } from "react";
import { useTracker } from "@/components/tracker/TrackerProvider";
import { useSummaries } from "@/components/tracker/useSummaries";
import type { MediaType } from "../services/tauriBridge";

export interface Seed {
  id: number;
  mediaType: MediaType;
  title: string;
}

export interface PersonalSignals {
  loaded: boolean;
  liked: Seed[];
  recent: Seed[];
  watched: Set<string>;
}

export const seedKey = (mt: MediaType, id: number) => `${mt}:${id}`;

export function usePersonalSignals(): PersonalSignals {
  const t = useTracker();
  // Newest activity per title: a movie's watched date, a series' latest ticked episode.
  const ordered = useMemo(() => {
    const at = new Map<string, string>();
    for (const [id, when] of Object.entries(t.data.movies)) at.set(seedKey("movie", Number(id)), when);
    for (const [id, eps] of Object.entries(t.data.episodes)) {
      const latest = Object.values(eps).sort().pop();
      if (latest) at.set(seedKey("tv", Number(id)), latest);
    }
    return [...at.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([k]) => k);
  }, [t.data]);
  const top = useMemo(() => ordered.slice(0, 3), [ordered]);
  const { titles, loading } = useSummaries(top);

  return useMemo(() => {
    const recent: Seed[] = top.flatMap((k) => {
      const s = titles.get(k);
      return s ? [{ id: s.id, mediaType: s.mediaType, title: s.title }] : [];
    });
    return { loaded: t.status !== "loading" && !loading, liked: [], recent, watched: new Set(ordered) };
  }, [top, titles, loading, ordered, t.status]);
}
