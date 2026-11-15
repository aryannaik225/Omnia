/** Cross-OTT resume cards (16:9) with exact progress bars, fed by the local watch history. */
import { useMemo, useRef } from "react";
import { useSubscriptionFilter } from "../../lib/availability";
import { episodeLabel, formatTimeLeft, watchedWithinDays } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { history, type ContinueWatchingItem } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { usePlayerStore } from "../../store/usePlayerStore";
import { LandscapeCard } from "../common/Cards";
import { EmptyState } from "../common/EmptyState";
import { RowShell } from "./MediaCarouselRow";

/** Home only shows recent activity; older items stay in the full "Watching Now" view. */
export const HOME_CONTINUE_WATCHING_DAYS = 60;

export function cwSubtitle(item: ContinueWatchingItem) {
  const ep = episodeLabel(item.seasonNumber, item.episodeNumber);
  if (item.newEpisode) {
    const n = item.newEpisode;
    return ["New episode", episodeLabel(n.seasonNumber, n.episodeNumber), item.providerName].filter(Boolean).join(" · ");
  }
  if (item.isManual && item.mediaType === "movie") return "Marked as watched";
  if (item.upNext) return ["Up Next", ep ? `after ${ep}` : null, item.providerName].filter(Boolean).join(" · ");
  return [ep, formatTimeLeft(item.progressSeconds, item.durationSeconds), item.providerName].filter(Boolean).join(" · ");
}

export function cwBadge(item: ContinueWatchingItem) {
  if (item.newEpisode) return <span className="badge !bg-[#30d158]/80 !text-black">New Episode</span>;
  if (item.isManual && item.mediaType === "movie") return <span className="badge !bg-white/25">Watched</span>;
  if (item.upNext) return <span className="badge !bg-[#0a84ff]/70">Up Next</span>;
  return undefined;
}

export function ContinueWatchingRow() {
  const stored = useAppStore((s) => s.continueWatching);
  const loaded = useAppStore((s) => s.continueWatchingLoaded);
  const all = useMemo(() => stored.filter((it) => watchedWithinDays(it.lastWatchedAt, HOME_CONTINUE_WATCHING_DAYS)), [stored]);
  // "My Subscriptions": keep titles last watched on (or streaming on) a subscribed service.
  const { items } = useSubscriptionFilter(all, (it) => ({ id: it.tmdbId, mediaType: it.mediaType, providerName: it.providerName }));
  const openTitle = useAppStore((s) => s.openTitle);
  const resume = usePlayerStore((s) => s.resumeItem);
  const launching = usePlayerStore((s) => s.launching);
  const scroller = useRef<HTMLDivElement | null>(null);
  const profileId = useAppStore((s) => s.activeProfile?.profileId);
  // Imported history is silent (it never appears here): only invite a profile with no history
  // at all, not one that has imported but hasn't played anything in Omnia yet.
  const anyHistory = useAsync(
    () => (profileId ? history.list(profileId, 1).then((r) => r.length > 0) : Promise.resolve(false)),
    [profileId, stored.length],
    loaded && !stored.length && !!profileId,
  );
  if (!items.length) {
    // A brand-new (or just-cleared) profile: invite rather than leave a gap. When there is
    // history but it is all older / imported / on other services, the row stays out of the way.
    if (!loaded || stored.length || anyHistory.data !== false) return null;
    return (
      <RowShell title="Continue Watching">
        <EmptyState
          size="row"
          title="Nothing here yet"
          body="Go discover your next favorite show. Anything you play in Omnia lands here with its exact position, or import your past history from your services."
        />
      </RowShell>
    );
  }

  return (
    <RowShell
      title="Continue Watching"
      subtitle={all.length !== items.length ? "On your services · picks up exactly where you left off" : "Picks up exactly where you left off, on any service"}
      onScroll={(dir) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: "smooth" })}
    >
      <div ref={scroller} className="row-scroller">
        {items.map((item) => (
          <LandscapeCard
            key={`${item.mediaType}-${item.tmdbId}`}
            title={item.title ?? "Untitled"}
            imagePath={item.backdropPath ?? item.posterPath}
            subtitle={launching === `${item.mediaType}:${item.tmdbId}` ? "Opening…" : cwSubtitle(item)}
            progress={item.upNext || item.isManual ? null : item.completionRatio}
            topLeft={cwBadge(item)}
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
            onClick={() => (item.isManual && item.mediaType === "movie" ? openTitle({ id: item.tmdbId, mediaType: item.mediaType }) : void resume(item))}
          />
        ))}
      </div>
    </RowShell>
  );
}
