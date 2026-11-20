"use client";
/**
 * Home, web edition of the desktop's HomeView: hero, then the same curated row line-up
 * (Continue Watching → Top 10 → hubs → My List → services → catalog, personal and themed rows).
 * Rows mount and fetch only as they near the viewport and end in a "View More" grid.
 *
 * Personal rows come from the manual tracker (Because you watched…, Your Next Watch); the
 * on-device taste model ("We Think You'll Love These") is a desktop feature.
 */
import { useMemo } from "react";
import { useTracker } from "@/components/tracker/TrackerProvider";
import { useSummaries } from "@/components/tracker/useSummaries";
import { encodeSeeds, type RowEnv } from "../../config/homeRows";
import { resolveHomeOrder } from "../../config/homeLayout";
import { useSubscriptionFilter } from "../../lib/availability";
import { useAsync } from "../../lib/hooks";
import { usePersonalSignals, type PersonalSignals } from "../../lib/personal";
import { discover, isKidsSafe, trending, type MediaSummary } from "../../services/tmdbClient";
import { useAppStore, useCatalogKey } from "../../store/useAppStore";
import { DesktopBadge } from "../common/DesktopOnly";
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

/** "My List": the watchlist, most recently added first; View More opens the full list. */
function MyListRow() {
  const t = useTracker();
  const navigate = useAppStore((s) => s.navigate);
  const keys = useMemo(
    () =>
      Object.entries(t.data.watchlist)
        .sort((a, b) => b[1].localeCompare(a[1]))
        .map(([k]) => k),
    [t.data.watchlist],
  );
  const { titles } = useSummaries(keys);
  const items = useMemo(
    () =>
      keys.flatMap((k): CarouselItem[] => {
        const s = titles.get(k);
        return s ? [{ id: s.id, mediaType: s.mediaType, title: s.title, posterPath: s.posterPath, year: s.year, rating: s.voteAverage }] : [];
      }),
    [keys, titles],
  );
  if (!items.length) return null;
  return <StaticRow title="My List" subtitle="Saved with + Up Next, newest first" items={items} ignoreSubscriptions onViewMore={() => navigate("watchlist")} />;
}

/** "Because you watched …": up to two rows from the two titles you tracked most recently. */
function BecauseRows({ signals, env }: { signals: PersonalSignals; env: RowEnv }) {
  if (!signals.recent.length) return null;
  return (
    <>
      {signals.recent.slice(0, 2).map((s) => (
        <HomeRow key={`${s.mediaType}:${s.id}`} env={env} rowRef={{ id: "because-watched", arg: encodeSeeds([s]), label: s.title }} />
      ))}
    </>
  );
}

/** "Your Next Watch": more like the three titles you watched last; trending picks for a new library. */
function NextWatchRow({ signals, env }: { signals: PersonalSignals; env: RowEnv }) {
  const seeds = signals.recent.slice(0, 3);
  if (!seeds.length) return <HomeRow env={env} rowRef={{ id: "trending-week" }} />;
  return <HomeRow env={env} rowRef={{ id: "next-watch", arg: encodeSeeds(seeds), label: seeds[0]!.title }} />;
}

/** Where the desktop shows its on-device taste row: a quiet pointer instead of an empty gap. */
function LoveRowPlaceholder() {
  return (
    <RowShell title="We Think You'll Love These" subtitle="Ranked by a taste model that runs on your own PC" extra={<DesktopBadge />}>
      <div className="glass-panel relative overflow-hidden px-6 py-5 text-[14px] text-label-secondary">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,rgba(255,255,255,0.08),rgba(255,255,255,0)_40%)]" />
        <p className="relative max-w-[640px]">
          Omnia Desktop learns your taste on-device from what you watch, binge and abandon, and builds personal rows like this one. Nothing about your viewing ever leaves your computer.
        </p>
      </div>
    </RowShell>
  );
}

export function HomeView() {
  // Settings → Home Page Layout (this browser's, or the account's when signed in).
  const savedOrder = useTracker().homeRowOrder;
  const homeOrder = useMemo(() => resolveHomeOrder(savedOrder), [savedOrder]);
  const catalogKey = useCatalogKey();
  const ctx = useAppStore((s) => s.catalogContext)();
  const kids = useAppStore((s) => s.isKids());
  const signals = usePersonalSignals();
  const filtered = ctx.providers.length > 0;

  // One env per catalog state; `exclude` keeps watched titles out of the personal rows.
  const env = useMemo<RowEnv>(
    () => ({ ctx, exclude: signals.watched }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogKey, signals.watched],
  );

  const heroSource = useAsync(async () => {
    const key = catalogKey;
    if (filtered || kids) {
      const [mv, tv] = await Promise.all([discover("movie", ctx), discover("tv", ctx)]);
      return { key, items: interleave(mv.results, tv.results) };
    }
    return { key, items: (await trending("all", "week")).results };
  }, [catalogKey]);
  const heroSourceTrusted = heroSource.data?.key === catalogKey;

  const heroCandidates = useMemo(() => {
    const general = (heroSource.data?.items ?? []).filter((m) => !kids || isKidsSafe(m));
    const seen = new Set<string>();
    return general
      .map((m) => ({ m, trusted: heroSourceTrusted }))
      .filter(({ m }) => {
        const k = `${m.mediaType}-${m.id}`;
        if (seen.has(k) || !m.backdropPath) return false;
        seen.add(k);
        return true;
      });
  }, [heroSource.data, kids, heroSourceTrusted]);
  const heroFiltered = useSubscriptionFilter(heroCandidates, ({ m, trusted }) => ({ id: m.id, mediaType: m.mediaType, trusted }));
  const heroItems = useMemo(() => heroFiltered.items.map(({ m }) => m), [heroFiltered.items]);

  if (heroSource.error && !heroSource.data) {
    return (
      <div className="px-10 pt-10" style={{ paddingLeft: "var(--content-left)" }}>
        <div className="glass-panel max-w-xl px-8 py-7">
          <h2 className="text-2xl font-semibold">The catalog is unavailable</h2>
          <p className="mt-2 text-label-secondary">{heroSource.error}</p>
          <button className="glass-button mt-5" onClick={heroSource.reload}>
            Try again
          </button>
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
        {/* Everything below follows Settings → Home Page Layout (omnia/config/homeLayout.ts). */}
        {homeOrder.map((id) => {
          switch (id) {
            case "next-watch":
              return signals.loaded ? <NextWatchRow key={id} signals={signals} env={env} /> : null;
            case "because":
              return signals.loaded ? <BecauseRows key={id} signals={signals} env={env} /> : null;
            case "streaming":
              return <PopularOnStreamingRow key={id} env={env} />;
            case "love":
              return <LoveRowPlaceholder key={id} />;
            default:
              return row(id);
          }
        })}
      </div>
    </div>
  );
}
