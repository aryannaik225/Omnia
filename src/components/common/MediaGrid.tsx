/**
 * Infinite poster grid: pages load as the sentinel approaches the viewport and off-screen cards
 * skip rendering via `content-visibility` (cheap virtualization for long hub/search feeds).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSubscriptionFilter } from "../../lib/availability";
import { useInView } from "../../lib/hooks";
import type { MediaSummary } from "../../services/tmdbClient";
import { useAppStore } from "../../store/useAppStore";
import { PosterCard, SkeletonCard } from "./Cards";

export interface GridPage {
  results: MediaSummary[];
  totalPages: number;
}

interface MediaGridProps {
  /** Changing the key resets the feed. */
  feedKey: string;
  loadPage: (page: number) => Promise<GridPage>;
  header?: MediaSummary[];
  emptyMessage?: string;
  filter?: (m: MediaSummary) => boolean;
  /** The feed doesn't apply "My Subscriptions" itself: verify each title before showing it. */
  verify?: boolean;
}

const NONE: MediaSummary[] = [];

export function MediaGrid({ feedKey, loadPage, header = [], emptyMessage = "Nothing to show here yet.", filter, verify = false }: MediaGridProps) {
  const openTitle = useAppStore((s) => s.openTitle);
  const [items, setItems] = useState<MediaSummary[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentinel, inView] = useInView<HTMLDivElement>("900px", false);
  const loadRef = useRef(loadPage);
  loadRef.current = loadPage;
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setItems([]);
    setPage(0);
    setTotalPages(1);
    setError(null);
    // A request from the previous feed may still be in flight; its result is discarded.
    setLoading(false);
  }, [feedKey]);

  const loadMore = useCallback(async () => {
    if (loading || page >= totalPages) return;
    const gen = generation.current;
    setLoading(true);
    try {
      const next = await loadRef.current(page + 1);
      if (gen !== generation.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((m) => `${m.mediaType}-${m.id}`));
        return [...prev, ...next.results.filter((m) => !seen.has(`${m.mediaType}-${m.id}`))];
      });
      setTotalPages(next.totalPages);
      setPage((p) => p + 1);
    } catch (e) {
      if (gen === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [loading, page, totalPages]);

  useEffect(() => {
    if ((inView || page === 0) && !error) void loadMore();
  }, [inView, page, error, loadMore]);

  const headerKeys = new Set(header.map((m) => `${m.mediaType}-${m.id}`));
  const all = [...header, ...items.filter((m) => !headerKeys.has(`${m.mediaType}-${m.id}`))].filter((m) => !filter || filter(m));
  const verified = useSubscriptionFilter(verify ? all : NONE, (m) => ({ id: m.id, mediaType: m.mediaType }));
  const visible = verify ? verified.items : all;

  return (
    <div>
      <div className="grid gap-x-5 gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
        {visible.map((mItem) => (
          <PosterCard
            key={`${mItem.mediaType}-${mItem.id}`}
            title={mItem.title}
            posterPath={mItem.posterPath}
            year={mItem.year}
            rating={mItem.voteAverage}
            width="fill"
            onClick={() => openTitle({ id: mItem.id, mediaType: mItem.mediaType, seed: mItem })}
          />
        ))}
        {loading && Array.from({ length: 8 }, (_, i) => <SkeletonCard key={`s${i}`} width="fill" />)}
      </div>
      {!loading && !error && visible.length === 0 && page >= 1 && <p className="py-16 text-center text-label-secondary">{emptyMessage}</p>}
      {error && (
        <div className="py-10 text-center">
          <p className="text-label-secondary">{error}</p>
          <button className="glass-button mt-4" onClick={() => setError(null)}>
            Try again
          </button>
        </div>
      )}
      <div ref={sentinel} className="h-4" />
    </div>
  );
}
