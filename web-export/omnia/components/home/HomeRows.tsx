"use client";
/**
 * Registry-backed Home rows (config/homeRows): lazy fetch on approach, kids / subscription
 * filtering, the 20-title cap with a "View More" card, plus the service rows (Browse by Service,
 * IMDb Popular on Streaming) built from the region's provider list.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { dedupe, regionName, resolveRow, ROW_CAP, type RowEnv } from "../../config/homeRows";
import { useFilterFamilies, useSubscriptionFilter } from "../../lib/availability";
import { useAsync, useInView } from "../../lib/hooks";
import { groupByFamily } from "../../lib/providers";
import { img, isKidsSafe, regionProviders, type MediaSummary, type WatchProviderOption } from "../../services/tmdbClient";
import { useAppStore, useCatalogKey, type BrowseTarget, type RowRef } from "../../store/useAppStore";
import { ServiceCard, SkeletonCard } from "../common/Cards";
import { fromSummary, MediaCarouselRow, RowShell, type CarouselItem } from "./MediaCarouselRow";

/** Titles checked per row for "My Subscriptions" (enough to fill 20 after filtering). */
const VERIFY_POOL = 40;

export const refKey = (r: RowRef) => `${r.id}|${r.arg ?? ""}|${r.label ?? ""}`;

export function HomeRow({
  rowRef,
  env,
  title,
  variant = "poster",
  extra,
  keepEmpty = false,
}: {
  rowRef: RowRef;
  env: RowEnv;
  /** Heading override (the registry title is still used by the full-page grid). */
  title?: string;
  variant?: "poster" | "top10";
  extra?: ReactNode;
  keepEmpty?: boolean;
}) {
  const catalogKey = useCatalogKey();
  const kids = useAppStore((s) => s.isKids());
  const navigate = useAppStore((s) => s.navigate);
  const spec = resolveRow(rowRef, env);
  const [ref, inView] = useInView<HTMLDivElement>("700px");
  const { data, loading, error } = useAsync(() => spec!.load(1), [catalogKey, refKey(rowRef)], inView && !!spec);

  const pool = useMemo(
    () =>
      dedupe(data?.results ?? [])
        .filter((m) => m.posterPath && (!kids || spec?.sourceFiltered || isKidsSafe(m)))
        .slice(0, VERIFY_POOL),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, kids],
  );
  const exempt = !!spec?.ignoreSubscriptions;
  const filtered = useSubscriptionFilter(exempt ? EMPTY : pool, (m) => ({ id: m.id, mediaType: m.mediaType, trusted: !!spec?.sourceFiltered }));
  const visible = exempt ? pool : filtered.items;
  const cap = variant === "top10" ? 10 : ROW_CAP;
  const items = useMemo(() => visible.slice(0, cap).map(fromSummary), [visible, cap]);

  if (!spec) return null;
  const done = inView && !loading && !filtered.checking;
  const empty = done && (error !== null || items.length === 0) && !keepEmpty;
  const hasMore = (data?.totalPages ?? 1) > 1 || visible.length > cap;
  return (
    // The placeholder height only holds the row's place until it has loaded.
    <div ref={ref} className={done ? "" : "min-h-[300px]"}>
      {!empty && (
        <MediaCarouselRow
          title={title ?? spec.title}
          subtitle={spec.subtitle}
          extra={extra}
          items={items}
          variant={variant}
          keepEmpty={keepEmpty}
          loading={!inView || loading || (filtered.checking && items.length === 0)}
          onViewMore={hasMore && variant !== "top10" ? () => navigate("browse", { browse: { kind: "row", ref: rowRef } }) : undefined}
        />
      )}
    </div>
  );
}

const EMPTY: MediaSummary[] = [];

/**
 * A row over data already in memory (watchlist, backend ML rows). Posters mount only when the
 * row nears the viewport; past 20 titles a "View More" card opens the full list.
 */
export function StaticRow({
  title,
  subtitle,
  items,
  loading = false,
  trusted = true,
  ignoreSubscriptions = false,
  onViewMore,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  items: CarouselItem[];
  loading?: boolean;
  /** Items already match the active provider filter (otherwise they're verified first). */
  trusted?: boolean;
  /** Your own lists (My List) show every title, whatever the subscription filter. */
  ignoreSubscriptions?: boolean;
  onViewMore?: () => void;
}) {
  const [ref, inView] = useInView<HTMLDivElement>("700px");
  const filtered = useSubscriptionFilter(inView && !ignoreSubscriptions ? items : NO_ITEMS, (it) => ({ id: it.id, mediaType: it.mediaType, trusted }));
  const visible = ignoreSubscriptions ? items : filtered.items;
  const checking = !ignoreSubscriptions && filtered.checking;
  if (inView && !loading && !checking && visible.length === 0) return null;
  return (
    <div ref={ref} className={inView ? "" : "min-h-[300px]"}>
      <MediaCarouselRow
        title={title}
        subtitle={subtitle}
        items={visible.slice(0, ROW_CAP)}
        loading={!inView || loading || (checking && visible.length === 0)}
        onViewMore={visible.length > ROW_CAP ? onViewMore : undefined}
      />
    </div>
  );
}

const NO_ITEMS: CarouselItem[] = [];

// ---------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------

export interface RegionService {
  key: string;
  name: string;
  /** All provider ids of the family in this region ("8|1796"). */
  ids: string;
  logoPath: string | null;
}

/** Stores that only rent / sell, not subscription services. */
const NOT_A_SERVICE = new Set(["googleplay", "youtube"]);
/** Aggregator / directory entries TMDB lists as providers. */
const NOT_A_SERVICE_NAME = /justwatch|plex channel|freevee channel/i;
const MAX_SERVICES = 16;

/** The region's streaming services (one per family, most prominent first). */
export function useRegionServices(enabled: boolean) {
  const region = useAppStore((s) => s.region);
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const families = useFilterFamilies();
  const { data, loading } = useAsync(() => regionProviders(region), [region], enabled && tmdbReady);
  const services = useMemo(() => {
    const only = new Set(families.split(",").filter(Boolean));
    return groupByFamily(data ?? [], (p: WatchProviderOption) => p.providerId, (p) => p.providerName)
      .filter(({ family }) => !NOT_A_SERVICE.has(family.key) && !NOT_A_SERVICE_NAME.test(family.name) && (!only.size || only.has(family.key)))
      .slice(0, MAX_SERVICES)
      .map(
        ({ family, members }): RegionService => ({
          key: family.key,
          name: family.name,
          ids: members.map((m) => m.providerId).join("|"),
          logoPath: members.find((m) => m.logoPath)?.logoPath ?? null,
        }),
      );
  }, [data, families]);
  return { services, loading: loading || (!data && enabled) };
}

export const serviceTarget = (s: RegionService): BrowseTarget => ({ kind: "row", ref: { id: "service", arg: s.ids, label: s.name }, logoPath: s.logoPath });

export function BrowseByServiceRow() {
  const [ref, inView] = useInView<HTMLDivElement>("700px");
  const { services, loading } = useRegionServices(inView);
  const navigate = useAppStore((s) => s.navigate);
  const region = useAppStore((s) => s.region);
  const scroller = useRef<HTMLDivElement | null>(null);
  if (inView && !loading && services.length === 0) return null;
  return (
    <div ref={ref} className="min-h-[170px]">
      <RowShell
        title="Browse by Service"
        subtitle={`Everything popular on each service in ${regionName(region)}`}
        onScroll={(dir) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: "smooth" })}
      >
        <div ref={scroller} className="row-scroller">
          {!inView || loading
            ? Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} landscape width={220} />)
            : services.map((s) => <ServiceCard key={s.key} name={s.name} logoPath={s.logoPath} onClick={() => navigate("browse", { browse: serviceTarget(s) })} />)}
        </div>
      </RowShell>
    </div>
  );
}

/** "IMDb Popular on Streaming" with platform icons by the heading; Netflix by default. */
export function PopularOnStreamingRow({ env }: { env: RowEnv }) {
  const [ref, inView] = useInView<HTMLDivElement>("900px");
  const { services, loading } = useRegionServices(inView);
  const [picked, setPicked] = useState<string | null>(null);
  const chips = services.slice(0, 7);
  const active = chips.find((s) => s.key === picked) ?? chips.find((s) => s.key === "netflix") ?? chips[0];

  if (inView && !loading && !active) return null;
  return (
    <div ref={ref} className="min-h-[300px]">
      {active && (
        <HomeRow
          key="streaming"
          title="IMDb Popular on Streaming"
          keepEmpty
          env={env}
          rowRef={{ id: "streaming", arg: active.ids, label: active.name }}
          extra={
            <div className="flex items-center gap-2" role="group" aria-label="Filter by service">
              {chips.map((s) => (
                <button key={s.key} type="button" className="provider-chip" aria-pressed={s.key === active.key} aria-label={s.name} title={s.name} onClick={() => setPicked(s.key)}>
                  {s.logoPath ? <img src={img(s.logoPath, "w92")!} alt="" className="h-full w-full object-cover" draggable={false} /> : <span className="text-[10px] font-bold">{s.name.slice(0, 2)}</span>}
                </button>
              ))}
            </div>
          }
        />
      )}
    </div>
  );
}
