/** Home dashboard: hero, Continue Watching, hubs, ML recommendation rows and regional TMDB rows. */
import { useEffect, useMemo } from "react";
import { useAsync } from "../../lib/hooks";
import { discover, isKidsSafe, trending, type MediaSummary } from "../../services/tmdbClient";
import { recommendations, type RecommendationRow } from "../../services/tauriBridge";
import { useAppStore, useCatalogKey } from "../../store/useAppStore";
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

function RecommendationRows() {
  const recs = useAppStore((s) => s.recs);
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
        <MediaCarouselRow key={row.id} title={row.title} subtitle={row.subtitle ?? undefined} items={recItems(row)} />
      ))}
    </>
  );
}

export function HomeView() {
  const catalogKey = useCatalogKey();
  const ctx = useAppStore((s) => s.catalogContext)();
  const kids = useAppStore((s) => s.isKids());
  const subs = useAppStore((s) => s.subscriptions);
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const recs = useAppStore((s) => s.recs);
  const recsStale = useAppStore((s) => s.recsStale);
  const recsLoading = useAppStore((s) => s.recsLoading);
  const loadRecommendations = useAppStore((s) => s.loadRecommendations);
  const filtered = ctx.providers.length > 0;

  // Refresh once when new behaviour made the rows stale (e.g. after Back to Hub). Failures clear
  // `recsStale`, so this can never spin into a retry loop.
  useEffect(() => {
    if (recsStale && !recsLoading) void loadRecommendations();
  }, [recsStale, recsLoading, loadRecommendations]);

  const heroSource = useAsync(async () => {
    if (filtered || kids) {
      const [mv, tv] = await Promise.all([discover("movie", ctx), discover("tv", ctx)]);
      return interleave(mv.results, tv.results);
    }
    return (await trending("all", "week")).results;
  }, [catalogKey], tmdbReady);

  const heroItems = useMemo(() => {
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
    const general = (heroSource.data ?? []).filter((m) => !kids || isKidsSafe(m));
    const seen = new Set<string>();
    return [...personal, ...general].filter((m) => {
      const k = `${m.mediaType}-${m.id}`;
      if (seen.has(k) || !m.backdropPath) return false;
      seen.add(k);
      return true;
    });
  }, [recs, heroSource.data, kids]);

  if (!tmdbReady) {
    return (
      <div className="px-10 pt-10" style={{ paddingLeft: "calc(var(--sidebar-expanded) + 48px)" }}>
        <div className="glass-panel max-w-xl px-8 py-7">
          <h2 className="text-2xl font-semibold">Connect TMDB to start browsing</h2>
          <p className="mt-2 text-label-secondary">Add <code>TMDB_API_KEY</code> to your <code>.env</code> file (or paste a key in Settings). It's only used for public catalog metadata.</p>
        </div>
      </div>
    );
  }

  const providerRows = subs.filter((p) => p.isActive).slice(0, 4);
  const availability = filtered ? "on your services" : "right now";

  return (
    <div>
      <HeroBillboard items={heroItems} />
      <div className="relative z-10 -mt-16 flex flex-col gap-11 pb-16 pr-8" style={{ paddingLeft: "var(--content-left)" }}>
        <ContinueWatchingRow />
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
        {providerRows.map((p) => (
          <LazyTmdbRow
            key={p.providerId}
            title={`Top on ${p.providerName}`}
            load={async () => {
              const pctx = { ...ctx, providers: [p.providerId] };
              const [mv, tv] = await Promise.all([discover("movie", pctx), discover("tv", pctx)]);
              return interleave(tv.results, mv.results);
            }}
            deps={[catalogKey, p.providerId]}
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
