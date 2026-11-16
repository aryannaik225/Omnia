/** Home dashboard: hero, Continue Watching, hubs, ML recommendation rows and regional TMDB rows. */
import { useEffect, useMemo } from "react";
import { useSubscriptionFilter } from "../../lib/availability";
import { useAsync } from "../../lib/hooks";
import { groupByFamily } from "../../lib/providers";
import { discover, isKidsSafe, trending, type MediaSummary } from "../../services/tmdbClient";
import { history, recommendations, type RecommendationRow } from "../../services/tauriBridge";
import { availabilityKey, useAppStore, useCatalogKey } from "../../store/useAppStore";
import { MatchBadge, SkeletonCard } from "../common/Cards";
import { RefreshIcon } from "../common/Icons";
import { BrandHubsRow } from "../home/BrandHubsRow";
import { ContinueWatchingRow } from "../home/ContinueWatchingRow";
import { HeroBillboard } from "../home/HeroBillboard";
import { LazyTmdbRow, MediaCarouselRow, RowShell, type CarouselItem } from "../home/MediaCarouselRow";

const interleave = (a: MediaSummary[], b: MediaSummary[]) => {
  const out: MediaSummary[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]!);
    if (b[i]) out.push(b[i]!);
  }
  return out;
};

function recItems(row: RecommendationRow): CarouselItem[] {
  return row.items.map((it) => ({
    id: it.tmdbId,
    mediaType: it.mediaType,
    title: it.title,
    posterPath: it.posterPath,
    year: it.releaseYear,
    rating: it.voteAverage,
    badge: row.kind === "comfort" ? undefined : <MatchBadge percent={it.matchPercent} />,
    caption: it.becauseOf ? `Like ${it.becauseOf}` : null,
  }));
}

/** Backend rows computed under the current filter are trusted; older ones are re-verified. */
function useRecsTrusted() {
  return useAppStore((s) => s.recsAvailabilityKey !== null && s.recsAvailabilityKey === availabilityKey(s));
}

function RecRow({ row, trusted }: { row: RecommendationRow; trusted: boolean }) {
  const all = useMemo(() => recItems(row), [row]);
  // Comfort favourites come from your own history, never from the filtered candidate pool.
  const { items, checking } = useSubscriptionFilter(all, (it) => ({ id: it.id, mediaType: it.mediaType, trusted: trusted && row.kind !== "comfort" }));
  return <MediaCarouselRow title={row.title} subtitle={row.subtitle ?? undefined} items={items} loading={checking && items.length === 0} />;
}

function RecommendationRows() {
  const recs = useAppStore((s) => s.recs);
  const trusted = useRecsTrusted();
  const loading = useAppStore((s) => s.recsLoading);
  const error = useAppStore((s) => s.recsError);
  const load = useAppStore((s) => s.loadRecommendations);
  const status = useAsync(() => recommendations.embeddingStatus(), [loading]);

  if (loading && !recs) {
    return (
      <RowShell
        title="Personalising your picks…"
        subtitle={status.data?.ready ? "Ranking titles against your taste profile" : "Preparing the on-device recommendation model (first run only)"}
      >
        <div className="row-scroller">
          {Array.from({ length: 8 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </RowShell>
    );
  }
  if (error && !recs) {
    return (
      <div className="glass-panel flex items-center justify-between gap-4 px-6 py-5">
        <div>
          <p className="font-semibold">Recommendations unavailable</p>
          <p className="text-[13px] text-label-secondary">{error}</p>
        </div>
        <button className="glass-button" onClick={() => void load(true)}>
          <RefreshIcon size={16} /> Retry
        </button>
      </div>
    );
  }
  if (!recs) return null;
  return (
    <>
      {recs.rows.map((row) => (
        <RecRow key={row.id} row={row} trusted={trusted} />
      ))}
    </>
  );
}

/** "Your List": the watchlist, most recently added first (the backend orders by `added_at`). */
function YourListRow() {
  const list = useAppStore((s) => s.watchlist);
  const items = useMemo(
    () =>
      list.map(
        (i): CarouselItem => ({ id: i.tmdbId, mediaType: i.mediaType, title: i.title ?? "Untitled", posterPath: i.posterPath, year: i.releaseYear, rating: i.voteAverage }),
      ),
    [list],
  );
  return <MediaCarouselRow title="Your List" subtitle="Saved with + Up Next, newest first" items={items} />;
}

/** Profiles whose airing shows were checked this session (Rust also throttles per series). */
const airingChecked = new Set<number>();

/** Brings caught-up airing series with a new episode back to Continue Watching. */
function useAiringShowsCheck() {
  const profileId = useAppStore((s) => s.activeProfile?.profileId);
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const refresh = useAppStore((s) => s.refreshContinueWatching);
  useEffect(() => {
    if (!profileId || !tmdbReady || airingChecked.has(profileId)) return;
    airingChecked.add(profileId);
    history
      .checkAiringShows(profileId)
      .then((n) => {
        if (n > 0) void refresh();
      })
      .catch(() => airingChecked.delete(profileId));
  }, [profileId, tmdbReady, refresh]);
}

export function HomeView() {
  useAiringShowsCheck();
  const catalogKey = useCatalogKey();
  const ctx = useAppStore((s) => s.catalogContext)();
  const kids = useAppStore((s) => s.isKids());
  const subs = useAppStore((s) => s.subscriptions);
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const recs = useAppStore((s) => s.recs);
  const recsStale = useAppStore((s) => s.recsStale);
  const recsLoading = useAppStore((s) => s.recsLoading);
  const loadRecommendations = useAppStore((s) => s.loadRecommendations);
  const recsTrusted = useRecsTrusted();
  const filtered = ctx.providers.length > 0;

  // Refresh once when new behaviour made the rows stale (e.g. after Back to Hub). Failures clear
  // `recsStale`, so this can never spin into a retry loop.
  useEffect(() => {
    if (recsStale && !recsLoading) void loadRecommendations();
  }, [recsStale, recsLoading, loadRecommendations]);

  // Tagged with the catalog key it was fetched for: stale data shown during a refetch isn't trusted.
  const heroSource = useAsync(async () => {
    const key = catalogKey;
    if (filtered || kids) {
      const [mv, tv] = await Promise.all([discover("movie", ctx), discover("tv", ctx)]);
      return { key, items: interleave(mv.results, tv.results) };
    }
    return { key, items: (await trending("all", "week")).results };
  }, [catalogKey], tmdbReady);
  const heroSourceTrusted = heroSource.data?.key === catalogKey;

  const heroCandidates = useMemo(() => {
    const personal: MediaSummary[] = (recs?.rows.find((r) => r.kind === "taste")?.items ?? []).slice(0, 3).map((it) => ({
      id: it.tmdbId,
      mediaType: it.mediaType,
      title: it.title,
      originalTitle: null,
      overview: it.overview ?? "",
      posterPath: it.posterPath,
      backdropPath: it.backdropPath,
      year: it.releaseYear,
      voteAverage: it.voteAverage,
      genreIds: [],
      originalLanguage: null,
      popularity: 0,
    }));
    const general = (heroSource.data?.items ?? []).filter((m) => !kids || isKidsSafe(m));
    const seen = new Set<string>();
    return [
      ...personal.map((m) => ({ m, trusted: recsTrusted })),
      ...general.map((m) => ({ m, trusted: heroSourceTrusted })),
    ].filter(({ m }) => {
      const k = `${m.mediaType}-${m.id}`;
      if (seen.has(k) || !m.backdropPath) return false;
      seen.add(k);
      return true;
    });
  }, [recs, heroSource.data, kids, recsTrusted, heroSourceTrusted]);
  const heroFiltered = useSubscriptionFilter(heroCandidates, ({ m, trusted }) => ({ id: m.id, mediaType: m.mediaType, trusted }));
  const heroItems = useMemo(() => heroFiltered.items.map(({ m }) => m), [heroFiltered.items]);

  if (!tmdbReady) {
    return (
      <div className="px-10 pt-10" style={{ paddingLeft: "var(--content-left)" }}>
        <div className="glass-panel max-w-xl px-8 py-7">
          <h2 className="text-2xl font-semibold">Connect TMDB to start browsing</h2>
          <p className="mt-2 text-label-secondary">Add <code>TMDB_API_KEY</code> to your <code>.env</code> file (or paste a key in Settings). It's only used for public catalog metadata.</p>
        </div>
      </div>
    );
  }

  const providerRows = groupByFamily(subs.filter((p) => p.isActive), (p) => p.providerId, (p) => p.providerName).slice(0, 4);
  const availability = filtered ? "on your services" : "right now";

  return (
    <div>
      <HeroBillboard items={heroItems} />
      <div className="relative z-10 -mt-16 flex flex-col gap-11 pb-16 max-md:mt-2 max-md:gap-9" style={{ paddingLeft: "var(--content-left)", paddingRight: "var(--content-right)" }}>
        <ContinueWatchingRow />
        <YourListRow />
        <BrandHubsRow />
        <RecommendationRows />
        <LazyTmdbRow
          title={filtered || kids ? `Popular ${availability}` : "Trending this week"}
          load={async () => {
            if (filtered || kids) {
              const [mv, tv] = await Promise.all([discover("movie", ctx, {}, 2), discover("tv", ctx, {}, 2)]);
              return interleave(mv.results, tv.results);
            }
            return (await trending("all", "week")).results;
          }}
          deps={[catalogKey]}
          filter={kids ? isKidsSafe : undefined}
        />
        <LazyTmdbRow title={`Popular series ${availability}`} load={async () => (await discover("tv", ctx)).results} deps={[catalogKey, "tv"]} />
        <LazyTmdbRow title={`Popular movies ${availability}`} load={async () => (await discover("movie", ctx)).results} deps={[catalogKey, "movie"]} />
        {providerRows.map(({ family, members }) => (
          <LazyTmdbRow
            key={family.key}
            title={`Top on ${family.name}`}
            load={async () => {
              const pctx = { ...ctx, providers: members.map((m) => m.providerId) };
              const [mv, tv] = await Promise.all([discover("movie", pctx), discover("tv", pctx)]);
              return interleave(tv.results, mv.results);
            }}
            deps={[catalogKey, family.key]}
          />
        ))}
        <LazyTmdbRow
          title="Critically acclaimed"
          subtitle="Highest rated with thousands of votes"
          load={async () => (await discover("movie", ctx, { sort_by: "vote_average.desc", "vote_count.gte": 3000 })).results}
          deps={[catalogKey, "acclaimed"]}
        />
      </div>
    </div>
  );
}
