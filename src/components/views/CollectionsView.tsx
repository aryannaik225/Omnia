/** Collections: the profile's own lists ("Date night", "Best of 2025") plus everything it Loved. */
import { useMemo, useState } from "react";
import { useAsync } from "../../lib/hooks";
import { img, type MediaSummary } from "../../services/tmdbClient";
import { collections, favorites, type Collection, type WatchlistItem } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { PosterCard } from "../common/Cards";
import { EmptyState } from "../common/EmptyState";
import { ChevronLeftIcon, HeartIcon, PencilIcon, PlusIcon, StackIcon, TrashIcon } from "../common/Icons";
import { PageHeader } from "./BrowseViews";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const toSummary = (i: WatchlistItem): MediaSummary => ({
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
});

const GRID = { gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" };

/** "loved" = the favorites pseudo-collection. */
type Open = { kind: "loved" } | { kind: "collection"; id: number };

function Cover({ posters, loved = false }: { posters: string[]; loved?: boolean }) {
  const tiles = posters.slice(0, 4);
  return (
    <span className="relative grid aspect-[4/3] w-full grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded-card bg-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
      {tiles.map((p, i) => (
        <img
          key={p + i}
          src={img(p, "w185") ?? undefined}
          alt=""
          loading="lazy"
          className={`h-full w-full object-cover ${tiles.length === 1 ? "col-span-2 row-span-2" : tiles.length === 2 ? "row-span-2" : tiles.length === 3 && i === 0 ? "row-span-2" : ""}`}
        />
      ))}
      {!tiles.length && (
        <span className="col-span-2 row-span-2 flex items-center justify-center text-label-tertiary">
          {loved ? <HeartIcon size={34} /> : <StackIcon size={34} />}
        </span>
      )}
      {loved && tiles.length > 0 && (
        <span className="absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-[#ff375f] backdrop-blur-md">
          <HeartIcon size={15} filled />
        </span>
      )}
    </span>
  );
}

function CollectionCard({ name, count, posters, loved, onOpen }: { name: string; count: number; posters: string[]; loved?: boolean; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="group flex flex-col gap-2.5 text-left">
      <span className="block transition-transform duration-300 group-hover:scale-[1.03] group-focus-visible:scale-[1.03]">
        <Cover posters={posters} loved={loved} />
      </span>
      <span>
        <span className="block truncate text-[15px] font-semibold">{name}</span>
        <span className="text-[12px] text-label-tertiary">
          {count} title{count === 1 ? "" : "s"}
        </span>
      </span>
    </button>
  );
}

function TitleGrid({ items, onRemove, removeLabel }: { items: WatchlistItem[]; onRemove: (i: WatchlistItem) => void; removeLabel: string }) {
  const openTitle = useAppStore((s) => s.openTitle);
  const seeds = useMemo(() => items.map((i) => ({ item: i, seed: toSummary(i) })), [items]);
  return (
    <div className="grid gap-x-5 gap-y-7" style={GRID}>
      {seeds.map(({ item, seed }) => (
        <PosterCard
          key={`${seed.mediaType}-${seed.id}`}
          title={seed.title}
          posterPath={seed.posterPath}
          year={seed.year}
          rating={seed.voteAverage}
          width="fill"
          cornerAction={
            <span
              role="button"
              tabIndex={0}
              aria-label={`${removeLabel}: ${seed.title}`}
              title={removeLabel}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-black/55 backdrop-blur-md hover:text-[#ff453a]"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(item);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  onRemove(item);
                }
              }}
            >
              <TrashIcon size={14} />
            </span>
          }
          onClick={() => openTitle({ id: seed.id, mediaType: seed.mediaType, seed })}
        />
      ))}
    </div>
  );
}

function CollectionDetail({ open, list, onBack, onChanged }: { open: Open; list: Collection | undefined; onBack: () => void; onChanged: () => void }) {
  const profile = useAppStore((s) => s.activeProfile)!;
  const toast = useAppStore((s) => s.toast);
  const markRecsStale = useAppStore((s) => s.markRecsStale);
  const [nonce, setNonce] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const items = useAsync(
    () => (open.kind === "loved" ? favorites.list(profile.profileId) : collections.items(profile.profileId, open.id)),
    [profile.profileId, open.kind, open.kind === "collection" ? open.id : 0, nonce],
  );
  const loved = open.kind === "loved";
  const title = loved ? "Loved" : (list?.name ?? "Collection");

  const remove = async (i: WatchlistItem) => {
    try {
      if (loved) {
        await favorites.set(profile.profileId, i.tmdbId, i.mediaType, false);
        markRecsStale();
      } else if (open.kind === "collection") await collections.removeItem(profile.profileId, open.id, i.tmdbId, i.mediaType);
      setNonce((n) => n + 1);
      onChanged();
    } catch (e) {
      toast({ kind: "error", title: "Couldn't remove it", body: errorText(e) });
    }
  };

  const rename = async () => {
    if (open.kind !== "collection" || renaming === null) return;
    try {
      await collections.rename(profile.profileId, open.id, renaming);
      setRenaming(null);
      onChanged();
    } catch (e) {
      toast({ kind: "error", title: "Couldn't rename", body: errorText(e) });
    }
  };

  const destroy = async () => {
    if (open.kind !== "collection") return;
    try {
      await collections.remove(profile.profileId, open.id);
      toast({ kind: "info", title: "Collection deleted", body: title });
      onChanged();
      onBack();
    } catch (e) {
      toast({ kind: "error", title: "Couldn't delete", body: errorText(e) });
    }
  };

  return (
    <div className="pb-16">
      <button className="glass-button mt-10 !px-3 !py-2" onClick={onBack}>
        <ChevronLeftIcon size={16} /> Collections
      </button>
      <header className="mb-8 mt-5 flex flex-wrap items-end justify-between gap-6">
        {renaming !== null ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <input
              autoFocus
              value={renaming}
              maxLength={60}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
              aria-label="Collection name"
              className="rounded-pill bg-white/10 px-4 py-2 text-[28px] font-bold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            />
            <button type="submit" className="glass-button-primary !py-2.5">
              Save
            </button>
            <button type="button" className="glass-button !py-2.5" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <div>
            <h1 className="flex items-center gap-3 text-[34px] font-bold tracking-tight">
              {loved && <HeartIcon size={28} filled className="text-[#ff375f]" />}
              {title}
            </h1>
            <p className="mt-1 text-label-secondary">
              {loved ? "Titles you love count the most towards your recommendations" : `${items.data?.length ?? list?.itemCount ?? 0} titles`}
            </p>
          </div>
        )}
        {!loved && renaming === null && (
          <div className="flex items-center gap-2">
            <button className="glass-button !py-2.5" onClick={() => setRenaming(list?.name ?? "")}>
              <PencilIcon size={15} /> Rename
            </button>
            {confirmDelete ? (
              <>
                <button className="glass-button !py-2.5" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button className="glass-button !bg-[#ff453a]/80 !py-2.5 !text-white hover:!bg-[#ff453a]" onClick={() => void destroy()}>
                  <TrashIcon size={15} /> Delete “{title}”
                </button>
              </>
            ) : (
              <button className="glass-button !py-2.5 text-[#ff6961]" onClick={() => setConfirmDelete(true)}>
                <TrashIcon size={15} /> Delete
              </button>
            )}
          </div>
        )}
      </header>
      {items.data?.length ? (
        <TitleGrid items={items.data} onRemove={(i) => void remove(i)} removeLabel={loved ? "Remove from Loved" : "Remove from collection"} />
      ) : items.loading ? (
        <div className="grid gap-x-5 gap-y-7" style={GRID}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton aspect-[2/3] rounded-card" />
          ))}
        </div>
      ) : (
        <EmptyState
          size="row"
          actions={false}
          title={loved ? "Nothing loved yet" : "This collection is empty"}
          body={loved ? "Tap ♥ Love on any title you adore: it shapes your recommendations." : "Open any movie or series and use “Add to Collection”."}
        />
      )}
    </div>
  );
}

export function CollectionsView() {
  const profile = useAppStore((s) => s.activeProfile);
  const toast = useAppStore((s) => s.toast);
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState<Open | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const lists = useAsync(() => collections.list(profile!.profileId), [profile?.profileId, nonce], !!profile);
  const loved = useAsync(() => favorites.list(profile!.profileId), [profile?.profileId, nonce], !!profile);
  const refresh = () => setNonce((n) => n + 1);

  if (!profile) return null;
  if (open) {
    const list = open.kind === "collection" ? lists.data?.find((c) => c.collectionId === open.id) : undefined;
    return <CollectionDetail key={open.kind === "collection" ? open.id : "loved"} open={open} list={list} onBack={() => setOpen(null)} onChanged={refresh} />;
  }

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const c = await collections.create(profile.profileId, name);
      setName("");
      refresh();
      setOpen({ kind: "collection", id: c.collectionId });
    } catch (e) {
      toast({ kind: "error", title: "Couldn't create the collection", body: errorText(e) });
    } finally {
      setCreating(false);
    }
  };

  const lovedItems = loved.data ?? [];
  return (
    <div className="pb-16">
      <PageHeader
        title="Collections"
        subtitle="Your own lists of movies and series"
        actions={
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="New collection name"
              aria-label="New collection name"
              className="w-[220px] rounded-pill bg-white/10 px-4 py-2.5 text-[14px] outline-none placeholder:text-label-tertiary focus-visible:ring-2 focus-visible:ring-white/70"
            />
            <button type="submit" className="glass-button-primary !py-2.5" disabled={creating || !name.trim()}>
              <PlusIcon size={16} /> Create
            </button>
          </form>
        }
      />
      <div className="grid gap-x-6 gap-y-8" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        <CollectionCard
          name="Loved"
          loved
          count={lovedItems.length}
          posters={lovedItems.map((i) => i.posterPath).filter((p): p is string => !!p)}
          onOpen={() => setOpen({ kind: "loved" })}
        />
        {(lists.data ?? []).map((c) => (
          <CollectionCard key={c.collectionId} name={c.name} count={c.itemCount} posters={c.coverPosters} onOpen={() => setOpen({ kind: "collection", id: c.collectionId })} />
        ))}
      </div>
      {lists.data && !lists.data.length && (
        <p className="mt-8 text-label-secondary">Create a collection above, or use “Add to Collection” on any title.</p>
      )}
    </div>
  );
}
