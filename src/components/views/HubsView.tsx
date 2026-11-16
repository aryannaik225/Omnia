/** Franchises & Hubs: hub directory, and a hub feed with combinable multi-facet filters. */
import { useState } from "react";
import { HUB_CATEGORY_LABELS, hubRule, type HubCategory } from "../../config/hubsRegistry";
import { useAsync } from "../../lib/hooks";
import { DEFAULT_FACETS, hubArtwork, hubOrders, loadHubPage, loadOrderedHub, type HubFacets, type HubOrder } from "../../services/catalog";
import { img, type CatalogContext, type MediaSummary } from "../../services/tmdbClient";
import type { CustomHub } from "../../services/tauriBridge";
import { useAppStore, useCatalogKey } from "../../store/useAppStore";
import { ChevronLeftIcon } from "../common/Icons";
import { MediaGrid } from "../common/MediaGrid";
import { HubPill } from "../home/BrandHubsRow";
import { PageHeader } from "./BrowseViews";

type Option<T extends string> = { value: T; label: string };

const MEDIA: Option<HubFacets["mediaType"]>[] = [
  { value: "all", label: "All" },
  { value: "movie", label: "Movies" },
  { value: "tv", label: "Series" },
];
const RUNTIME: Option<HubFacets["runtime"]>[] = [
  { value: "any", label: "Any length" },
  { value: "short", label: "Under 90 mins" },
  { value: "epic", label: "Epic 2.5h+" },
];
const ERA: Option<HubFacets["era"]>[] = [
  { value: "any", label: "Any era" },
  { value: "2020s", label: "2020s" },
  { value: "2010s", label: "2010s" },
  { value: "2000s", label: "2000s" },
  { value: "1990s", label: "1990s" },
  { value: "classic", label: "Classics" },
];
const LANGUAGE: Option<string>[] = [
  { value: "any", label: "Any language" },
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
  { value: "ta", label: "Tamil" },
  { value: "te", label: "Telugu" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
];

function ChipGroup<T extends string>({ options, value, onChange }: { options: Option<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button key={o.value} className="chip" data-active={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function HubDetail({ hub, onBack }: { hub: CustomHub; onBack: () => void }) {
  const rule = hubRule(hub);
  const ctx = useAppStore((s) => s.catalogContext)();
  const catalogKey = useCatalogKey();
  const kidsProfile = useAppStore((s) => s.isKids());
  const region = useAppStore((s) => s.region);
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const orders = hubOrders(hub);
  const [order, setOrder] = useState<HubOrder | null>(orders[0] ?? null);
  const [facets, setFacets] = useState<HubFacets>(DEFAULT_FACETS);
  const set = <K extends keyof HubFacets>(k: K, v: HubFacets[K]) => setFacets((f) => ({ ...f, [k]: v }));
  const feedKey = `${hub.hubSlug}|${catalogKey}|${JSON.stringify(facets)}|${order ?? "popular"}`;
  const art = useAsync(() => hubArtwork(hub, region), [hub.hubSlug, region], tmdbReady);
  const hero = img(art.data?.backdropPath, "w1280");
  const [heroLoaded, setHeroLoaded] = useState(false);

  return (
    <div className="pb-16">
      <div
        className="relative mb-8 mt-8 flex min-h-[340px] flex-col justify-end overflow-hidden rounded-panel px-10 pb-10 pt-8"
        style={{ background: `linear-gradient(120deg, ${rule.theme.from} 0%, ${rule.theme.to} 100%)` }}
      >
        {hero && (
          <img
            src={hero}
            alt=""
            onLoad={() => setHeroLoaded(true)}
            className={`absolute inset-0 h-full w-full object-cover object-[center_25%] transition-opacity duration-700 ${heroLoaded ? "opacity-100" : "opacity-0"}`}
          />
        )}
        {/* Legibility: dark from the bottom-left where the title sits, theme tint over the art. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: `linear-gradient(0deg, ${rule.theme.from}f2 0%, ${rule.theme.from}99 35%, transparent 75%), linear-gradient(90deg, rgba(0,0,0,0.55) 0%, transparent 60%)`,
          }}
        />
        <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full blur-3xl" style={{ background: `${rule.theme.accent}40` }} />
        <button className="chip absolute left-10 top-8 !bg-black/40 !text-white backdrop-blur-md" onClick={onBack}>
          <ChevronLeftIcon size={14} /> All hubs
        </button>
        <div className="relative">
          <h1 className="text-[48px] font-bold tracking-tight drop-shadow-lg" style={{ textShadow: `0 0 40px ${rule.theme.accent}55` }}>
            {hub.displayName}
          </h1>
          {rule.tagline && <p className="mt-1 text-[17px] text-white/85 drop-shadow">{rule.tagline}</p>}
          {orders.length > 1 && order && (
            <div className="mt-5 flex gap-2" role="radiogroup" aria-label="Order">
              {orders.map((o) => (
                <button key={o} role="radio" aria-checked={order === o} className="chip !bg-black/40 backdrop-blur-md" data-active={order === o} onClick={() => setOrder(o)}>
                  {o === "release" ? "Release Order" : "Timeline Order"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="glass-panel mb-8 flex flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <ChipGroup options={MEDIA} value={facets.mediaType} onChange={(v) => set("mediaType", v)} />
          <ChipGroup options={RUNTIME} value={facets.runtime} onChange={(v) => set("runtime", v)} />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <ChipGroup options={ERA} value={facets.era} onChange={(v) => set("era", v)} />
          <ChipGroup options={LANGUAGE} value={facets.language} onChange={(v) => set("language", v)} />
          {!kidsProfile && (
            <button className="chip" data-active={facets.kidsSafe} onClick={() => set("kidsSafe", !facets.kidsSafe)}>
              Kids & Family safe
            </button>
          )}
        </div>
        {facets.runtime !== "any" && facets.mediaType !== "movie" && <p className="text-[12px] text-label-tertiary">Runtime filters apply to movies.</p>}
      </div>

      {order ? (
        <OrderedHubFeed hub={hub} ctx={ctx} facets={facets} order={order} feedKey={feedKey} />
      ) : (
        <HubFeed hub={hub} ctx={ctx} facets={facets} feedKey={feedKey} />
      )}
    </div>
  );
}

/** Hub feed: pinned franchise collections (release order) followed by paged discover results. */
function HubFeed({ hub, ctx, facets, feedKey }: { hub: CustomHub; ctx: CatalogContext; facets: HubFacets; feedKey: string }) {
  const [pinned, setPinned] = useState<{ key: string; items: MediaSummary[] }>({ key: "", items: [] });
  return (
    <MediaGrid
      feedKey={feedKey}
      header={pinned.key === feedKey ? pinned.items : []}
      loadPage={async (page) => {
        const res = await loadHubPage(hub, ctx, facets, page);
        if (page === 1) setPinned({ key: feedKey, items: res.pinned });
        return res;
      }}
      filter={(m) => !!m.posterPath}
      emptyMessage="No titles match these filters in your region."
    />
  );
}

/** Franchise feed: every title at once, in release (or story) order. */
function OrderedHubFeed({ hub, ctx, facets, order, feedKey }: { hub: CustomHub; ctx: CatalogContext; facets: HubFacets; order: HubOrder; feedKey: string }) {
  return (
    <MediaGrid
      feedKey={feedKey}
      loadPage={async () => ({ results: await loadOrderedHub(hub, ctx, facets, order), totalPages: 1 })}
      filter={(m) => !!m.posterPath}
      emptyMessage="No titles match these filters in your region."
    />
  );
}

export function HubsView() {
  const hubs = useAppStore((s) => s.hubs);
  const activeHub = useAppStore((s) => s.activeHub);
  const navigate = useAppStore((s) => s.navigate);
  const kids = useAppStore((s) => s.isKids());
  const hub = hubs.find((h) => h.hubSlug === activeHub);

  if (hub) return <HubDetail hub={hub} onBack={() => navigate("hubs", { hub: null })} />;

  const visible = kids ? hubs.filter((h) => hubRule(h).kidsSafe || ["disney-pixar", "studio-ghibli"].includes(h.hubSlug)) : hubs;
  const groups = (Object.keys(HUB_CATEGORY_LABELS) as HubCategory[])
    .map((cat) => ({ cat, items: visible.filter((h) => h.categoryType === cat) }))
    .filter((g) => g.items.length);
  const other = visible.filter((h) => !(h.categoryType in HUB_CATEGORY_LABELS));

  return (
    <div className="pb-16">
      <PageHeader title="Franchises & Hubs" subtitle="Universes, studios, originals and curated collections" />
      {[...groups, ...(other.length ? [{ cat: "custom" as const, items: other }] : [])].map((g) => (
        <section key={g.cat} className="mb-10">
          <h2 className="section-title mb-4">{g.cat === "custom" ? "Your hubs" : HUB_CATEGORY_LABELS[g.cat]}</h2>
          <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {g.items.map((h) => (
              <HubPill key={h.hubSlug} hub={h} width="fill" onClick={() => navigate("hubs", { hub: h.hubSlug })} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
