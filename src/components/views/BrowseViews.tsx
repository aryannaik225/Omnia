/** Search, Watching Now (Continue Watching + history), My OTTs and Watchlist views. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { episodeLabel, relativeTime } from "../../lib/format";
import { useAsync, useDebounced } from "../../lib/hooks";
import { groupByFamily, providerFamily } from "../../lib/providers";
import { discover, img, isKidsSafe, searchMulti, type MediaSummary } from "../../services/tmdbClient";
import { history, type HistoryTitle } from "../../services/tauriBridge";
import { useAppStore, useCatalogKey } from "../../store/useAppStore";
import { usePlayerStore } from "../../store/usePlayerStore";
import { LandscapeCard, PosterCard } from "../common/Cards";
import { EmptyState } from "../common/EmptyState";
import { DownloadIcon, TrashIcon } from "../common/Icons";
import { MediaGrid } from "../common/MediaGrid";
import { cwBadge, cwSubtitle } from "../home/ContinueWatchingRow";
import { LazyTmdbRow } from "../home/MediaCarouselRow";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-8 mt-10 flex items-end justify-between gap-6">
      <div>
        <h1 className="text-[34px] font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-label-secondary">{subtitle}</p>}
      </div>
      {actions}
    </header>
  );
}

// ---------------------------------------------------------------------------------------------

export function SearchView() {
  const query = useAppStore((s) => s.searchQuery);
  const kids = useAppStore((s) => s.isKids());
  const debounced = useDebounced(query.trim(), 300);

  return (
    <div>
      <PageHeader title={debounced ? `Results for “${debounced}”` : "Search"} subtitle="Movies and series across every service in your region" />
      {debounced ? (
        <MediaGrid
          feedKey={`search:${debounced}:${kids}`}
          loadPage={(page) => searchMulti(debounced, page)}
          filter={(m) => !!m.posterPath && (!kids || isKidsSafe(m))}
          emptyMessage="No titles match your search."
        />
      ) : (
        <p className="text-label-secondary">Start typing in the search bar above.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** Titles per page of "Recently watched" (grouped by title in SQL). */
const HISTORY_PAGE = 60;

function historySubtitle(h: HistoryTitle, count: number) {
  const ep = episodeLabel(h.seasonNumber, h.episodeNumber);
  const parts = h.mediaType === "tv" ? [ep, h.episodeTitle] : [h.isCompleted ? "Finished" : `${Math.round(h.completionRatio * 100)}% watched`];
  if (h.mediaType === "tv" && count > 1) parts.push(`${count} episodes`);
  return parts.filter(Boolean).join(" · ");
}

export function ContinueWatchingView() {
  const profile = useAppStore((s) => s.activeProfile);
  const items = useAppStore((s) => s.continueWatching);
  const loaded = useAppStore((s) => s.continueWatchingLoaded);
  const refresh = useAppStore((s) => s.refreshContinueWatching);
  const openTitle = useAppStore((s) => s.openTitle);
  const toast = useAppStore((s) => s.toast);
  const resume = usePlayerStore((s) => s.resumeItem);
  const [nonce, setNonce] = useState(0);
  const [pages, setPages] = useState(1);
  /** Platform filter: a provider family's canonical id, 0 = Offline / Manual, null = all. */
  const [platform, setPlatform] = useState<number | null>(null);
  useEffect(() => {
    setPages(1);
    setPlatform(null);
  }, [profile?.profileId]);
  useEffect(() => setPages(1), [platform]);
  const counts = useAsync(() => history.providerCounts(profile!.profileId), [profile?.profileId, nonce, items.length], !!profile);
  const platformOptions = (counts.data ?? [])
    .map((c) => ({ id: c.providerId, rows: c.rows, name: c.providerId === 0 ? "Offline / Manual" : providerFamily(c.providerId, "").name || `Provider ${c.providerId}` }))
    .sort((a, b) => (a.id === 0 ? 1 : b.id === 0 ? -1 : b.rows - a.rows));
  const recent = useAsync(
    () => history.titles(profile!.profileId, HISTORY_PAGE * pages + 1, 0, platform),
    [profile?.profileId, nonce, items.length, pages, platform],
    !!profile,
  );
  const groups = (recent.data ?? []).slice(0, HISTORY_PAGE * pages);
  const hasMore = (recent.data?.length ?? 0) > HISTORY_PAGE * pages;

  const exportHistory = async () => {
    if (!profile) return;
    const rows = await history.exportAll(profile.profileId);
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), profile: profile.profileName, history: rows }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `omnia-history-${profile.profileName.toLowerCase().replace(/\W+/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast({ kind: "success", title: "History exported", body: `${rows.length} entries (stays on this device unless you move the file).` });
  };

  const removeGroup = async (h: HistoryTitle) => {
    await history.removeTitle(h.appProfileId, h.tmdbId, h.mediaType);
    setNonce((n) => n + 1);
    void refresh();
    toast({ kind: "info", title: "Removed from history", body: h.title ?? undefined });
  };

  // A profile with no activity at all (new, or history just cleared): one inviting state
  // instead of two empty sections.
  const nothingAtAll = loaded && !items.length && !recent.loading && recent.data !== undefined && !groups.length;

  return (
    <div className="pb-16">
      <PageHeader
        title="Watching Now"
        subtitle="Everything you're in the middle of, across all your services"
        actions={
          <button className="glass-button" onClick={() => void exportHistory()}>
            <DownloadIcon size={16} /> Export history
          </button>
        }
      />
      {nothingAtAll ? (
        <div className="pt-6">
          <EmptyState
            title="Nothing here yet"
            body="Go discover your next favorite show. Everything you watch in Omnia shows up here with its exact position, across all your services."
          />
        </div>
      ) : (
        <>
      {items.length ? (
        <div className="grid gap-x-5 gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {items.map((item) => (
            <LandscapeCard
              key={`${item.mediaType}-${item.tmdbId}`}
              title={item.title ?? "Untitled"}
              imagePath={item.backdropPath ?? item.posterPath}
              subtitle={cwSubtitle(item)}
              progress={item.upNext || item.isManual ? null : item.completionRatio}
              topLeft={cwBadge(item)}
              width={undefined}
              onClick={() => (item.isManual && item.mediaType === "movie" ? openTitle({ id: item.tmdbId, mediaType: item.mediaType }) : void resume(item))}
            />
          ))}
        </div>
      ) : (
        <EmptyState size="row" actions={false} title="Nothing in progress" body="Start something and it'll appear here, with its exact position." />
      )}

      <div className="mb-4 mt-12 flex flex-wrap items-end justify-between gap-4">
        <h2 className="section-title">Recently watched</h2>
        {platformOptions.length > 0 && (
          <label className="flex items-center gap-2 text-[13px] text-label-secondary">
            <span>Platform</span>
            <select
              className="glass-select"
              value={platform === null ? "" : String(platform)}
              onChange={(e) => setPlatform(e.target.value === "" ? null : Number(e.target.value))}
              aria-label="Filter watch history by platform"
            >
              <option value="">All platforms</option>
              {platformOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.rows.toLocaleString()})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {groups.length ? (
        <div className="grid gap-x-5 gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
          {groups.map((h) => {
            return (
              <PosterCard
                key={`${h.mediaType}-${h.tmdbId}`}
                title={h.title ?? h.episodeTitle ?? "Untitled"}
                posterPath={h.posterPath}
                subtitle={historySubtitle(h, h.entryCount)}
                caption={[h.providerName, relativeTime(h.lastWatchedAt), h.watchCount > 1 ? `${h.watchCount}×` : null].filter(Boolean).join(" · ")}
                progress={h.isCompleted ? 1 : h.completionRatio}
                badge={h.abandoned ? <span className="badge !bg-black/60">Abandoned</span> : undefined}
                cornerAction={
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Remove ${h.title ?? "title"} from history`}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-black/55 backdrop-blur-md hover:text-[#ff453a]"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeGroup(h);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.stopPropagation();
                        void removeGroup(h);
                      }
                    }}
                  >
                    <TrashIcon size={14} />
                  </span>
                }
                width="fill"
                onClick={() => openTitle({ id: h.tmdbId, mediaType: h.mediaType })}
              />
            );
          })}
        </div>
      ) : (
        <p className="text-label-secondary">{recent.loading ? "Loading…" : platform !== null ? "Nothing from this platform yet." : "No history yet."}</p>
      )}
      {hasMore && (
        <div className="mt-8 flex justify-center">
          <button className="glass-button" disabled={recent.loading} onClick={() => setPages((n) => n + 1)}>
            {recent.loading ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function MyOttsView() {
  const subs = useAppStore((s) => s.subscriptions).filter((p) => p.isActive);
  const navigate = useAppStore((s) => s.navigate);
  const ctx = useAppStore((s) => s.catalogContext)();
  const catalogKey = useCatalogKey();

  if (!subs.length) {
    return (
      <div>
        <PageHeader title="My OTTs" subtitle="Your streaming services, side by side" />
        <div className="glass-panel max-w-xl px-8 py-7">
          <p className="font-semibold">No subscriptions selected yet</p>
          <p className="mt-1 text-label-secondary">Pick the services you pay for and Omnia will organise everything around them.</p>
          <button className="glass-button-primary mt-5" onClick={() => navigate("settings")}>
            Choose subscriptions
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-12 pb-16">
      <PageHeader title="My OTTs" subtitle="What's popular on each of your services" />
      {groupByFamily(subs, (p) => p.providerId, (p) => p.providerName).map(({ family, members }) => {
        const pctx = { ...ctx, providers: members.map((m) => m.providerId) };
        const logo = img(members.find((m) => m.logoPath)?.logoPath, "w92");
        const title = (
          <span className="flex items-center gap-3">
            {logo && <img src={logo} alt="" className="h-8 w-8 rounded-[9px]" />}
            {family.name}
          </span>
        );
        return (
          <div key={family.key} className="flex flex-col gap-8">
            <LazyTmdbRow title={title} subtitle="Series" load={async () => (await discover("tv", pctx)).results} deps={[catalogKey, family.key, "tv"]} />
            <LazyTmdbRow title={<span className="text-label-secondary">{family.name} · Movies</span>} load={async () => (await discover("movie", pctx)).results} deps={[catalogKey, family.key, "movie"]} />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function WatchlistView() {
  const items = useAppStore((s) => s.watchlist);
  const openTitle = useAppStore((s) => s.openTitle);
  const seeds = useMemo(
    () =>
      items.map(
        (i): MediaSummary => ({
          id: i.tmdbId,
          mediaType: i.mediaType,
          title: i.title ?? "Untitled",
          originalTitle: null,
          overview: "",
          posterPath: i.posterPath,
          backdropPath: i.backdropPath,
          year: i.releaseYear,
          voteAverage: i.voteAverage,
          genreIds: [],
          originalLanguage: null,
          popularity: 0,
        }),
      ),
    [items],
  );
  return (
    <div className="pb-16">
      <PageHeader title="Watchlist" subtitle="Your Up Next queue" />
      {seeds.length ? (
        <div className="grid gap-x-5 gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
          {seeds.map((m) => (
            <PosterCard key={`${m.mediaType}-${m.id}`} title={m.title} posterPath={m.posterPath} year={m.year} rating={m.voteAverage} width="fill" onClick={() => openTitle({ id: m.id, mediaType: m.mediaType, seed: m })} />
          ))}
        </div>
      ) : (
        <p className="text-label-secondary">Use “+ Up Next” on any title to save it here.</p>
      )}
    </div>
  );
}
