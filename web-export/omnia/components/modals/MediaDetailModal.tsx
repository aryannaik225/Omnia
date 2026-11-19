"use client";
/**
 * Full-screen detail view over a blurred backdrop, ported from the desktop app
 * (src/components/modals/MediaDetailModal.tsx). Supports a navigation stack
 * (title → actor → another title …) with Back / Esc.
 *
 * Web differences: no player, so "Where to watch" lists the region's providers as links to the
 * provider's own page for the title, and tracking (Up Next, Mark as Watched, episodes) goes
 * through the manual tracker.
 */
import { AnimatePresence, m } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTracker } from "@/components/tracker/TrackerProvider";
import { useSummaries } from "@/components/tracker/useSummaries";
import { countdownLabel, formatDay, isAired, providerSearchUrl } from "@/lib/media";
import { epKey, showProgress } from "@/lib/tracker";
import { extractPalette } from "../../lib/color";
import { relativeRelease, releaseStatus, type ReleaseStatus } from "../../lib/releaseStatus";
import { episodeLabel, formatRuntime, MONETIZATION_LABEL, regionName } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { groupLinks, isSubscribedLink, providerLogo, rankLinks } from "../../services/catalog";
import { details as tmdbDetails, img, person as tmdbPerson, season as tmdbSeason, type MediaDetails, type MediaSummary } from "../../services/tmdbClient";
import type { ResolvedLink } from "../../services/tauriBridge";
import { useAppStore, type ModalEntry } from "../../store/useAppStore";
import { PosterCard, TmdbRating } from "../common/Cards";
import { DesktopNote } from "../common/DesktopOnly";
import { HorizontalScroller } from "../common/HorizontalScroller";
import { CheckIcon, ChevronLeftIcon, CloseIcon, PlusIcon } from "../common/Icons";
import { EpisodeWatchedToggle, MarkWatchedButton } from "../common/LibraryActions";
import { OscarBadge } from "../common/OscarBadge";
import { providerBadge } from "../home/HeroBillboard";
import { fromSummary, MediaCarouselRow } from "../home/MediaCarouselRow";

// ---------------------------------------------------------------------------------------------
// Where to watch
// ---------------------------------------------------------------------------------------------

/** TMDB availability in the region as provider links (the provider's own search for the title). */
function regionLinks(d: MediaDetails, region: string): ResolvedLink[] {
  const r = d.providersByRegion[region];
  if (!r) return [];
  const out: ResolvedLink[] = [];
  for (const kind of ["flatrate", "free", "ads", "rent", "buy"] as const) {
    for (const p of r[kind]) {
      out.push({
        providerId: p.providerId,
        providerName: p.providerName,
        monetizationType: kind,
        directUrl: providerSearchUrl(p.providerId, p.providerName, d.title, region),
        quality: null,
        isFallback: false,
      });
    }
  }
  return out;
}

const longDate = (iso: string) => formatDay(iso, { weekday: "short", day: "numeric", month: "long", year: "numeric" });
const shortDate = (iso: string) => formatDay(iso, { day: "numeric", month: "short", year: "numeric" });

const Glyph = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
/** Cinema ticket, TV, calendar. */
const TICKET = "M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4zM14 6v2.2M14 10.9v2.2M14 15.8V18";
const SCREEN = "M3.5 5.5h17v11h-17zM8 20h8M12 16.5V20";
const CALENDAR = "M4 6h16v14.5H4zM4 10.5h16M8.5 3.5v4M15.5 3.5v4";

type Tint = "amber" | "indigo" | "cyan";
/** Literal class names, so Tailwind keeps the tint rules in the build. */
const TINT_CLASS: Record<Tint, string> = { amber: "release-card--amber", indigo: "release-card--indigo", cyan: "release-card--cyan" };

/** Calendar-style tile: month band, big day, weekday. */
function DateTile({ iso, caption }: { iso: string | null; caption?: string }) {
  if (!iso) {
    return (
      <div className="release-tile">
        <span className="release-tile-month">Date</span>
        <span className="release-tile-day !text-[22px]">TBA</span>
        <span className="release-tile-week">&nbsp;</span>
      </div>
    );
  }
  const [y, m, day] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, day);
  return (
    <div className="release-tile" title={longDate(iso) ?? undefined}>
      <span className="release-tile-month">{caption ?? dt.toLocaleDateString("en-GB", { month: "short" })}</span>
      <span className="release-tile-day">{day}</span>
      <span className="release-tile-week">{caption ? dt.toLocaleDateString("en-GB", { month: "short" }) : dt.toLocaleDateString("en-GB", { weekday: "short" })}</span>
    </div>
  );
}

/** "RELEASING TOMORROW", "IN 14 DAYS", "NOW PLAYING". */
function countdown(days: number | null, verb: string) {
  if (days == null) return "Date to be announced";
  if (days <= 0) return `${verb} today`;
  if (days === 1) return `${verb} tomorrow`;
  return relativeRelease(days) ?? "";
}

/**
 * Shown instead of "Not available" while a title has no providers: its upcoming release (exact
 * date, countdown, cinemas vs streaming platform), "In Theatres Now", or a series' next air date.
 */
function ReleaseNotice({ status, d }: { status: Exclude<ReleaseStatus, { kind: "none" }>; d: MediaDetails }) {
  const region = useAppStore((s) => s.region);
  const tracker = useTracker();
  const listed = tracker.inWatchlist(d.mediaType, d.id);
  const place = regionName(region);
  const where = (regional: boolean) => (regional ? `in ${place}` : "");

  let tint: Tint = "cyan";
  let icon = SCREEN;
  let pill: string;
  let live = false;
  let date: string | null;
  let tileCaption: string | undefined;
  let headline: string;
  const details: string[] = [];

  if (status.kind === "theatres") {
    tint = "amber";
    icon = TICKET;
    pill = "Now playing";
    live = true;
    date = status.since;
    tileCaption = "Since";
    headline = `In theatres ${where(status.regional) || "now"}`.trim();
    details.push(`Released ${longDate(status.since)}`);
    details.push(status.digital ? `Streaming${status.platform ? ` on ${status.platform}` : ""} from ${shortDate(status.digital)}` : "Not on streaming or digital yet");
  } else if (status.kind === "airing") {
    date = status.date;
    pill = countdown(status.days, "Airs");
    headline = status.label;
    details.push(longDate(status.date) ?? "");
    details.push(`Not streaming in ${place} yet`);
  } else {
    date = status.date;
    const tv = d.mediaType === "tv";
    switch (status.channel) {
      case "cinemas":
        tint = "indigo";
        icon = TICKET;
        pill = countdown(status.days, "Releasing");
        headline = `In cinemas ${where(status.regional)}`.trim();
        if (status.digital) details.push(`Streaming${status.platform ? ` on ${status.platform}` : ""} from ${shortDate(status.digital)}`);
        break;
      case "digital":
        pill = countdown(status.days, "Releasing");
        headline = status.platform ? `Releasing on ${status.platform}` : "Digital / Streaming release";
        if (status.alsoInCinemas) details.push("Also in select cinemas");
        break;
      case "tv":
        pill = countdown(status.days, "Premieres");
        headline = status.label ?? (tv ? "Series premiere" : "TV premiere");
        break;
      default:
        icon = CALENDAR;
        pill = countdown(status.days, "Releasing");
        headline = status.date ? `Releasing ${longDate(status.date)}` : status.label ? `${status.label} · release date not announced yet` : "Release date not announced yet";
    }
    if (status.date && status.channel !== "unknown") details.unshift(longDate(status.date) ?? "");
    if (status.date && !status.regional && status.channel !== "tv" && d.mediaType === "movie") details.push(`Worldwide date · none listed for ${place} yet`);
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
      className={`release-card ${TINT_CLASS[tint]}`}
    >
      <DateTile iso={date} caption={tileCaption} />
      <div className="relative min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="release-icon">
            <Glyph d={icon} size={18} />
          </span>
          <span className="release-pill">
            {live && <span className="release-live-dot" />}
            {pill}
          </span>
        </div>
        <p className="mt-2.5 text-[21px] font-bold leading-tight tracking-tight max-md:text-[18px]">{headline}</p>
        {details.length > 0 && <p className="mt-1 text-[13px] text-label-secondary">{details.filter(Boolean).join("  ·  ")}</p>}
      </div>
      {status.kind !== "theatres" &&
        (listed ? (
          <span className="relative flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-label-secondary max-md:w-full">
            <CheckIcon size={15} className="text-[#30d158]" /> In your Upcoming
          </span>
        ) : (
          <button
            className="glass-button relative shrink-0 !px-4 !py-2 text-[13px] max-md:w-full"
            disabled={tracker.status === "loading"}
            onClick={() => tracker.toggleWatchlist(d.mediaType, d.id)}
            title="Adds it to your watchlist and My Library → Upcoming"
          >
            <PlusIcon size={15} /> Remind me
          </button>
        ))}
    </m.div>
  );
}

function WatchOptions({ d }: { d: MediaDetails }) {
  const subs = useAppStore((s) => s.subscriptions);
  const subscriptionsOnly = useAppStore((s) => s.subscriptionsOnly);
  const region = useAppStore((s) => s.region);
  const [showAll, setShowAll] = useState(false);
  const all = useMemo(() => rankLinks(regionLinks(d, region), subs), [d, region, subs]);
  const justWatch = d.providersByRegion[region]?.link;

  if (!all.length) {
    const status = releaseStatus(d, region);
    if (status.kind !== "none") return <ReleaseNotice status={status} d={d} />;
    return <p className="text-label-secondary">Not available to stream or buy in {regionName(region)}.</p>;
  }

  const primary = all.filter((l) => !subscriptionsOnly || isSubscribedLink(l, subs) || ["free", "ads"].includes(l.monetizationType));
  const shown = showAll || !subscriptionsOnly ? all : primary.length ? primary : all;
  const groups = groupLinks(shown);
  return (
    <div>
      <div className="flex flex-wrap gap-3">
        {groups.map((g) => {
          const l = g.primary;
          const logo = providerLogo(d, region, l);
          const included = isSubscribedLink(l, subs) && ["flatrate", "free", "ads"].includes(l.monetizationType);
          const extras = [...new Set(g.alternatives.map((a) => MONETIZATION_LABEL[a.monetizationType]).filter((x) => x && x !== MONETIZATION_LABEL[l.monetizationType]))];
          return (
            <m.a
              key={g.key}
              href={l.directUrl}
              target="_blank"
              rel="noopener noreferrer"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              className={`glass-pill flex items-center gap-3 py-2 pl-2 pr-4 text-left ${included ? "ring-1 ring-[#30d158]/60" : ""}`}
              title={`Open ${d.title} on ${g.name}`}
            >
              {logo ? (
                <img src={logo} alt="" className="h-10 w-10 rounded-[10px]" />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-white/10 font-bold">{l.providerName[0]}</span>
              )}
              <span>
                <span className="block text-[14px] font-semibold">{g.name}</span>
                <span className="block text-[12px] text-label-tertiary">
                  {[included ? "Included" : MONETIZATION_LABEL[l.monetizationType], extras.length ? `also ${extras.join(", ")}` : null].filter(Boolean).join(" · ")}
                </span>
              </span>
            </m.a>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {subscriptionsOnly && shown.length < all.length && (
          <button className="chip" onClick={() => setShowAll(true)}>
            Show rent, buy & other services ({groupLinks(all).length - groups.length})
          </button>
        )}
        {justWatch && (
          <a className="chip" href={justWatch} target="_blank" rel="noopener noreferrer" title="Availability data from JustWatch, via TMDB">
            JustWatch ↗
          </a>
        )}
      </div>
      <DesktopNote className="mt-4">Play inside Omnia’s own player, with every pause and episode tracked automatically.</DesktopNote>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Seasons & episodes
// ---------------------------------------------------------------------------------------------

/** Episodes shown before "Show all N episodes" in seasons longer than this. */
const EPISODE_PREVIEW = 10;

function Episodes({ d }: { d: MediaDetails }) {
  const t = useTracker();
  const toast = useAppStore((s) => s.toast);
  const watched = t.watchedEpisodes(d.id);
  // The season you're in: the one holding the latest episode you ticked off.
  const latest = useMemo(() => {
    let best: { season: number; episode: number } | null = null;
    for (const k of Object.keys(watched)) {
      const [season, episode] = k.split(":").map(Number) as [number, number];
      if (season > 0 && (!best || season > best.season || (season === best.season && episode > best.episode))) best = { season, episode };
    }
    return best;
  }, [watched]);
  const [seasonNo, setSeasonNo] = useState<number>(latest?.season ?? d.seasons[0]?.seasonNumber ?? 1);
  // The library may load after the first paint (browser storage / account): jump there once.
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || t.status === "loading") return;
    placed.current = true;
    if (latest && d.seasons.some((s) => s.seasonNumber === latest.season)) setSeasonNo(latest.season);
  }, [t.status, latest, d.seasons]);
  const episodes = useAsync(() => tmdbSeason(d.id, seasonNo), [d.id, seasonNo]);
  const [offer, setOffer] = useState<{ season: number; episode: number; runtime: number | null }[] | null>(null);

  // Long seasons show the first EPISODE_PREVIEW episodes; collapsed again on every season switch,
  // unless your latest episode in this season is beyond them.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(latest?.season === seasonNo && latest.episode > EPISODE_PREVIEW);
    setOffer(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonNo, d.id]);
  const sectionRef = useRef<HTMLElement | null>(null);
  const allEpisodes = episodes.data ?? [];
  const collapsible = allEpisodes.length > EPISODE_PREVIEW;
  const shownEpisodes = collapsible && !expanded ? allEpisodes.slice(0, EPISODE_PREVIEW) : allEpisodes;
  const toggleExpanded = () => {
    if (expanded) {
      // Collapsing removes the rows above the button: bring the list's top back into view.
      const top = sectionRef.current?.getBoundingClientRect().top ?? 0;
      if (top < 0) sectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    setExpanded((x) => !x);
  };

  const airedEps = allEpisodes.filter((ep) => isAired(ep.airDate));
  const todo = airedEps.filter((ep) => !watched[epKey(ep.seasonNumber, ep.episodeNumber)]);
  const seasonDone = airedEps.length > 0 && todo.length === 0;
  const markSeason = () => {
    if (!todo.length) return;
    t.setEpisodes(
      d.id,
      todo.map((ep) => ({ season: ep.seasonNumber, episode: ep.episodeNumber, runtime: ep.runtimeMins })),
      true,
    );
    setOffer(null);
    toast({ kind: "success", title: "Season marked as watched", body: `${todo.length} episode${todo.length > 1 ? "s" : ""} of ${d.title}` });
  };
  /** After ticking an episode: offer the unwatched aired episodes before it in this season. */
  const onMarked = (episode: number) => {
    const earlier = airedEps.filter((ep) => ep.episodeNumber < episode && !watched[epKey(ep.seasonNumber, ep.episodeNumber)]);
    setOffer(earlier.length ? earlier.map((ep) => ({ season: ep.seasonNumber, episode: ep.episodeNumber, runtime: ep.runtimeMins })) : null);
  };

  if (!d.seasons.length) return null;
  return (
    <section ref={sectionRef} className="scroll-mt-6">
      <div className="mb-4 flex items-center justify-between gap-4 max-md:flex-col max-md:items-stretch max-md:gap-3">
        <div className="flex shrink-0 items-center gap-3 max-md:justify-between">
          <h2 className="section-title whitespace-nowrap">Episodes</h2>
          {episodes.data && !seasonDone && todo.length > 0 && (
            <button
              className="glass-button shrink-0 whitespace-nowrap !px-3.5 !py-1.5 text-[13px] leading-none max-md:!px-3 max-md:text-[12px]"
              disabled={t.status === "loading"}
              onClick={markSeason}
              title="Seen this season? Track every aired episode at once"
            >
              <CheckIcon size={14} /> Mark Season as Watched
            </button>
          )}
          {seasonDone && (
            <button
              className="chip shrink-0"
              onClick={() =>
                t.setEpisodes(
                  d.id,
                  allEpisodes.map((ep) => ({ season: ep.seasonNumber, episode: ep.episodeNumber })),
                  false,
                )
              }
              title="Unmark every episode of this season"
            >
              <CheckIcon size={13} className="text-[#30d158]" /> Season watched · Undo
            </button>
          )}
        </div>
        <div className="flex min-w-0 gap-2 overflow-x-auto scrollbar-none">
          {d.seasons.map((s) => (
            <button key={s.seasonNumber} className="chip shrink-0 whitespace-nowrap" data-active={s.seasonNumber === seasonNo} onClick={() => setSeasonNo(s.seasonNumber)}>
              {s.name}
            </button>
          ))}
        </div>
      </div>
      <AnimatePresence>
        {offer && (
          <m.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="glass-pill mb-3 flex flex-wrap items-center gap-3 px-4 py-2.5 text-[14px]"
          >
            <span className="flex-1">
              Also mark the {offer.length} earlier episode{offer.length === 1 ? "" : "s"} as watched?
            </span>
            <button
              className="glass-button-primary !px-3.5 !py-1.5 !text-[13px]"
              onClick={() => {
                t.setEpisodes(d.id, offer, true);
                setOffer(null);
              }}
            >
              Mark them
            </button>
            <button className="chip" onClick={() => setOffer(null)}>
              No thanks
            </button>
          </m.div>
        )}
      </AnimatePresence>
      <div className="flex flex-col gap-2">
        {episodes.loading && Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-[96px] rounded-card" />)}
        {shownEpisodes.map((ep) => {
          const done = !!watched[epKey(ep.seasonNumber, ep.episodeNumber)];
          const aired = isAired(ep.airDate);
          const still = img(ep.stillPath, "w300");
          return (
            <div key={ep.episodeNumber} className="flex items-center gap-2 rounded-card pr-3 transition-colors hover:bg-white/[0.06]">
              <div className="flex min-w-0 flex-1 items-center gap-4 rounded-card p-2 text-left">
                <span className="relative aspect-video w-[168px] shrink-0 overflow-hidden rounded-[12px] bg-white/5 max-md:w-[116px]">
                  {still && <img src={still} alt="" loading="lazy" className={`h-full w-full object-cover ${aired ? "" : "opacity-50"}`} />}
                  {!aired && (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="badge !bg-black/55">{countdownLabel(ep.airDate) ?? "TBA"}</span>
                    </span>
                  )}
                  {done && (
                    <span className="progress-track absolute inset-x-2 bottom-2 block !h-[3px]">
                      <span className="progress-fill block" style={{ width: "100%" }} />
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">
                    {ep.episodeNumber}. {ep.name}
                    {done && <CheckIcon size={14} className="ml-2 inline text-[#30d158]" />}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-label-tertiary">
                    {[
                      formatRuntime(ep.runtimeMins),
                      aired ? formatDay(ep.airDate) : ep.airDate ? `Airs ${formatDay(ep.airDate, { weekday: "short", day: "numeric", month: "short" })}` : "Air date TBA",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-[13px] text-label-secondary">{ep.overview}</span>
                </span>
              </div>
              <EpisodeWatchedToggle tmdbId={d.id} seasonNumber={ep.seasonNumber} episodeNumber={ep.episodeNumber} runtimeMins={ep.runtimeMins} aired={aired} onMarked={() => onMarked(ep.episodeNumber)} />
            </div>
          );
        })}
        {collapsible && (
          <button className="glass-button mx-auto mt-2 !px-5 !py-2 text-[13px]" onClick={toggleExpanded} aria-expanded={expanded}>
            {expanded ? "Show less" : `Show all ${allEpisodes.length} episodes`}
          </button>
        )}
      </div>
    </section>
  );
}

/** Your progress through the series, and a countdown to its next episode. */
function SeriesStatus({ d }: { d: MediaDetails }) {
  const t = useTracker();
  const key = `tv:${d.id}`;
  const keys = useMemo(() => [key], [key]);
  const { titles } = useSummaries(keys);
  const sum = titles.get(key);
  if (!sum) return null;
  const p = showProgress(sum, t.watchedEpisodes(d.id));
  const nextAir = sum.nextEpisode?.airDate && !isAired(sum.nextEpisode.airDate) ? sum.nextEpisode : null;
  if (!p.airedTotal && !nextAir) return null;
  return (
    <div className="mt-6 grid max-w-[640px] gap-3 sm:grid-cols-2">
      {p.airedTotal > 0 && (
        <div className="glass-card px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-label-tertiary">Your progress</p>
          <p className="mt-1 text-[15px] font-semibold">{p.watchedAired ? `${p.watchedAired} of ${p.airedTotal} episodes` : `${p.airedTotal} episodes aired`}</p>
          <span className="progress-track mt-2 block">
            <span className="progress-fill block transition-[width] duration-500" style={{ width: `${(p.watchedAired / p.airedTotal) * 100}%` }} />
          </span>
          <p className="mt-1.5 text-[12px] text-label-secondary">
            {p.next && p.started ? `Up Next: ${episodeLabel(p.next.season, p.next.episode)}` : p.caughtUp ? (p.ended ? "Finished" : "All caught up") : "Tick off episodes below to follow it"}
          </p>
        </div>
      )}
      {nextAir && (
        <div className="glass-card px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-label-tertiary">Next episode</p>
          <p className="mt-1 text-[22px] font-bold leading-tight tracking-tight">{countdownLabel(nextAir.airDate)}</p>
          <p className="mt-0.5 truncate text-[12px] text-label-secondary">
            {episodeLabel(nextAir.season, nextAir.episode)}
            {nextAir.name && !/^Episode \d+$/.test(nextAir.name) ? ` · ${nextAir.name}` : ""} · {formatDay(nextAir.airDate, { weekday: "short", day: "numeric", month: "short" })}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Title view
// ---------------------------------------------------------------------------------------------

const KIDS_CERTS = ["G", "PG", "U", "TV-Y", "TV-Y7", "TV-G", "TV-PG", "U/A 7+", "ALL", "0", "6"];

function TitleView({ entry }: { entry: Extract<ModalEntry, { kind: "title" }> }) {
  const region = useAppStore((s) => s.region);
  const subs = useAppStore((s) => s.subscriptions);
  const openPerson = useAppStore((s) => s.openPerson);
  const setAmbient = useAppStore((s) => s.setAmbient);
  const kids = useAppStore((s) => s.isKids());
  const tracker = useTracker();
  const [trailerOpen, setTrailerOpen] = useState(false);

  const det = useAsync(() => tmdbDetails(entry.mediaType, entry.id, region), [entry.id, entry.mediaType, region]);
  const d = det.data;

  useEffect(() => {
    const url = img(d?.backdropPath ?? entry.seed?.backdropPath, "w300");
    if (url) void extractPalette(url).then(setAmbient);
  }, [d?.backdropPath, entry.seed?.backdropPath, setAmbient]);

  const seed: MediaSummary | undefined = d ?? entry.seed;
  if (!seed) {
    return det.error ? <p className="p-10 text-label-secondary">{det.error}</p> : <div className="skeleton m-10 h-[50vh] rounded-panel" />;
  }

  const listed = tracker.inWatchlist(seed.mediaType, seed.id);
  const badge = providerBadge(d, region, subs);
  const trailer = d?.videos[0];
  const kidsBlocked = kids && d?.certification && !KIDS_CERTS.includes(d.certification);

  return (
    <div>
      <div className="relative h-[56vh] min-h-[420px] w-full overflow-hidden rounded-t-panel max-md:h-[44vh] max-md:min-h-[300px] max-md:rounded-none">
        {seed.backdropPath && <img src={img(seed.backdropPath, "w1280")!} alt="" className="hero-mask absolute inset-0 h-full w-full object-cover" />}
        <div className="hero-scrim absolute inset-0" />
        <div className="absolute bottom-8 left-10 right-10 max-w-[760px] max-md:bottom-5 max-md:left-4 max-md:right-4">
          {badge && <p className="mb-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-white/80">{badge}</p>}
          <h1 className="text-[46px] font-bold leading-[1.04] tracking-tight drop-shadow-lg max-md:text-[30px]">{seed.title}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2.5 text-[14px] text-white/85">
            {seed.mediaType === "movie" && <OscarBadge tmdbId={seed.id} />}
            {d?.certification && <span className="badge">{d.certification}</span>}
            {seed.voteAverage ? (
              <span className="badge !bg-black/30">
                <TmdbRating value={seed.voteAverage} size="md" />
              </span>
            ) : null}
            {seed.year && <span>{seed.year}</span>}
            {d && <span>{d.mediaType === "tv" ? `${d.numberOfSeasons ?? d.seasons.length} Season${(d.numberOfSeasons ?? 1) > 1 ? "s" : ""}` : formatRuntime(d.runtimeMins)}</span>}
            {d?.genres.slice(0, 3).map((g) => <span key={g.id}>{g.name}</span>)}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-10 px-10 pb-12 pt-6 max-md:gap-8 max-md:px-4">
        <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
          <div>
            {d?.tagline && <p className="mb-2 text-[15px] italic text-label-secondary">{d.tagline}</p>}
            <p className="text-[16px] leading-relaxed text-white/85">{seed.overview || "No overview available."}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                className="glass-button !py-3"
                disabled={tracker.status === "loading"}
                onClick={() => tracker.toggleWatchlist(seed.mediaType, seed.id)}
                title={listed ? "Remove from your watchlist" : "Save to your watchlist"}
              >
                {listed ? <CheckIcon size={18} /> : <PlusIcon size={18} />} Up Next
              </button>
              {seed.mediaType === "movie" && !kidsBlocked && <MarkWatchedButton tmdbId={seed.id} title={seed.title} runtimeMins={d?.runtimeMins} />}
              {trailer && (
                <button className="glass-button !py-3" onClick={() => setTrailerOpen((o) => !o)}>
                  {trailerOpen ? "Hide trailer" : "Trailer"}
                </button>
              )}
            </div>
            {d?.mediaType === "tv" && !kidsBlocked && <SeriesStatus d={d} />}
          </div>
          {d && (
            <dl className="grid content-start gap-3 text-[13px]">
              {[
                ["Directed by", d.directors.join(", ")],
                ["Created by", d.creators.join(", ")],
                ["Studios", d.studios.join(", ")],
                ["Audio", d.spokenLanguages.join(", ")],
                ["Status", d.status],
              ]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-label-tertiary">{k}</dt>
                    <dd className="text-label-primary">{v}</dd>
                  </div>
                ))}
            </dl>
          )}
        </div>

        <AnimatePresence>
          {trailerOpen && trailer && (
            <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="aspect-video w-full max-w-[960px] overflow-hidden rounded-panel">
                <iframe
                  title={trailer.name}
                  src={`https://www.youtube-nocookie.com/embed/${trailer.key}?autoplay=1&rel=0&modestbranding=1`}
                  allow="autoplay; encrypted-media; fullscreen"
                  allowFullScreen
                  className="h-full w-full"
                />
              </div>
            </m.div>
          )}
        </AnimatePresence>

        {d && !kidsBlocked && (
          <section>
            <h2 className="section-title mb-4">Where to watch</h2>
            <WatchOptions d={d} />
          </section>
        )}

        {d?.mediaType === "tv" && !kidsBlocked && <Episodes d={d} />}

        {d && d.cast.length > 0 && (
          <section>
            <h2 className="section-title mb-4">Cast</h2>
            <HorizontalScroller label="cast">
              {d.cast.map((c) => (
                <m.button key={`${c.id}-${c.character}`} whileHover={{ scale: 1.06 }} onClick={() => openPerson(c.id)} className="w-[112px] shrink-0 text-center">
                  <span className="mx-auto block h-[104px] w-[104px] overflow-hidden rounded-full bg-white/10 shadow-glass">
                    {c.profilePath && <img src={img(c.profilePath, "w185")!} alt="" loading="lazy" className="h-full w-full object-cover" />}
                  </span>
                  <span className="mt-2 block truncate text-[13px] font-medium">{c.name}</span>
                  <span className="block truncate text-[12px] text-label-tertiary">{c.character}</span>
                </m.button>
              ))}
            </HorizontalScroller>
          </section>
        )}

        <MoreLikeThis items={d?.recommendations ?? []} />
      </div>
    </div>
  );
}

/** "More Like This": TMDB's recommendations, then similar titles (the desktop re-ranks on-device). */
function MoreLikeThis({ items }: { items: MediaSummary[] }) {
  const rows = items.filter((x) => x.posterPath).slice(0, 20).map(fromSummary);
  return rows.length ? <MediaCarouselRow title="More Like This" subtitle="Recommended from what fans of this title watch" items={rows} /> : null;
}

// ---------------------------------------------------------------------------------------------
// Person view (actor filmography)
// ---------------------------------------------------------------------------------------------

function PersonView({ id }: { id: number }) {
  const openTitle = useAppStore((s) => s.openTitle);
  const kids = useAppStore((s) => s.isKids());
  const p = useAsync(() => tmdbPerson(id), [id]);
  const [bioOpen, setBioOpen] = useState(false);
  const [allCredits, setAllCredits] = useState(false);
  if (!p.data) return p.error ? <p className="p-10 text-label-secondary">{p.error}</p> : <div className="skeleton m-10 h-[40vh] rounded-panel" />;
  const person = p.data;
  const credits = kids ? person.credits.filter((c) => c.genreIds.some((g) => [16, 10751, 10762].includes(g))) : person.credits;
  return (
    <div className="px-10 pb-12 pt-16 max-md:px-4">
      <div className="flex gap-8 max-md:gap-5">
        <span className="h-[180px] w-[180px] shrink-0 overflow-hidden rounded-full bg-white/10 shadow-lift max-md:h-[120px] max-md:w-[120px]">
          {person.profilePath && <img src={img(person.profilePath, "h632")!} alt="" className="h-full w-full object-cover" />}
        </span>
        <div className="min-w-0">
          <h1 className="text-[40px] font-bold tracking-tight max-md:text-[28px]">{person.name}</h1>
          {person.knownFor && <p className="text-label-secondary">{person.knownFor}</p>}
          {person.biography && <p className={`mt-3 max-w-3xl text-[15px] leading-relaxed text-white/80 ${bioOpen ? "" : "line-clamp-4"}`}>{person.biography}</p>}
          {person.biography.length > 400 && (
            <button className="mt-1 text-[13px] font-semibold text-[#0a84ff]" onClick={() => setBioOpen((o) => !o)}>
              {bioOpen ? "Less" : "More"}
            </button>
          )}
        </div>
      </div>
      <h2 className="section-title mb-1 mt-10">Filmography</h2>
      <p className="mb-4 text-[13px] text-label-tertiary">Newest first</p>
      <div className="grid gap-x-5 gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
        {credits.slice(0, allCredits ? credits.length : 60).map((c) => (
          <PosterCard
            key={`${c.mediaType}-${c.id}`}
            title={c.title}
            posterPath={c.posterPath}
            year={c.year}
            rating={c.voteAverage}
            width="fill"
            onClick={() => openTitle({ id: c.id, mediaType: c.mediaType, seed: c })}
          />
        ))}
      </div>
      {!allCredits && credits.length > 60 && (
        <button className="chip mt-6" onClick={() => setAllCredits(true)}>
          Show all {credits.length} titles
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------------

export function MediaDetailModal() {
  const stack = useAppStore((s) => s.modalStack);
  const pop = useAppStore((s) => s.popModal);
  const closeAll = useAppStore((s) => s.closeModals);
  const top = stack[stack.length - 1];
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") pop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top, pop]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [stack.length]);

  const backdropKey = top ? (top.kind === "title" ? `t-${top.mediaType}-${top.id}` : `p-${top.id}`) : "none";
  const seedBackdrop = top?.kind === "title" ? top.seed?.backdropPath : null;

  return (
    <AnimatePresence>
      {top && (
        <m.div
          key="detail-modal"
          className="fixed inset-0 z-50 flex items-stretch justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          role="dialog"
          aria-modal="true"
        >
          <div className="absolute inset-0 bg-black/55 backdrop-blur-2xl" onClick={closeAll} />
          {seedBackdrop && (
            <img src={img(seedBackdrop, "w300")!} alt="" aria-hidden className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-30 blur-3xl" />
          )}
          <m.div
            ref={scroller}
            key={backdropKey}
            initial={{ opacity: 0, y: 30, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
            className="glass-panel glass-strong relative my-6 w-[min(1200px,94vw)] overflow-y-auto overflow-x-hidden max-md:my-0 max-md:w-full max-md:rounded-none"
          >
            <div className="sticky top-0 z-20 flex h-0 justify-between px-5">
              <div className="pt-5">
                {stack.length > 1 && (
                  <button className="icon-button" onClick={pop} aria-label="Back">
                    <ChevronLeftIcon size={18} />
                  </button>
                )}
              </div>
              <div className="pt-5">
                <button className="icon-button" onClick={closeAll} aria-label="Close">
                  <CloseIcon size={18} />
                </button>
              </div>
            </div>
            {top.kind === "title" ? <TitleView key={backdropKey} entry={top} /> : <PersonView key={backdropKey} id={top.id} />}
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
