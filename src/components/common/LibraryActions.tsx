/**
 * Personal-library actions on a title: Love (recommender favorite), Mark as Watched (manual
 * tracking) and Add to Collection. Everything is stored locally, per profile.
 */
import { AnimatePresence, m } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useAsync } from "../../lib/hooks";
import { collections, favorites, history, type Collection, type MediaType, type WatchHistoryEntry } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { CheckIcon, EyeCheckIcon, HeartIcon, PlusIcon, StackIcon } from "./Icons";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** After a change that affects Continue Watching / recommendations. */
function useLibraryRefresh() {
  const refresh = useAppStore((s) => s.refreshContinueWatching);
  const markRecsStale = useAppStore((s) => s.markRecsStale);
  return () => {
    void refresh();
    markRecsStale();
  };
}

export function FavoriteButton({ tmdbId, mediaType, title }: { tmdbId: number; mediaType: MediaType; title: string }) {
  const profile = useAppStore((s) => s.activeProfile);
  const toast = useAppStore((s) => s.toast);
  const markRecsStale = useAppStore((s) => s.markRecsStale);
  const [loved, setLoved] = useState<boolean | null>(null);
  useEffect(() => {
    setLoved(null);
    if (!profile) return;
    let alive = true;
    favorites.contains(profile.profileId, tmdbId, mediaType).then((v) => alive && setLoved(v)).catch(() => alive && setLoved(false));
    return () => {
      alive = false;
    };
  }, [profile?.profileId, tmdbId, mediaType]);

  const toggle = async () => {
    if (!profile || loved === null) return;
    const next = !loved;
    setLoved(next);
    try {
      await favorites.set(profile.profileId, tmdbId, mediaType, next);
      markRecsStale();
      if (next) toast({ kind: "success", title: "Loved", body: `${title} now counts strongly towards your recommendations.` });
    } catch (e) {
      setLoved(!next);
      toast({ kind: "error", title: "Couldn't update favorites", body: errorText(e) });
    }
  };

  return (
    <button
      className={`glass-button !py-3 ${loved ? "!text-[#ff375f]" : ""}`}
      aria-pressed={!!loved}
      disabled={loved === null}
      onClick={() => void toggle()}
      title={loved ? "Remove from Loved" : "Love it: boosts similar recommendations"}
    >
      <HeartIcon size={18} filled={!!loved} /> {loved ? "Loved" : "Love"}
    </button>
  );
}

/**
 * Movie "Mark as Watched" (cinema, a local file, another device). A hand-made mark can be
 * undone; a title already finished on a service records a rewatch instead.
 */
export function MarkWatchedButton({
  tmdbId,
  title,
  runtimeMins,
  progress,
  onChanged,
}: {
  tmdbId: number;
  title: string;
  runtimeMins: number | null | undefined;
  progress: WatchHistoryEntry[];
  onChanged: () => void;
}) {
  const profile = useAppStore((s) => s.activeProfile);
  const toast = useAppStore((s) => s.toast);
  const refresh = useLibraryRefresh();
  const [busy, setBusy] = useState(false);
  const row = progress.find((p) => p.seasonNumber === 0 && p.episodeNumber === 0);
  const watched = !!row?.isCompleted;
  const handMade = watched && !row?.providerName;

  const run = async () => {
    if (!profile) return;
    setBusy(true);
    try {
      if (handMade) {
        await history.unmarkWatched(profile.profileId, tmdbId, "movie");
        toast({ kind: "info", title: "Unmarked", body: `${title} was removed from your history.` });
      } else {
        await history.markWatched(profile.profileId, tmdbId, "movie", { durationSeconds: runtimeMins ? runtimeMins * 60 : null });
        toast({ kind: "success", title: watched ? "Rewatch recorded" : "Marked as watched", body: title });
      }
      onChanged();
      refresh();
    } catch (e) {
      toast({ kind: "error", title: "Couldn't update history", body: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className={`glass-button !py-3 ${watched ? "!text-[#30d158]" : ""}`}
      disabled={busy}
      onClick={() => void run()}
      title={handMade ? "Undo: remove this from your history" : watched ? "Watched again? Record a rewatch" : "Seen it in a cinema or elsewhere? Track it here"}
    >
      {watched ? <CheckIcon size={18} /> : <EyeCheckIcon size={18} />} {watched ? "Watched" : "Mark as Watched"}
    </button>
  );
}

/** Episode-row toggle (used by the season list). */
export function EpisodeWatchedToggle({
  tmdbId,
  seasonNumber,
  episodeNumber,
  episodeTitle,
  runtimeMins,
  entry,
  onChanged,
}: {
  tmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string;
  runtimeMins: number | null | undefined;
  entry: WatchHistoryEntry | undefined;
  onChanged: () => void;
}) {
  const profile = useAppStore((s) => s.activeProfile);
  const toast = useAppStore((s) => s.toast);
  const refresh = useLibraryRefresh();
  const [busy, setBusy] = useState(false);
  const watched = !!entry?.isCompleted;
  const handMade = watched && !entry?.providerName;

  const run = async () => {
    if (!profile) return;
    setBusy(true);
    try {
      if (handMade) await history.unmarkWatched(profile.profileId, tmdbId, "tv", seasonNumber, episodeNumber);
      else
        await history.markWatched(profile.profileId, tmdbId, "tv", {
          seasonNumber,
          episodeNumber,
          episodeTitle,
          durationSeconds: runtimeMins ? runtimeMins * 60 : null,
        });
      onChanged();
      refresh();
    } catch (e) {
      toast({ kind: "error", title: "Couldn't update history", body: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const label = handMade ? `Unmark episode ${episodeNumber}` : watched ? `Episode ${episodeNumber} watched: record a rewatch` : `Mark episode ${episodeNumber} as watched`;
  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      aria-label={label}
      title={label}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
        watched ? "bg-[#30d158]/20 text-[#30d158] hover:bg-[#30d158]/30" : "bg-white/[0.06] text-label-tertiary hover:bg-white/15 hover:text-white"
      }`}
    >
      {watched ? <CheckIcon size={16} /> : <EyeCheckIcon size={16} />}
    </button>
  );
}

/** "Add to Collection" popover: toggle membership in each list, or create a new one. */
export function CollectionMenu({ tmdbId, mediaType, title }: { tmdbId: number; mediaType: MediaType; title: string }) {
  const profile = useAppStore((s) => s.activeProfile);
  const toast = useAppStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  const lists = useAsync(() => collections.list(profile!.profileId), [profile?.profileId, nonce, open], !!profile && open);
  const member = useAsync(() => collections.containing(profile!.profileId, tmdbId, mediaType), [profile?.profileId, tmdbId, mediaType, nonce], !!profile);
  const inAny = (member.data?.length ?? 0) > 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const toggle = async (c: Collection) => {
    if (!profile) return;
    const has = member.data?.includes(c.collectionId);
    try {
      if (has) await collections.removeItem(profile.profileId, c.collectionId, tmdbId, mediaType);
      else await collections.addItem(profile.profileId, c.collectionId, tmdbId, mediaType);
      setNonce((n) => n + 1);
    } catch (e) {
      toast({ kind: "error", title: "Couldn't update the collection", body: errorText(e) });
    }
  };

  const create = async () => {
    if (!profile || !name.trim()) return;
    setBusy(true);
    try {
      const c = await collections.create(profile.profileId, name);
      await collections.addItem(profile.profileId, c.collectionId, tmdbId, mediaType);
      setName("");
      setNonce((n) => n + 1);
      toast({ kind: "success", title: `Added to ${c.name}`, body: title });
    } catch (e) {
      toast({ kind: "error", title: "Couldn't create the collection", body: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={root} className="relative">
      <button className={`glass-button !py-3 ${inAny ? "!text-[#64d2ff]" : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <StackIcon size={18} /> {inAny ? "In Collections" : "Add to Collection"}
      </button>
      <AnimatePresence>
        {open && (
          <m.div
            role="dialog"
            aria-label="Add to collection"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            className="glass-panel glass-strong absolute left-0 top-[calc(100%+8px)] z-40 w-[290px] p-3"
          >
            <p className="px-2 pb-2 text-[12px] font-semibold uppercase tracking-wide text-label-tertiary">Collections</p>
            <ul className="flex max-h-[240px] flex-col gap-0.5 overflow-y-auto">
              {(lists.data ?? []).map((c) => {
                const has = !!member.data?.includes(c.collectionId);
                return (
                  <li key={c.collectionId}>
                    <button
                      role="menuitemcheckbox"
                      aria-checked={has}
                      onClick={() => void toggle(c)}
                      className="flex w-full items-center gap-3 rounded-pill px-2 py-2 text-left text-[14px] hover:bg-white/10"
                    >
                      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${has ? "bg-[#0a84ff] text-white" : "bg-white/10"}`}>
                        {has && <CheckIcon size={13} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      <span className="text-[12px] text-label-tertiary">{c.itemCount}</span>
                    </button>
                  </li>
                );
              })}
              {lists.data && !lists.data.length && <li className="px-2 py-1 text-[13px] text-label-secondary">No collections yet. Create your first one below.</li>}
            </ul>
            <form
              className="mt-2 flex gap-2 border-t border-white/10 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="New collection…"
                aria-label="New collection name"
                className="min-w-0 flex-1 rounded-pill bg-white/10 px-3 py-2 text-[14px] outline-none placeholder:text-label-tertiary focus-visible:ring-2 focus-visible:ring-white/70"
              />
              <button type="submit" className="glass-button-primary !px-3 !py-2" disabled={busy || !name.trim()} aria-label="Create collection">
                <PlusIcon size={16} />
              </button>
            </form>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
