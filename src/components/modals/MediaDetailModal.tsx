/**
 * Full-screen detail view over a blurred backdrop. Supports a navigation stack
 * (title → actor → another title …) with Back / Esc.
 */
import { AnimatePresence, m } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { extractPalette } from "../../lib/color";
import { formatRuntime, MONETIZATION_LABEL } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { groupLinks, isSubscribedLink, providerLogo } from "../../services/catalog";
import { providerFamily } from "../../lib/providers";
import {
  details as tmdbDetails,
  img,
  person as tmdbPerson,
  season as tmdbSeason,
  toCatalogEntry,
  type MediaDetails,
  type MediaSummary,
} from "../../services/tmdbClient";
import { catalog, history, type ResolvedLink, type WatchHistoryEntry } from "../../services/tauriBridge";
import { useAppStore, type ModalEntry } from "../../store/useAppStore";
import { usePlayerStore } from "../../store/usePlayerStore";
import { PosterCard, TmdbRating } from "../common/Cards";
import { HorizontalScroller } from "../common/HorizontalScroller";
import { CollectionMenu, EpisodeWatchedToggle, FavoriteButton, MarkWatchedButton } from "../common/LibraryActions";
import { CheckIcon, ChevronLeftIcon, CloseIcon, PlayIcon, PlusIcon, RefreshIcon } from "../common/Icons";
import { providerBadge } from "../home/HeroBillboard";
import { fromSummary, MediaCarouselRow } from "../home/MediaCarouselRow";
import { useDevMode } from "../../services/devMode";

// ---------------------------------------------------------------------------------------------
// Provider / deep-link selector
// ---------------------------------------------------------------------------------------------

function WatchOptions({ d, onPlay }: { d: MediaDetails; onPlay: (link: ResolvedLink) => void }) {
  const resolveLinks = usePlayerStore((s) => s.resolveLinks);
  const subs = useAppStore((s) => s.subscriptions);
  const subscriptionsOnly = useAppStore((s) => s.subscriptionsOnly);
  const region = useAppStore((s) => s.region);
  const [force, setForce] = useState(0);
  const links = useAsync(() => resolveLinks(d, force > 0), [d.id, d.mediaType, region, force]);
  const [showAll, setShowAll] = useState(false);
  const getPreference = usePlayerStore((s) => s.getPreference);
  const clearPreference = usePlayerStore((s) => s.clearPreference);
  const playTitle = usePlayerStore((s) => s.playTitle);
  const preferenceVersion = usePlayerStore((s) => s.preferenceVersion);
  const profileId = useAppStore((s) => s.activeProfile?.profileId);
  const pref = useAsync(() => getPreference(d), [d.id, d.mediaType, profileId, preferenceVersion]);
  const prefKey = pref.data ? providerFamily(pref.data.providerId, pref.data.providerName).key : null;

  const logoFor = (l: ResolvedLink) => providerLogo(d, region, l);

  if (links.loading) {
    return (
      <div className="flex gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-[58px] w-[200px] rounded-pill" />
        ))}
      </div>
    );
  }
  if (links.error) return <p className="text-[13px] text-label-secondary">Couldn't resolve streaming links: {links.error}</p>;
  const all = links.data ?? [];
  if (!all.length) return <p className="text-label-secondary">Not available to stream or buy in {region}.</p>;

  const primary = all.filter((l) => !subscriptionsOnly || isSubscribedLink(l, subs) || ["free", "ads"].includes(l.monetizationType));
  const shown = showAll || !subscriptionsOnly ? all : primary.length ? primary : all;

  const groups = groupLinks(shown);
  const prefName = groupLinks(all).find((g) => g.key === prefKey)?.name ?? pref.data?.providerName;
  return (
    <div>
      <div className="flex flex-wrap gap-3">
        {groups.map((g) => {
          const l = g.primary;
          const logo = logoFor(l);
          const included = isSubscribedLink(l, subs) && ["flatrate", "free", "ads"].includes(l.monetizationType);
          const isDefault = g.key === prefKey;
          const extras = [...new Set(g.alternatives.map((a) => MONETIZATION_LABEL[a.monetizationType]).filter((x) => x && x !== MONETIZATION_LABEL[l.monetizationType]))];
          return (
            <m.button
              key={g.key}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => onPlay(l)}
              className={`glass-pill flex items-center gap-3 py-2 pl-2 pr-4 text-left ${isDefault ? "ring-2 ring-white/80" : included ? "ring-1 ring-[#30d158]/60" : ""}`}
              title={l.isFallback ? `No direct link found; opens ${l.providerName} search. Becomes your default for this title.` : `Play on ${g.name} (becomes your default for this title)`}
            >
              {logo ? <img src={logo} alt="" className="h-10 w-10 rounded-[10px]" /> : <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-white/10 font-bold">{l.providerName[0]}</span>}
              <span>
                <span className="block text-[14px] font-semibold">{g.name}</span>
                <span className="block text-[12px] text-label-tertiary">
                  {[isDefault ? "Your default" : null, included ? "Included" : MONETIZATION_LABEL[l.monetizationType], l.quality, l.isFallback ? "Search" : null, extras.length ? `also ${extras.join(", ")}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </m.button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {pref.data && (
          <span className="chip !cursor-default" data-active>
            Play opens {prefName}
            <button className="ml-1 font-semibold text-[#0a84ff] hover:underline" onClick={() => void playTitle(d, { choose: true })}>
              Change
            </button>
            <button className="font-semibold text-label-secondary hover:text-label-primary hover:underline" onClick={() => void clearPreference(d)}>
              Forget
            </button>
          </span>
        )}
        {subscriptionsOnly && shown.length < all.length && (
          <button className="chip" onClick={() => setShowAll(true)}>
            Show rent, buy & other services ({groupLinks(all).length - groups.length})
          </button>
        )}
        <button className="chip" onClick={() => setForce((n) => n + 1)} title="Re-resolve deep links">
          <RefreshIcon size={13} /> Refresh links
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Seasons & episodes
// ---------------------------------------------------------------------------------------------

function Episodes({
  d,
  progress,
  onPlay,
  onChanged,
}: {
  d: MediaDetails;
  progress: WatchHistoryEntry[];
  onPlay: (season: number, episode: number, title: string) => void;
  onChanged: () => void;
}) {
  const profile = useAppStore((s) => s.activeProfile);
  const toast = useAppStore((s) => s.toast);
  const refreshContinueWatching = useAppStore((s) => s.refreshContinueWatching);
  const markRecsStale = useAppStore((s) => s.markRecsStale);
  const [markingSeason, setMarkingSeason] = useState(false);
  const latest = useMemo(() => [...progress].filter((p) => p.episodeNumber > 0).sort((a, b) => b.lastWatchedAt.localeCompare(a.lastWatchedAt))[0], [progress]);
  const [seasonNo, setSeasonNo] = useState<number>(latest?.seasonNumber ?? d.seasons[0]?.seasonNumber ?? 1);
  const episodes = useAsync(() => tmdbSeason(d.id, seasonNo), [d.id, seasonNo]);
  const byKey = useMemo(() => new Map(progress.map((p) => [`${p.seasonNumber}-${p.episodeNumber}`, p])), [progress]);

  /** Marks every aired, not-yet-finished episode of the open season (watched elsewhere). */
  const markSeason = async () => {
    if (!profile || !episodes.data) return;
    const today = new Date().toISOString().slice(0, 10);
    const todo = episodes.data.filter((ep) => !byKey.get(`${ep.seasonNumber}-${ep.episodeNumber}`)?.isCompleted && (!ep.airDate || ep.airDate <= today));
    if (!todo.length) return;
    setMarkingSeason(true);
    try {
      await history.markEpisodesWatched(
        profile.profileId,
        d.id,
        todo.map((ep) => ({
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
          episodeTitle: ep.name,
          durationSeconds: ep.runtimeMins ? ep.runtimeMins * 60 : null,
        })),
      );
      toast({ kind: "success", title: "Season marked as watched", body: `${todo.length} episode${todo.length > 1 ? "s" : ""} of ${d.title}` });
      onChanged();
      void refreshContinueWatching();
      markRecsStale();
    } catch (e) {
      toast({ kind: "error", title: "Couldn't update history", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setMarkingSeason(false);
    }
  };
  const seasonDone = !!episodes.data?.length && episodes.data.every((ep) => byKey.get(`${ep.seasonNumber}-${ep.episodeNumber}`)?.isCompleted);

  if (!d.seasons.length) return null;
  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-4 max-md:flex-col max-md:items-stretch max-md:gap-3">
        <div className="flex shrink-0 items-center gap-3 max-md:justify-between">
          <h2 className="section-title whitespace-nowrap">Episodes</h2>
          {episodes.data && !seasonDone && (
            <button className="glass-button shrink-0 whitespace-nowrap !px-3.5 !py-1.5 text-[13px] leading-none max-md:!px-3 max-md:text-[12px]" disabled={markingSeason} onClick={() => void markSeason()} title="Seen this season elsewhere? Track every aired episode at once">
              <CheckIcon size={14} /> {markingSeason ? "Marking…" : "Mark Season as Watched"}
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
      <div className="flex flex-col gap-2">
        {episodes.loading &&
          Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-[96px] rounded-card" />)}
        {(episodes.data ?? []).map((ep) => {
          const p = byKey.get(`${ep.seasonNumber}-${ep.episodeNumber}`);
          const ratio = p ? (p.isCompleted ? 1 : p.completionRatio) : 0;
          const still = img(ep.stillPath, "w300");
          return (
            <div key={ep.episodeNumber} className="flex items-center gap-2 rounded-card pr-3 transition-colors hover:bg-white/[0.06]">
            <button
              onClick={() => onPlay(ep.seasonNumber, ep.episodeNumber, ep.name)}
              className="group flex min-w-0 flex-1 items-center gap-4 rounded-card p-2 text-left"
            >
              <span className="relative aspect-video w-[168px] max-md:w-[116px] shrink-0 overflow-hidden rounded-[12px] bg-white/5">
                {still && <img src={still} alt="" loading="lazy" className="h-full w-full object-cover" />}
                <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                  <PlayIcon size={26} />
                </span>
                {ratio > 0 && (
                  <span className="progress-track absolute inset-x-2 bottom-2 block !h-[3px]">
                    <span className="progress-fill block" style={{ width: `${Math.max(3, ratio * 100)}%` }} />
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold">
                  {ep.episodeNumber}. {ep.name}
                  {p?.isCompleted && <CheckIcon size={14} className="ml-2 inline text-[#30d158]" />}
                </span>
                <span className="mt-0.5 block text-[12px] text-label-tertiary">
                  {[formatRuntime(ep.runtimeMins), ep.airDate].filter(Boolean).join(" · ")}
                </span>
                <span className="mt-1 line-clamp-2 block text-[13px] text-label-secondary">{ep.overview}</span>
              </span>
            </button>
            <EpisodeWatchedToggle
              tmdbId={d.id}
              seasonNumber={ep.seasonNumber}
              episodeNumber={ep.episodeNumber}
              episodeTitle={ep.name}
              runtimeMins={ep.runtimeMins}
              entry={p}
              onChanged={onChanged}
            />
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Title view
// ---------------------------------------------------------------------------------------------

function TitleView({ entry }: { entry: Extract<ModalEntry, { kind: "title" }> }) {
  const region = useAppStore((s) => s.region);
  const subs = useAppStore((s) => s.subscriptions);
  const profile = useAppStore((s) => s.activeProfile);
  const openPerson = useAppStore((s) => s.openPerson);
  const setAmbient = useAppStore((s) => s.setAmbient);
  const toggleWatchlist = useAppStore((s) => s.toggleWatchlist);
  const hideFromContinueWatching = useAppStore((s) => s.hideFromContinueWatching);
  const inContinueWatching = useAppStore((s) => s.continueWatching.some((c) => c.tmdbId === entry.id && c.mediaType === entry.mediaType));
  const inWatchlist = useAppStore((s) => s.isInWatchlist);
  useAppStore((s) => s.watchlistKeys);
  const devStream = useDevMode((s) => s.unlocked && s.directStream);
  const openDevPlayer = useDevMode((s) => s.openPlayer);
  const loadDev = useDevMode((s) => s.load);
  useEffect(() => void loadDev(), [loadDev]);
  const kids = useAppStore((s) => s.isKids());
  const playTitle = usePlayerStore((s) => s.playTitle);
  const launching = usePlayerStore((s) => s.launching);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [progressNonce, setProgressNonce] = useState(0);
  const reloadProgress = () => setProgressNonce((n) => n + 1);

  const det = useAsync(() => tmdbDetails(entry.mediaType, entry.id, region), [entry.id, entry.mediaType, region]);
  const d = det.data;
  const progress = useAsync(
    () => (profile ? history.titleProgress(profile.profileId, entry.id, entry.mediaType) : Promise.resolve([])),
    [profile?.profileId, entry.id, entry.mediaType, progressNonce],
  );

  // Cache rich metadata locally (artwork for Continue Watching + recommender features).
  useEffect(() => {
    if (d) void catalog.cache([toCatalogEntry(d)]).catch(() => undefined);
  }, [d]);
  useEffect(() => {
    const url = img(d?.backdropPath ?? entry.seed?.backdropPath, "w300");
    if (url) void extractPalette(url).then(setAmbient);
  }, [d?.backdropPath, entry.seed?.backdropPath, setAmbient]);

  const seed: MediaSummary | undefined = d ?? entry.seed;
  if (!seed) {
    return det.error ? <p className="p-10 text-label-secondary">{det.error}</p> : <div className="skeleton m-10 h-[50vh] rounded-panel" />;
  }

  const listed = inWatchlist(seed.id, seed.mediaType);
  const isLaunching = launching === `${seed.mediaType}:${seed.id}`;
  const badge = providerBadge(d, region, subs);
  const trailer = d?.videos[0];
  const kidsBlocked = kids && d?.certification && !["G", "PG", "U", "TV-Y", "TV-Y7", "TV-G", "TV-PG", "U/A 7+", "ALL", "0", "6"].includes(d.certification);

  return (
    <div>
      <div className="relative h-[56vh] min-h-[420px] w-full overflow-hidden rounded-t-panel max-md:h-[44vh] max-md:min-h-[300px] max-md:rounded-none">
        {seed.backdropPath && <img src={img(seed.backdropPath, "w1280")!} alt="" className="hero-mask absolute inset-0 h-full w-full object-cover" />}
        <div className="hero-scrim absolute inset-0" />
        <div className="absolute bottom-8 left-10 right-10 max-w-[760px] max-md:bottom-5 max-md:left-4 max-md:right-4">
          {badge && <p className="mb-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-white/80">{badge}</p>}
          <h1 className="text-[46px] max-md:text-[30px] font-bold leading-[1.04] tracking-tight drop-shadow-lg">{seed.title}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2.5 text-[14px] text-white/85">
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
                className="glass-button-primary !px-7 !py-3"
                disabled={!d || isLaunching || !!kidsBlocked}
                onClick={() => d && void playTitle(d)}
                title={kidsBlocked ? "Not available on kids profiles" : undefined}
              >
                <PlayIcon size={18} /> {isLaunching ? "Opening…" : progress.data?.some((p) => !p.isCompleted && p.progressSeconds > 30) ? "Resume" : "Play"}
              </button>
              <button className="glass-button !py-3" onClick={() => void toggleWatchlist(seed)}>
                {listed ? <CheckIcon size={18} /> : <PlusIcon size={18} />} Up Next
              </button>
              {devStream && (
                <button className="glass-button !py-3" onClick={() => openDevPlayer(seed.title)} title="Developer Options: open the HLS / MP4 test player">
                  <PlayIcon size={16} /> Stream (Dev)
                </button>
              )}
              <FavoriteButton tmdbId={seed.id} mediaType={seed.mediaType} title={seed.title} />
              {seed.mediaType === "movie" && (
                <MarkWatchedButton tmdbId={seed.id} title={seed.title} runtimeMins={d?.runtimeMins} progress={progress.data ?? []} onChanged={reloadProgress} />
              )}
              <CollectionMenu tmdbId={seed.id} mediaType={seed.mediaType} title={seed.title} />
              {trailer && (
                <button className="glass-button !py-3" onClick={() => setTrailerOpen((o) => !o)}>
                  {trailerOpen ? "Hide trailer" : "Trailer"}
                </button>
              )}
              {inContinueWatching && (
                <button
                  className="glass-button !py-3"
                  onClick={() => void hideFromContinueWatching(seed.id, seed.mediaType, seed.title)}
                  title="Hides it from Continue Watching until you watch it again. Your history is kept."
                >
                  <CloseIcon size={16} /> Remove from Continue Watching
                </button>
              )}
            </div>
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
            <WatchOptions d={d} onPlay={(link) => void playTitle(d, { link, remember: true })} />
          </section>
        )}

        {d?.mediaType === "tv" && !kidsBlocked && (
          <Episodes
            d={d}
            progress={progress.data ?? []}
            onPlay={(seasonNumber, episodeNumber, episodeTitle) => void playTitle(d, { seasonNumber, episodeNumber, episodeTitle })}
            onChanged={reloadProgress}
          />
        )}

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

        {/* Everything TMDB relates to this title, watched or not. */}
        {d && d.recommendations.length > 0 && <MediaCarouselRow title="Recommendations" items={d.recommendations.filter((x) => x.posterPath).map(fromSummary)} />}
      </div>
    </div>
  );
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
      <div className="flex gap-8">
        <span className="h-[180px] w-[180px] max-md:h-[120px] max-md:w-[120px] shrink-0 overflow-hidden rounded-full bg-white/10 shadow-lift">
          {person.profilePath && <img src={img(person.profilePath, "h632")!} alt="" className="h-full w-full object-cover" />}
        </span>
        <div className="min-w-0">
          <h1 className="text-[40px] max-md:text-[28px] font-bold tracking-tight">{person.name}</h1>
          {person.knownFor && <p className="text-label-secondary">{person.knownFor}</p>}
          {person.biography && (
            <p className={`mt-3 max-w-3xl text-[15px] leading-relaxed text-white/80 ${bioOpen ? "" : "line-clamp-4"}`}>{person.biography}</p>
          )}
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
          <PosterCard key={`${c.mediaType}-${c.id}`} title={c.title} posterPath={c.posterPath} year={c.year} rating={c.voteAverage} width="fill" onClick={() => openTitle({ id: c.id, mediaType: c.mediaType, seed: c })} />
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
