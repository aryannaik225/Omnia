"use client";
/**
 * Horizontal 3D-hover poster carousel with glass paddles. Rows mount lazily when they approach
 * the viewport, so a long Home screen never fetches or renders everything at once.
 */
import { useRef, type ReactNode } from "react";
import { useAsync, useInView } from "../../lib/hooks";
import type { MediaSummary } from "../../services/tmdbClient";
import type { MediaType } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { PosterCard, SkeletonCard, Top10Card, ViewMoreCard } from "../common/Cards";
import { ChevronLeftIcon, ChevronRightIcon } from "../common/Icons";

export interface CarouselItem {
  id: number;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
  year?: number | null;
  rating?: number | null;
  badge?: ReactNode;
  caption?: string | null;
  seed?: MediaSummary;
}

export const fromSummary = (m: MediaSummary): CarouselItem => ({
  id: m.id,
  mediaType: m.mediaType,
  title: m.title,
  posterPath: m.posterPath,
  year: m.year,
  rating: m.voteAverage,
  seed: m,
});

export function RowShell({
  title,
  subtitle,
  extra,
  children,
  onScroll,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Controls next to the heading (e.g. provider chips). */
  extra?: ReactNode;
  children: ReactNode;
  onScroll?: (dir: -1 | 1) => void;
}) {
  return (
    <section className="group/row relative">
      <div className="mb-3 flex items-end justify-between gap-4 pr-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <h2 className="section-title truncate">{title}</h2>
            {extra}
          </div>
          {subtitle && <p className="mt-0.5 truncate text-[13px] text-label-tertiary">{subtitle}</p>}
        </div>
        {onScroll && (
          <div data-nav-skip className="flex shrink-0 gap-2 opacity-0 transition-opacity duration-200 group-hover/row:opacity-100">
            <button className="icon-button !h-8 !w-8" onClick={() => onScroll(-1)} aria-label="Scroll left">
              <ChevronLeftIcon size={16} />
            </button>
            <button className="icon-button !h-8 !w-8" onClick={() => onScroll(1)} aria-label="Scroll right">
              <ChevronRightIcon size={16} />
            </button>
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

export function MediaCarouselRow({
  title,
  subtitle,
  extra,
  items,
  loading = false,
  variant = "poster",
  onViewMore,
  keepEmpty = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  extra?: ReactNode;
  items: CarouselItem[];
  loading?: boolean;
  /** "top10": rank numerals overlapping each poster's bottom-left corner. */
  variant?: "poster" | "top10";
  /** Renders a "View More" card after the last item. */
  onViewMore?: () => void;
  /** Keep the header when there is nothing to show (rows whose controls change the query). */
  keepEmpty?: boolean;
}) {
  const openTitle = useAppStore((s) => s.openTitle);
  const scroller = useRef<HTMLDivElement | null>(null);
  const scroll = (dir: -1 | 1) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: "smooth" });

  if (!loading && items.length === 0 && !keepEmpty) return null;
  return (
    <RowShell title={title} subtitle={subtitle} extra={extra} onScroll={scroll}>
      <div ref={scroller} className="row-scroller">
        {loading ? (
          Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} />)
        ) : items.length === 0 ? (
          <p className="py-16 text-[14px] text-label-tertiary">Nothing to show here right now.</p>
        ) : (
          items.map((it, i) =>
            variant === "top10" ? (
              <Top10Card key={`${it.mediaType}-${it.id}`} rank={i + 1} title={it.title} posterPath={it.posterPath} onClick={() => openTitle({ id: it.id, mediaType: it.mediaType, seed: it.seed })} />
            ) : (
              <PosterCard
                key={`${it.mediaType}-${it.id}`}
                title={it.title}
                posterPath={it.posterPath}
                year={it.year}
                rating={it.rating}
                badge={it.badge}
                caption={it.caption}
                onClick={() => openTitle({ id: it.id, mediaType: it.mediaType, seed: it.seed })}
              />
            ),
          )
        )}
        {!loading && items.length > 0 && onViewMore && <ViewMoreCard onClick={onViewMore} />}
      </div>
    </RowShell>
  );
}

/**
 * Mounts its children only once the placeholder comes within `margin` of the viewport, so rows
 * further down never fetch data or decode posters until the user scrolls toward them.
 */
export function LazySection({ children, margin = "700px", minHeight = 300 }: { children: ReactNode; margin?: string; minHeight?: number }) {
  const [ref, inView] = useInView<HTMLDivElement>(margin);
  return (
    <div ref={ref} style={inView ? undefined : { minHeight }}>
      {inView ? children : null}
    </div>
  );
}

/** A row backed by any async TMDB query, fetched only once it nears the viewport. */
export function LazyTmdbRow({
  title,
  subtitle,
  load,
  deps,
  filter,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  load: () => Promise<MediaSummary[]>;
  deps: unknown[];
  filter?: (m: MediaSummary) => boolean;
}) {
  const [ref, inView] = useInView<HTMLDivElement>("700px");
  const { data, loading, error } = useAsync(load, deps, inView);
  const items = (data ?? []).filter((m) => m.posterPath && (!filter || filter(m))).slice(0, 24).map(fromSummary);
  return (
    <div ref={ref} className="min-h-[300px]">
      {error ? null : <MediaCarouselRow title={title} subtitle={subtitle} items={items} loading={!inView || loading} />}
    </div>
  );
}
