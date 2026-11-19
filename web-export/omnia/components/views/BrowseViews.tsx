"use client";
/** Search and My OTTs views (the web's tracker views live in LibraryView). */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useDebounced } from "../../lib/hooks";
import { groupByFamily } from "../../lib/providers";
import { discover, img, isKidsSafe, searchMulti, type MediaSummary } from "../../services/tmdbClient";
import { useAppStore, useCatalogKey } from "../../store/useAppStore";
import { PosterCard } from "../common/Cards";
import { MediaGrid } from "../common/MediaGrid";
import { LazyTmdbRow } from "../home/MediaCarouselRow";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-8 mt-10 flex items-end justify-between gap-6 max-md:mt-6 max-md:flex-wrap max-md:gap-3">
      <div>
        <h1 className="text-[34px] max-md:text-[28px] font-bold tracking-tight">{title}</h1>
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
  useEffect(() => {
    const want = debounced ? `/app/search?q=${encodeURIComponent(debounced)}` : "/app/search";
    if (window.location.pathname + window.location.search !== want) window.history.replaceState(null, "", want);
  }, [debounced]);

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
