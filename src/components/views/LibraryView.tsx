/**
 * My Library: everything this profile has tracked, on one page — what the smart player and the
 * OTT history importer recorded, "Mark as Watched" marks and anything cloud sync brought in.
 * Same layout as the web app's My Library (web-export/omnia/components/views/LibraryView.tsx).
 *
 *   Watchlist · Upcoming · Ongoing Series · Completed Series · Tracked Movies
 *
 * Rows show the 20 most recent titles (newest tracked / updated first; Upcoming soonest first)
 * and end in a "Show more" card that opens the section's full grid (/app/library/<section>).
 * Series progress bars: blue while in progress, green once every aired episode is watched.
 */
import { useRef, type ReactNode } from "react";
import { useLibrary, type LibraryMovie, type LibraryShow, type UpcomingItem } from "../library/useLibrary";
import { countdownLabel, formatDay } from "../../lib/dates";
import { episodeLabel } from "../../lib/format";
import { relativeRelease } from "../../lib/releaseStatus";
import { useAppStore } from "../../store/useAppStore";
import { PosterCard, SkeletonCard, ViewMoreCard } from "../common/Cards";
import { ChevronLeftIcon } from "../common/Icons";
import { RowShell } from "../home/MediaCarouselRow";
import { PageHeader } from "./BrowseViews";

export type LibrarySection = "watchlist" | "upcoming" | "ongoing" | "completed" | "movies";

const ROW_CAP = 20;

interface Card {
  key: string;
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  posterPath: string | null;
  year?: number | null;
  rating?: number | null;
  subtitle?: string | null;
  caption?: string | null;
  badge?: ReactNode;
  progress?: number | null;
  tone?: "progress" | "complete";
}

const SECTIONS: Record<LibrarySection, { title: string; subtitle: string; empty: string }> = {
  watchlist: { title: "Watchlist", subtitle: "Saved with + Up Next, newest first", empty: "Nothing saved yet. Use “+ Up Next” on any movie or series to keep it here." },
  upcoming: {
    title: "Upcoming",
    subtitle: "New episodes of what you follow and releases on your watchlist, soonest first",
    empty: "Nothing scheduled. Series you follow and unreleased titles on your watchlist show their release dates here.",
  },
  ongoing: { title: "Ongoing Series", subtitle: "Series you've started, most recently watched first", empty: "Watch or tick off an episode of any series and it shows up here with your progress." },
  completed: { title: "Completed Series", subtitle: "Every aired episode watched", empty: "Series you've watched every episode of land here." },
  movies: { title: "Tracked Movies", subtitle: "Movies you've watched or started, newest first", empty: "Play a movie in Omnia, import your history or mark one as watched from its page and it's added here." },
};

export const isLibrarySection = (s: string | null | undefined): s is LibrarySection => !!s && s in SECTIONS;

/** "Watching S2 E1 · 34%", "Watching S2 · Saajan Chala Sasural" (episode not matched to a number). */
function currentLabel(s: LibraryShow): string | null {
  const c = s.current;
  if (!c) return null;
  if (c.episode === 0) return `Watched S${c.season}${c.name ? ` · ${c.name}` : ""}`;
  if (!c.completed) return `Watching ${episodeLabel(c.season, c.episode)}${c.ratio > 0.01 ? ` · ${Math.round(c.ratio * 100)}%` : ""}`;
  return null;
}

const showCard = (s: LibraryShow, done: boolean): Card => {
  const { watchedAired, airedTotal, next, ended } = s.progress;
  const live = done ? null : currentLabel(s);
  return {
    key: s.key,
    id: s.title.id,
    mediaType: "tv",
    title: s.title.title,
    posterPath: s.title.posterPath,
    year: s.title.year,
    subtitle: done
      ? ended
        ? `Finished · ${watchedAired} episodes`
        : s.title.nextEpisode?.airDate
          ? `Caught up · new ${countdownLabel(s.title.nextEpisode.airDate)?.toLowerCase()}`
          : "Caught up"
      : (live ?? `${watchedAired} of ${airedTotal} episodes${next ? ` · next ${episodeLabel(next.season, next.episode)}` : ""}`),
    // A sliver for the first episode, never a "full" blue bar.
    progress: done ? 1 : airedTotal ? Math.min(0.99, Math.max(0.03, watchedAired / airedTotal)) : 0.03,
    tone: done ? "complete" : "progress",
  };
};

const movieCard = (m: LibraryMovie, watched: boolean): Card => ({
  key: m.key,
  id: m.title.id,
  mediaType: m.title.mediaType,
  title: m.title.title,
  posterPath: m.title.posterPath,
  year: m.title.year,
  rating: m.title.voteAverage,
  caption:
    watched && m.watchedAt
      ? `Watched ${formatDay(m.watchedAt.slice(0, 10), { day: "numeric", month: "short", year: "numeric" })}`
      : watched && m.inProgress
        ? `In progress · ${Math.round(m.inProgress.ratio * 100)}%`
        : null,
  // Started, not finished: the in-progress accent (finished movies carry no bar).
  progress: watched && !m.watchedAt && m.inProgress ? Math.max(0.03, m.inProgress.ratio) : null,
  tone: "progress",
});

const upcomingCard = (u: UpcomingItem): Card => ({
  key: `${u.key}-${u.date}`,
  id: u.title.id,
  mediaType: u.title.mediaType,
  title: u.title.title,
  posterPath: u.title.posterPath,
  subtitle: u.label === "Release" ? (u.title.mediaType === "movie" ? "Release" : "Premiere") : u.label,
  caption: formatDay(u.date, { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
  badge: <span className={`badge ${u.days <= 1 ? "!bg-[#30d158]/85 !text-black" : "!bg-black/60"} backdrop-blur-md`}>{u.days === 0 ? "Today" : u.days === 1 ? "Tomorrow" : relativeRelease(u.days)}</span>,
});

/** Every section's cards, in display order. */
function useSections(): { ready: boolean; cards: Record<LibrarySection, Card[]> } {
  const lib = useLibrary();
  const watchlist = lib.watchlist
    .map((w) => ("progress" in w ? showCard(w, false) : movieCard(w, false)))
    .map((c) => ({ ...c, progress: null, subtitle: c.mediaType === "tv" ? "Series" : "Movie" }));
  return {
    ready: lib.ready,
    cards: {
      watchlist,
      upcoming: lib.upcoming.map(upcomingCard),
      ongoing: lib.ongoing.map((s) => showCard(s, false)),
      completed: lib.completed.map((s) => showCard(s, true)),
      movies: lib.watchedMovies.map((m) => movieCard(m, true)),
    },
  };
}

function Poster({ c, width }: { c: Card; width?: "fill" }) {
  const openTitle = useAppStore((s) => s.openTitle);
  return (
    <PosterCard
      title={c.title}
      posterPath={c.posterPath}
      year={c.year}
      rating={c.rating}
      subtitle={c.subtitle}
      caption={c.caption}
      badge={c.badge}
      progress={c.progress}
      progressTone={c.tone}
      width={width}
      onClick={() => openTitle({ id: c.id, mediaType: c.mediaType })}
    />
  );
}

function LibraryRow({ section, cards, ready }: { section: LibrarySection; cards: Card[]; ready: boolean }) {
  const navigate = useAppStore((s) => s.navigate);
  const scroller = useRef<HTMLDivElement | null>(null);
  const meta = SECTIONS[section];
  const more = () => navigate("library", { librarySection: section });
  return (
    <RowShell
      title={
        <span className="flex items-baseline gap-2.5">
          {meta.title}
          {ready && cards.length > 0 && <span className="text-[14px] font-medium text-label-tertiary">{cards.length}</span>}
        </span>
      }
      subtitle={meta.subtitle}
      onScroll={cards.length ? (dir) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: "smooth" }) : undefined}
    >
      {!ready ? (
        <div className="row-scroller">
          {Array.from({ length: 7 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : cards.length ? (
        <div ref={scroller} className="row-scroller">
          {cards.slice(0, ROW_CAP).map((c) => (
            <Poster key={c.key} c={c} />
          ))}
          {cards.length > ROW_CAP && <ViewMoreCard label={`Show more (${cards.length - ROW_CAP})`} onClick={more} />}
        </div>
      ) : (
        <div className="glass-panel relative flex flex-wrap items-center justify-between gap-4 overflow-hidden px-6 py-5">
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,rgba(255,255,255,0.07),rgba(255,255,255,0)_40%)]" />
          <p className="relative max-w-[620px] text-[14px] text-label-secondary">{meta.empty}</p>
          {(section === "watchlist" || section === "movies") && (
            <button className="glass-button relative !px-4 !py-2 text-[13px]" onClick={() => navigate("home")}>
              Discover something
            </button>
          )}
        </div>
      )}
    </RowShell>
  );
}

/** "14d 5h" (and "14.2 days"), "5h 20m" under a day, "45m" under an hour. */
export function formatWatchTime(minutes: number): { value: string; detail: string } {
  const m = Math.round(minutes);
  const hours = m / 60;
  if (m < 60) return { value: `${m}m`, detail: m ? `${m} minutes` : "Nothing yet" };
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return { value: rest ? `${h}h ${rest}m` : `${h}h`, detail: `${hours.toFixed(1)} hours` };
  }
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return { value: h ? `${d}d ${h}h` : `${d}d`, detail: `${(m / 1440).toFixed(1)} days · ${Math.round(hours).toLocaleString()} hours` };
}

const STAT_ICONS = {
  time: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  movie: "M4 5h16v14H4zM8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4",
  episode: "M3.5 6h17v11h-17zM8 20.5h8M9.5 9.5v4l3.5-2z",
};

function Stat({ icon, tint, label, value, detail, title }: { icon: keyof typeof STAT_ICONS; tint: string; label: string; value: string; detail: string; title?: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-4 px-6 py-5 max-md:px-4 max-md:py-4" title={title}>
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full max-md:h-10 max-md:w-10" style={{ background: `rgba(${tint},0.16)`, color: `rgb(${tint})`, boxShadow: `inset 0 0 0 1px rgba(${tint},0.3)` }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d={STAT_ICONS[icon]} />
        </svg>
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-label-tertiary">{label}</p>
        <p className="text-[30px] font-bold leading-tight tracking-tight tabular-nums max-md:text-[24px]">{value}</p>
        <p className="truncate text-[12px] text-label-secondary">{detail}</p>
      </div>
    </div>
  );
}

/** Watch summary: time, movies and episodes across everything watched (OTT-synced and hand-marked). */
function WatchSummary() {
  const lib = useLibrary();
  const { minutes, movies, episodes, estimated } = lib.stats;
  if (!lib.ready) return <div className="skeleton mb-10 h-[112px] rounded-panel" />;
  const time = formatWatchTime(minutes);
  return (
    <section aria-label="Watch summary" className="glass-panel relative mb-11 flex overflow-hidden max-md:mb-9 max-md:flex-col">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_140%_at_0%_0%,rgba(10,132,255,0.16),transparent_60%)]" />
      <Stat
        icon="time"
        tint="10,132,255"
        label="Total Days Watched"
        value={time.value}
        detail={time.detail}
        title={
          estimated
            ? `${estimated} entr${estimated === 1 ? "y" : "ies"} without a recorded or TMDB runtime use an estimate (110 min per movie, 45 per episode).`
            : "From the runtime recorded with each watch, else the title's TMDB runtime"
        }
      />
      <span className="my-5 w-px shrink-0 bg-white/[0.08] max-md:mx-4 max-md:my-0 max-md:h-px max-md:w-auto" />
      <Stat icon="movie" tint="255,176,64" label="Movies Watched" value={movies.toLocaleString()} detail={movies === 1 ? "1 movie" : `${movies.toLocaleString()} movies`} />
      <span className="my-5 w-px shrink-0 bg-white/[0.08] max-md:mx-4 max-md:my-0 max-md:h-px max-md:w-auto" />
      <Stat
        title={
          lib.stats.unplaced
            ? `Finished episodes only. ${lib.stats.unplaced} imported watch${lib.stats.unplaced === 1 ? "" : "es"} couldn't be matched to an episode number and ${lib.stats.unplaced === 1 ? "isn't" : "aren't"} counted.`
            : "Finished episodes only"
        }
        icon="episode"
        tint="48,209,88"
        label="Episodes Watched"
        value={episodes.toLocaleString()}
        detail={`Across ${lib.seriesCount} series`}
      />
    </section>
  );
}

export function LibraryView() {
  const { ready, cards } = useSections();
  const profileName = useAppStore((s) => s.activeProfile?.profileName);
  return (
    <div className="pb-16">
      <PageHeader title="My Library" subtitle={`Everything ${profileName ?? "this profile"} has watched and saved, from every service and every device`} />
      <WatchSummary />
      <div className="flex flex-col gap-11 max-md:gap-9">
        {(Object.keys(SECTIONS) as LibrarySection[]).map((s) => (
          <LibraryRow key={s} section={s} cards={cards[s]} ready={ready} />
        ))}
      </div>
    </div>
  );
}

/** A section's full grid ("Show more"). */
export function LibrarySectionView({ section }: { section: LibrarySection }) {
  const navigate = useAppStore((s) => s.navigate);
  const { ready, cards } = useSections();
  const meta = SECTIONS[section];
  const list = cards[section];
  return (
    <div className="pb-16">
      <div className="mb-7 mt-10 flex items-center gap-4 max-md:mt-6">
        <button className="icon-button shrink-0" onClick={() => navigate("library", { librarySection: null })} aria-label="Back to My Library">
          <ChevronLeftIcon size={18} />
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-[28px] font-bold tracking-tight max-md:text-[22px]">
            {meta.title} {ready && <span className="text-label-tertiary">· {list.length}</span>}
          </h1>
          <p className="truncate text-[14px] text-label-secondary">{meta.subtitle}</p>
        </div>
      </div>
      <div className="grid gap-x-5 gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
        {!ready
          ? Array.from({ length: 12 }, (_, i) => <SkeletonCard key={i} width="fill" />)
          : list.map((c) => <Poster key={c.key} c={c} width="fill" />)}
      </div>
      {ready && !list.length && <p className="py-16 text-center text-label-secondary">{meta.empty}</p>}
    </div>
  );
}

/** The "library" view: the overview, or one section's full grid. */
export function MyLibraryView() {
  const section = useAppStore((s) => s.librarySection);
  return isLibrarySection(section) ? <LibrarySectionView section={section} /> : <LibraryView />;
}
