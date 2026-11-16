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

/** Browsable genres; TMDB uses different ids for movies and series (null = no series genre). */
const GENRES: { key: string; label: string; movie: number | null; tv: number | null }[] = [
  { key: "action", label: "Action", movie: 28, tv: 10759 },
  { key: "adventure", label: "Adventure", movie: 12, tv: 10759 },
  { key: "animation", label: "Animation", movie: 16, tv: 16 },
  { key: "comedy", label: "Comedy", movie: 35, tv: 35 },
  { key: "crime", label: "Crime", movie: 80, tv: 80 },
  { key: "documentary", label: "Documentary", movie: 99, tv: 99 },
  { key: "drama", label: "Drama", movie: 18, tv: 18 },
  { key: "family", label: "Family", movie: 10751, tv: 10751 },
  { key: "fantasy", label: "Fantasy", movie: 14, tv: 10765 },
  { key: "horror", label: "Horror", movie: 27, tv: null },
  { key: "mystery", label: "Mystery", movie: 9648, tv: 9648 },
  { key: "romance", label: "Romance", movie: 10749, tv: null },
  { key: "scifi", label: "Sci-Fi", movie: 878, tv: 10765 },
  { key: "thriller", label: "Thriller", movie: 53, tv: null },
  { key: "war", label: "War", movie: 10752, tv: 10768 },
  { key: "western", label: "Western", movie: 37, tv: 37 },
];

type SearchType = "all" | "movie" | "tv";

export function SearchView() {
  const query = useAppStore((s) => s.searchQuery);
  const kids = useAppStore((s) => s.isKids());
  const ctx = useAppStore((s) => s.catalogContext)();
  const catalogKey = useCatalogKey();
  const debounced = useDebounced(query.trim(), 300);
  const [genreKey, setGenreKey] = useState<string | null>(null);
  const [type, setType] = useState<SearchType>("all");
  const genre = GENRES.find((g) => g.key === genreKey) ?? null;

  /** Genre browsing: popular titles of the genre on your services / in your region. */
  const loadGenrePage = async (page: number) => {
    const g = genre!;
    const types = (type === "all" ? (["movie", "tv"] as const) : [type]).filter((mt) => g[mt] !== null);
    const pages = await Promise.all(types.map((mt) => discover(mt, ctx, { with_genres: String(g[mt]) }, page).catch(() => null)));
    const valid = pages.filter((p): p is NonNullable<typeof p> => !!p);
    const results: MediaSummary[] = [];
    for (let i = 0; i < Math.max(0, ...valid.map((p) => p.results.length)); i++) for (const p of valid) if (p.results[i]) results.push(p.results[i]!);
    return { results, totalPages: Math.max(page, ...valid.map((p) => p.totalPages)) };
  };
  const matchesFilters = (m: MediaSummary) => {
    if (type !== "all" && m.mediaType !== type) return false;
    if (genre) {
      const id = genre[m.mediaType];
      if (id === null || !m.genreIds.includes(id)) return false;
    }
    return true;
  };

  const title = debounced ? `Results for “${debounced}”` : genre ? genre.label : "Search";
  return (
    <div>
      <PageHeader title={title} subtitle={debounced || !genre ? "Movies and series across every service in your region" : `Popular ${genre.label.toLowerCase()} titles ${ctx.providers.length ? "on your services" : "in your region"}`} />
      <div className="mb-8 flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Type">
          {(["all", "movie", "tv"] as const).map((t) => (
            <button key={t} role="radio" aria-checked={type === t} className="chip" data-active={type === t} onClick={() => setType(t)}>
              {t === "all" ? "All" : t === "movie" ? "Movies" : "Series"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Genre">
          <button role="radio" aria-checked={!genre} className="chip" data-active={!genre} onClick={() => setGenreKey(null)}>
            All genres
          </button>
          {GENRES.map((g) => (
            <button
              key={g.key}
              role="radio"
              aria-checked={genreKey === g.key}
              className="chip"
              data-active={genreKey === g.key}
              disabled={type === "tv" && g.tv === null}
              title={g.tv === null ? "Movies only: TMDB has no series genre for this" : undefined}
              onClick={() => setGenreKey(genreKey === g.key ? null : g.key)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>
      {debounced ? (
        <MediaGrid
          feedKey={`search:${debounced}:${kids}:${type}:${genreKey ?? ""}`}
          loadPage={(page) => searchMulti(debounced, page)}
          filter={(m) => !!m.posterPath && (!kids || isKidsSafe(m)) && matchesFilters(m)}
          emptyMessage={genre ? `No ${genre.label.toLowerCase()} titles match your search.` : "No titles match your search."}
        />
      ) : genre ? (
        <MediaGrid
          feedKey={`genre:${genre.key}:${type}:${catalogKey}`}
          loadPage={loadGenrePage}
          filter={(m) => !!m.posterPath && (!kids || isKidsSafe(m))}
          emptyMessage={`No ${genre.label.toLowerCase()} titles ${ctx.providers.length ? "on your services" : "in your region"}.`}
        />
      ) : (
        <p className="text-label-secondary">Type in the search bar above, or pick a genre to browse.</p>
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
