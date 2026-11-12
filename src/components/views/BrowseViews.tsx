/** Search, Watch Now (Continue Watching + history), My OTTs and Watchlist views. */
import { useMemo, useState, type ReactNode } from "react";
import { episodeLabel, relativeTime } from "../../lib/format";
import { useAsync, useDebounced } from "../../lib/hooks";
import { discover, img, isKidsSafe, searchMulti, type MediaSummary } from "../../services/tmdbClient";
import { history } from "../../services/tauriBridge";
import { useAppStore, useCatalogKey } from "../../store/useAppStore";
import { usePlayerStore } from "../../store/usePlayerStore";
import { LandscapeCard, PosterCard } from "../common/Cards";
import { DownloadIcon, TrashIcon } from "../common/Icons";
import { MediaGrid } from "../common/MediaGrid";
import { cwSubtitle } from "../home/ContinueWatchingRow";
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

export function ContinueWatchingView() {
  const profile = useAppStore((s) => s.activeProfile);
  const items = useAppStore((s) => s.continueWatching);
  const refresh = useAppStore((s) => s.refreshContinueWatching);
  const openTitle = useAppStore((s) => s.openTitle);
  const toast = useAppStore((s) => s.toast);
  const resume = usePlayerStore((s) => s.resumeItem);
  const [nonce, setNonce] = useState(0);
  const recent = useAsync(() => history.list(profile!.profileId, 200), [profile?.profileId, nonce, items.length], !!profile);

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

  return (
    <div>
      <PageHeader
        title="Watch Now"
        subtitle="Everything you're in the middle of, across all your services"
        actions={
          <button className="glass-button" onClick={() => void exportHistory()}>
            <DownloadIcon size={16} /> Export history
          </button>
        }
      />
      {items.length ? (
        <div className="grid gap-x-5 gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {items.map((item) => (
            <LandscapeCard
              key={`${item.mediaType}-${item.tmdbId}`}
              title={item.title ?? "Untitled"}
              imagePath={item.backdropPath ?? item.posterPath}
              subtitle={cwSubtitle(item)}
              progress={item.upNext ? null : item.completionRatio}
              width={undefined}
              onClick={() => void resume(item)}
            />
          ))}
        </div>
      ) : (
        <p className="text-label-secondary">Nothing in progress. Start something and it'll appear here, with its exact position.</p>
      )}

      <h2 className="section-title mb-4 mt-12">Recently watched</h2>
      <div className="glass-panel divide-y divide-white/[0.06] overflow-hidden">
        {(recent.data ?? []).map((h) => (
          <div key={h.id} className="flex items-center gap-4 px-5 py-3">
            <button className="min-w-0 flex-1 text-left" onClick={() => openTitle({ id: h.tmdbId, mediaType: h.mediaType })}>
              <p className="truncate text-[14px] font-medium">
                {h.episodeTitle ?? `TMDB #${h.tmdbId}`}
                {episodeLabel(h.seasonNumber, h.episodeNumber) && <span className="ml-2 text-label-tertiary">{episodeLabel(h.seasonNumber, h.episodeNumber)}</span>}
              </p>
              <p className="text-[12px] text-label-tertiary">
                {[h.providerName, relativeTime(h.lastWatchedAt), h.isCompleted ? "Finished" : `${Math.round(h.completionRatio * 100)}%`, h.watchCount > 1 ? `Watched ${h.watchCount}×` : null, h.abandoned ? "Abandoned" : null]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </button>
            <div className="progress-track w-28">
              <div className="progress-fill" style={{ width: `${Math.round(h.completionRatio * 100)}%` }} />
            </div>
            <button
              className="text-label-tertiary transition-colors hover:text-[#ff453a]"
              aria-label="Remove from history"
              onClick={async () => {
                await history.remove(h.appProfileId, h.id);
                setNonce((n) => n + 1);
                void refresh();
              }}
            >
              <TrashIcon size={17} />
            </button>
          </div>
        ))}
        {recent.data && recent.data.length === 0 && <p className="px-5 py-6 text-label-secondary">No history yet.</p>}
      </div>
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
      {subs.map((p) => {
        const pctx = { ...ctx, providers: [p.providerId] };
        const logo = img(p.logoPath, "w92");
        const title = (
          <span className="flex items-center gap-3">
            {logo && <img src={logo} alt="" className="h-8 w-8 rounded-[9px]" />}
            {p.providerName}
          </span>
        );
        return (
          <div key={p.providerId} className="flex flex-col gap-8">
            <LazyTmdbRow title={title} subtitle="Series" load={async () => (await discover("tv", pctx)).results} deps={[catalogKey, p.providerId, "tv"]} />
            <LazyTmdbRow title={<span className="text-label-secondary">{p.providerName} · Movies</span>} load={async () => (await discover("movie", pctx)).results} deps={[catalogKey, p.providerId, "movie"]} />
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
