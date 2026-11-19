"use client";
/**
 * Continue Watching, web edition: the desktop's 16:9 resume cards, fed by the manual tracker.
 * Each series you're following shows its next episode ("Up Next"), or "New Episode" when you'd
 * caught up and a new one has just aired. A tap opens the title; ✓ ticks the episode off.
 */
import { useRef } from "react";
import { useTracker } from "@/components/tracker/TrackerProvider";
import { useLibrary, type LibraryShow } from "@/components/tracker/useLibrary";
import { daysUntil } from "@/lib/media";
import { ROW_CAP } from "../../config/homeRows";
import { episodeLabel } from "../../lib/format";
import { useAppStore } from "../../store/useAppStore";
import { LandscapeCard, ViewMoreCard } from "../common/Cards";
import { EmptyState } from "../common/EmptyState";
import { CheckIcon } from "../common/Icons";
import { RowShell } from "./MediaCarouselRow";

/** The next episode is the newest one and aired in the last fortnight. */
export const isNewEpisode = (s: LibraryShow) => {
  const n = s.progress.next;
  const last = s.title.lastEpisode;
  if (!n || !last || n.season !== last.season || n.episode !== last.episode) return false;
  const d = daysUntil(last.airDate);
  return d != null && d <= 0 && d >= -14;
};

export function cwSubtitle(s: LibraryShow) {
  const n = s.progress.next;
  const ep = n ? episodeLabel(n.season, n.episode) : null;
  const left = s.progress.airedTotal - s.progress.watchedAired;
  if (isNewEpisode(s)) return ["New episode", ep].filter(Boolean).join(" · ");
  return ["Up Next", ep, left > 1 ? `${left} episodes left` : null].filter(Boolean).join(" · ");
}

export function cwBadge(s: LibraryShow) {
  if (isNewEpisode(s)) return <span className="badge !bg-[#30d158]/80 !text-black">New Episode</span>;
  return <span className="badge !bg-[#0a84ff]/70">Up Next</span>;
}

/** ✓ on a resume card: marks the next episode watched without opening the title. */
export function MarkNextButton({ s }: { s: LibraryShow }) {
  const t = useTracker();
  const n = s.progress.next;
  if (!n) return null;
  const label = `Mark ${episodeLabel(n.season, n.episode)} of ${s.title.title} as watched`;
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-full bg-black/45 opacity-0 backdrop-blur-md transition-[opacity,background-color] hover:bg-[#30d158] hover:text-black group-hover:opacity-100"
      onClick={(e) => {
        e.stopPropagation();
        t.setEpisodes(s.title.id, [{ ...n, runtime: s.title.runtime }], true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.stopPropagation();
          t.setEpisodes(s.title.id, [{ ...n, runtime: s.title.runtime }], true);
        }
      }}
    >
      <CheckIcon size={14} />
    </span>
  );
}

export function ContinueWatchingRow() {
  const lib = useLibrary();
  const openTitle = useAppStore((s) => s.openTitle);
  const navigate = useAppStore((s) => s.navigate);
  const scroller = useRef<HTMLDivElement | null>(null);
  const items = lib.upNext;

  if (!items.length) {
    // A brand-new library: invite rather than leave a gap. Otherwise the row stays out of the way.
    if (!lib.ready || !lib.empty) return null;
    return (
      <RowShell title="Continue Watching">
        <EmptyState
          size="row"
          title="Nothing here yet"
          body="Go discover your next favorite show. Tick off the episodes you watch and the next one waits for you here, on any service."
        />
      </RowShell>
    );
  }

  return (
    <RowShell
      title="Continue Watching"
      subtitle="Your next episode of everything you follow, on any service"
      onScroll={(dir) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: "smooth" })}
    >
      <div ref={scroller} className="row-scroller">
        {items.slice(0, ROW_CAP).map((s) => (
          <LandscapeCard
            key={s.key}
            title={s.title.title}
            imagePath={s.title.backdropPath ?? s.title.posterPath}
            subtitle={cwSubtitle(s)}
            progress={s.progress.airedTotal ? s.progress.watchedAired / s.progress.airedTotal : null}
            topLeft={cwBadge(s)}
            topRight={<MarkNextButton s={s} />}
            onClick={() => openTitle({ id: s.title.id, mediaType: "tv" })}
          />
        ))}
        {items.length > ROW_CAP && <ViewMoreCard landscape onClick={() => navigate("continue")} />}
      </div>
    </RowShell>
  );
}
