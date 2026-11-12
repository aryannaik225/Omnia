/** Cross-OTT resume cards (16:9) with exact progress bars, fed by the local watch history. */
import { useRef } from "react";
import { episodeLabel, formatTimeLeft } from "../../lib/format";
import type { ContinueWatchingItem } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { usePlayerStore } from "../../store/usePlayerStore";
import { LandscapeCard } from "../common/Cards";
import { RowShell } from "./MediaCarouselRow";

export function cwSubtitle(item: ContinueWatchingItem) {
  const ep = episodeLabel(item.seasonNumber, item.episodeNumber);
  if (item.upNext) return ["Up Next", ep ? `after ${ep}` : null, item.providerName].filter(Boolean).join(" · ");
  return [ep, formatTimeLeft(item.progressSeconds, item.durationSeconds), item.providerName].filter(Boolean).join(" · ");
}

export function ContinueWatchingRow() {
  const items = useAppStore((s) => s.continueWatching);
  const openTitle = useAppStore((s) => s.openTitle);
  const resume = usePlayerStore((s) => s.resumeItem);
  const launching = usePlayerStore((s) => s.launching);
  const scroller = useRef<HTMLDivElement | null>(null);
  if (!items.length) return null;

  return (
    <RowShell
      title="Continue Watching"
      subtitle="Picks up exactly where you left off, on any service"
      onScroll={(dir) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: "smooth" })}
    >
      <div ref={scroller} className="row-scroller">
        {items.map((item) => (
          <LandscapeCard
            key={`${item.mediaType}-${item.tmdbId}`}
            title={item.title ?? "Untitled"}
            imagePath={item.backdropPath ?? item.posterPath}
            subtitle={launching === `${item.mediaType}:${item.tmdbId}` ? "Opening…" : cwSubtitle(item)}
            progress={item.upNext ? null : item.completionRatio}
            topLeft={item.upNext ? <span className="badge !bg-[#0a84ff]/70">Up Next</span> : undefined}
            topRight={
              <span
                role="button"
                tabIndex={0}
                aria-label={`Details for ${item.title ?? "title"}`}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-[13px] font-bold opacity-0 backdrop-blur-md transition-opacity group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  openTitle({ id: item.tmdbId, mediaType: item.mediaType });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    openTitle({ id: item.tmdbId, mediaType: item.mediaType });
                  }
                }}
              >
                i
              </span>
            }
            onClick={() => void resume(item)}
          />
        ))}
      </div>
    </RowShell>
  );
}
