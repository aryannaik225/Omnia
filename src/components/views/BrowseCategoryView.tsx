/**
 * Full-page grid behind a Home row's "View More" card and the "Popular on [Platform]" service
 * pages. Registry rows page through their TMDB query; in-memory rows (ML picks) show their list.
 */
import { useMemo } from "react";
import { resolveRow, staticLoader } from "../../config/homeRows";
import { usePersonalSignals } from "../../lib/personal";
import { img, isKidsSafe } from "../../services/tmdbClient";
import { browseKey, useAppStore, useCatalogKey } from "../../store/useAppStore";
import { ChevronLeftIcon } from "../common/Icons";
import { MediaGrid } from "../common/MediaGrid";

const PERSONAL_ROWS = new Set(["because", "because-watched", "next-watch", "love"]);

export function BrowseCategoryView() {
  const target = useAppStore((s) => s.browse);
  const from = useAppStore((s) => s.browseFrom);
  const navigate = useAppStore((s) => s.navigate);
  const ctx = useAppStore((s) => s.catalogContext)();
  const kids = useAppStore((s) => s.isKids());
  const catalogKey = useCatalogKey();
  const { watched, loaded } = usePersonalSignals();
  // Personal feeds leave out what you've watched: wait for the history before the first page.
  const personal = target?.kind === "row" && PERSONAL_ROWS.has(target.ref.id);

  const page = useMemo(() => {
    if (!target) return null;
    if (target.kind === "static") {
      return { title: target.title, subtitle: target.subtitle, load: staticLoader(target.items), sourceFiltered: false, exempt: false };
    }
    const spec = resolveRow(target.ref, { ctx, exclude: watched });
    if (!spec) return null;
    return { title: spec.title, subtitle: spec.subtitle, load: spec.load, sourceFiltered: spec.sourceFiltered, exempt: !!spec.ignoreSubscriptions };
    // `ctx` is rebuilt every render; `catalogKey` captures everything it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, catalogKey, watched]);

  if (!target || !page) {
    return (
      <div className="py-16 text-center text-label-secondary">
        This list is no longer available.
        <div className="mt-4">
          <button className="glass-button" onClick={() => navigate("home")}>
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  const logo = target.kind === "row" ? img(target.logoPath, "w154") : null;
  return (
    <div className="pb-16">
      <div className="mb-7 flex items-center gap-4">
        <button className="icon-button shrink-0" onClick={() => navigate(from)} aria-label="Back">
          <ChevronLeftIcon size={18} />
        </button>
        {logo && <img src={logo} alt="" className="h-12 w-12 shrink-0 rounded-[12px] shadow-[0_6px_18px_rgba(0,0,0,0.4)]" draggable={false} />}
        <div className="min-w-0">
          <h1 className="truncate text-[28px] font-bold tracking-tight max-md:text-[22px]">{page.title}</h1>
          {page.subtitle && <p className="truncate text-[14px] text-label-secondary">{page.subtitle}</p>}
        </div>
      </div>
      {personal && !loaded ? (
        <div className="skeleton h-[40vh] rounded-panel" />
      ) : (
        <MediaGrid
          feedKey={`${browseKey(target)}|${catalogKey}`}
          loadPage={page.load}
          verify={!page.sourceFiltered && !page.exempt}
          filter={(m) => !!m.posterPath && (!kids || page.sourceFiltered || isKidsSafe(m))}
          emptyMessage="Nothing in this category matches your filters right now."
        />
      )}
    </div>
  );
}
