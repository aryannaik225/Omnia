/**
 * Home: hero, then the curated row line-up (Continue Watching → Top 10 → My List → services →
 * catalog, personal and themed rows). Every row below the fold mounts and fetches only as it
 * nears the viewport, shows at most 20 titles and ends in a "View More" card that opens its
 * full-page grid. Row → TMDB mappings live in config/homeRows.
 */
import { useEffect, useMemo } from "react";
import { encodeSeeds, type RowEnv } from "../../config/homeRows";
import { useSubscriptionFilter } from "../../lib/availability";
import { useAsync } from "../../lib/hooks";
import { usePersonalSignals, type PersonalSignals } from "../../lib/personal";
import { discover, isKidsSafe, trending, type MediaSummary } from "../../services/tmdbClient";
import { history, type RecommendationRow, type RecommendedItem } from "../../services/tauriBridge";
import { availabilityKey, homeOrderKey, useAppStore, useCatalogKey } from "../../store/useAppStore";
import { parseHomeOrder, resolveHomeOrder } from "../../config/homeLayout";
import { MatchBadge, SkeletonCard } from "../common/Cards";
import { BrandHubsRow } from "../home/BrandHubsRow";
import { ContinueWatchingRow } from "../home/ContinueWatchingRow";
import { HeroBillboard } from "../home/HeroBillboard";
import { BrowseByServiceRow, HomeRow, PopularOnStreamingRow, StaticRow } from "../home/HomeRows";
import { RowShell, type CarouselItem } from "../home/MediaCarouselRow";

const interleave = (a: MediaSummary[], b: MediaSummary[]) => {
  const out: MediaSummary[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]!);
    if (b[i]) out.push(b[i]!);
  }
  return out;
};

const recToSummary = (it: RecommendedItem): MediaSummary => ({
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
});

/** Backend rows computed under the current filter are trusted; older ones are re-verified. */
function useRecsTrusted() {
  return useAppStore((s) => s.recsAvailabilityKey !== null && s.recsAvailabilityKey === availabilityKey(s));
}

/** "My List": the watchlist, most recently added first; View More opens the full list. */
function MyListRow() {
  const list = useAppStore((s) => s.watchlist);
  const navigate = useAppStore((s) => s.navigate);
  const items = useMemo(
    () =>
      list.map(
        (i): CarouselItem => ({ id: i.tmdbId, mediaType: i.mediaType, title: i.title ?? "Untitled", posterPath: i.posterPath, year: i.releaseYear, rating: i.voteAverage }),
      ),
    [list],
  );
  if (!items.length) return null;
  return <StaticRow title="My List" subtitle="Saved with + Up Next, newest first" items={items} ignoreSubscriptions onViewMore={() => navigate("library", { librarySection: "watchlist" })} />;
}

/** Which titles seed the personal rows: Loved titles first, else watch history, else none. */
function personalSeeds(s: PersonalSignals) {
  if (s.liked.length) return { seeds: s.liked, source: "liked" as const };
  if (s.recent.length) return { seeds: s.recent, source: "history" as const };
  return { seeds: [], source: "none" as const };
}

/**
 * "Because you liked …": up to two rows from your two most recent Loved titles (one row if you
 * have loved one). No likes: the two most recently watched titles. Nothing at all: no rows.
 */
function BecauseRows({ signals, env }: { signals: PersonalSignals; env: RowEnv }) {
  const { seeds, source } = personalSeeds(signals);
  if (source === "none") return null;
  return (
    <>
      {seeds.slice(0, 2).map((s) => (
        <HomeRow
          key={`${s.mediaType}:${s.id}`}
          env={env}
          rowRef={{ id: source === "liked" ? "because" : "because-watched", arg: encodeSeeds([s]), label: s.title }}
        />
      ))}
    </>
  );
}

/**
 * "We Think You'll Love These": the on-device ML taste row (K-means clusters of the profile's
 * composite vectors, Loved titles weighted highest). If the model has no row yet, an aggregate of TMDB
 * recommendations across your Loved titles (or, with none, your watch history). Hidden when
 * there are neither likes nor history.
 */
function LoveRow({ signals, env }: { signals: PersonalSignals; env: RowEnv }) {
  const recs = useAppStore((s) => s.recs);
  const recsLoading = useAppStore((s) => s.recsLoading);
  const navigate = useAppStore((s) => s.navigate);
  const trusted = useRecsTrusted();
  const taste: RecommendationRow | undefined = recs?.rows.find((r) => r.kind === "taste" && r.items.length > 0);
  const items = useMemo(
    () =>
      (taste?.items ?? []).map(
        (it): CarouselItem => ({
          id: it.tmdbId,
          mediaType: it.mediaType,
          title: it.title,
          posterPath: it.posterPath,
          year: it.releaseYear,
          rating: it.voteAverage,
          badge: <MatchBadge percent={it.matchPercent} />,
          seed: recToSummary(it),
        }),
      ),
    [taste],
  );

  const { seeds, source } = personalSeeds(signals);
  if (source === "none") return null;
  const subtitle = source === "liked" ? "Based on everything you've loved" : "Based on your watch history";
  if (taste) {
    // Several taste clusters: the backend names each side ("Blending 3 sides of your taste: …").
    const tasteSubtitle = taste.subtitle ?? subtitle;
    return (
      <StaticRow
        title="We Think You'll Love These"
        subtitle={tasteSubtitle}
        items={items}
        trusted={trusted}
        onViewMore={() =>
          navigate("browse", { browse: { kind: "static", key: `love:${recs?.generatedAt}`, title: "We Think You'll Love These", subtitle: tasteSubtitle, items: taste.items.map(recToSummary) } })
        }
      />
    );
  }
  if (recsLoading && !recs) {
    return (
      <RowShell title="We Think You'll Love These" subtitle="Ranking titles against your taste profile…">
        <div className="row-scroller">
          {Array.from({ length: 8 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </RowShell>
    );
  }
  return <HomeRow env={env} rowRef={{ id: "love", arg: encodeSeeds(seeds.slice(0, 8)), label: subtitle }} />;
}

/** "Your Next Watch": more like the three titles you watched last; trending picks for a new profile. */
function NextWatchRow({ signals, env }: { signals: PersonalSignals; env: RowEnv }) {
  const seeds = signals.recent.slice(0, 3);
  if (!seeds.length) return <HomeRow env={env} rowRef={{ id: "trending-week" }} />;
  return <HomeRow env={env} rowRef={{ id: "next-watch", arg: encodeSeeds(seeds), label: seeds[0]!.title }} />;
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
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const recs = useAppStore((s) => s.recs);
  const recsStale = useAppStore((s) => s.recsStale);
  const recsLoading = useAppStore((s) => s.recsLoading);
  const loadRecommendations = useAppStore((s) => s.loadRecommendations);
  const recsTrusted = useRecsTrusted();
  const signals = usePersonalSignals();
  const filtered = ctx.providers.length > 0;

  // Refresh once when new behaviour made the rows stale (e.g. after Back to Hub). Failures clear
  // `recsStale`, so this can never spin into a retry loop.
  useEffect(() => {
    if (recsStale && !recsLoading) void loadRecommendations();
  }, [recsStale, recsLoading, loadRecommendations]);

  // One env per catalog state; `exclude` keeps watched titles out of the personal rows.
  const env = useMemo<RowEnv>(
    () => ({ ctx, exclude: signals.watched }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogKey, signals.watched],
  );

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
    const personal = (recs?.rows.find((r) => r.kind === "taste")?.items ?? []).slice(0, 3).map(recToSummary);
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

  // Settings → Home Page Layout (before any early return: hooks keep their order).
  const profileId = useAppStore((s) => s.activeProfile?.profileId);
  const savedOrder = useAppStore((s) => (profileId ? s.settings[homeOrderKey(profileId)] : undefined));
  const homeOrder = useMemo(() => resolveHomeOrder(parseHomeOrder(savedOrder)), [savedOrder]);
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

  const row = (id: string) => <HomeRow key={id} env={env} rowRef={{ id }} />;

  return (
    <div>
      <HeroBillboard items={heroItems} />
      <div className="relative z-10 -mt-16 flex flex-col gap-11 pb-16 max-md:mt-2 max-md:gap-9" style={{ paddingLeft: "var(--content-left)", paddingRight: "var(--content-right)" }}>
        <ContinueWatchingRow />
        <HomeRow env={env} rowRef={{ id: "top10" }} variant="top10" />
        <BrandHubsRow />
        <MyListRow />
        <BrowseByServiceRow />
        {/* Everything below follows Settings → Home Page Layout (config/homeLayout.ts). */}
        {homeOrder.map((id) => {
          switch (id) {
            case "next-watch":
              return signals.loaded ? <NextWatchRow key={id} signals={signals} env={env} /> : null;
            case "because":
              return signals.loaded ? <BecauseRows key={id} signals={signals} env={env} /> : null;
            case "streaming":
              return <PopularOnStreamingRow key={id} env={env} />;
            case "love":
              return signals.loaded ? <LoveRow key={id} signals={signals} env={env} /> : null;
            default:
              return row(id);
          }
        })}
      </div>
    </div>
  );
}
