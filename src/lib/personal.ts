/**
 * The active profile's personal signals for the Home rows: Loved titles, recently watched titles
 * (distinct, newest first) and the set of titles already finished. Read from the local SQLite
 * database through the bridge; nothing leaves the machine.
 */
import { favorites, history, type MediaType } from "../services/tauriBridge";
import { useAppStore } from "../store/useAppStore";
import { useAsync } from "./hooks";

export interface Seed {
  id: number;
  mediaType: MediaType;
  title: string;
}

export interface PersonalSignals {
  loaded: boolean;
  /** Loved titles, most recently loved first. */
  liked: Seed[];
  /** Distinct titles from watch history, most recently watched first. */
  recent: Seed[];
  /** `mediaType:id` of every title with history (kept out of discovery-style personal rows). */
  watched: Set<string>;
}

export const seedKey = (mt: MediaType, id: number) => `${mt}:${id}`;

const EMPTY: PersonalSignals = { loaded: false, liked: [], recent: [], watched: new Set() };

export function usePersonalSignals(): PersonalSignals {
  const profileId = useAppStore((s) => s.activeProfile?.profileId);
  // Loving a title marks recommendations stale and they regenerate: refetch with them.
  const version = useAppStore((s) => s.recs?.generatedAt ?? "");
  const cwCount = useAppStore((s) => s.continueWatching.length);
  const { data } = useAsync(
    async (): Promise<PersonalSignals> => {
      if (!profileId) return { ...EMPTY, loaded: true };
      const [loved, rows] = await Promise.all([favorites.list(profileId).catch(() => []), history.list(profileId, 400).catch(() => [])]);
      const liked = loved.map((f) => ({ id: f.tmdbId, mediaType: f.mediaType, title: f.title ?? "this title" }));
      const watched = new Set<string>();
      const recent: Seed[] = [];
      const sorted = [...rows].sort((a, b) => b.lastWatchedAt.localeCompare(a.lastWatchedAt));
      for (const r of sorted) {
        const k = seedKey(r.mediaType, r.tmdbId);
        if (watched.has(k)) continue;
        watched.add(k);
        if (r.title) recent.push({ id: r.tmdbId, mediaType: r.mediaType, title: r.title });
      }
      return { loaded: true, liked, recent, watched };
    },
    [profileId, version, cwCount],
  );
  return data ?? EMPTY;
}
