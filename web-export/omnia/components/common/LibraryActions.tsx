"use client";
/**
 * Web edition of the desktop's personal-library actions (src/components/common/LibraryActions):
 * Mark as Watched and the per-episode toggle, backed by the manual tracker (this browser, or the
 * signed-in account). Love and Collections stay desktop features.
 */
import { useTracker } from "@/components/tracker/TrackerProvider";
import { useAppStore } from "../../store/useAppStore";
import { CheckIcon, EyeCheckIcon } from "./Icons";

export function MarkWatchedButton({ tmdbId, title, runtimeMins }: { tmdbId: number; title: string; runtimeMins?: number | null }) {
  const t = useTracker();
  const toast = useAppStore((s) => s.toast);
  const watched = t.movieWatched(tmdbId);
  const at = t.data.movies[tmdbId];
  return (
    <button
      className={`glass-button !py-3 ${watched ? "!text-[#30d158]" : ""}`}
      disabled={t.status === "loading"}
      onClick={() => {
        t.setMovieWatched(tmdbId, !watched, runtimeMins);
        toast(watched ? { kind: "info", title: "Unmarked", body: `${title} was removed from your history.` } : { kind: "success", title: "Marked as watched", body: title });
      }}
      title={watched ? `Watched${at ? ` ${new Date(at).toLocaleDateString()}` : ""} · click to undo` : "Seen it in a cinema or elsewhere? Track it here"}
    >
      {watched ? <CheckIcon size={18} /> : <EyeCheckIcon size={18} />} {watched ? "Watched" : "Mark as Watched"}
    </button>
  );
}

export function EpisodeWatchedToggle({
  tmdbId,
  seasonNumber,
  episodeNumber,
  runtimeMins,
  aired,
  onMarked,
}: {
  tmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  /** The episode's TMDB runtime, kept for the watch-time stats. */
  runtimeMins?: number | null;
  aired: boolean;
  /** Called after an episode is marked (not unmarked): offers to mark the earlier ones too. */
  onMarked?: () => void;
}) {
  const t = useTracker();
  const watched = !!t.watchedEpisodes(tmdbId)[`${seasonNumber}:${episodeNumber}`];
  const label = watched ? `Unmark episode ${episodeNumber}` : aired ? `Mark episode ${episodeNumber} as watched` : `Episode ${episodeNumber} hasn't aired yet`;
  return (
    <button
      type="button"
      onClick={() => {
        t.setEpisodes(tmdbId, [{ season: seasonNumber, episode: episodeNumber, runtime: runtimeMins }], !watched);
        if (!watched) onMarked?.();
      }}
      disabled={t.status === "loading" || (!aired && !watched)}
      aria-label={label}
      aria-pressed={watched}
      title={label}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-35 ${
        watched ? "bg-[#30d158]/20 text-[#30d158] hover:bg-[#30d158]/30" : "bg-white/[0.06] text-label-tertiary hover:bg-white/15 hover:text-white"
      }`}
    >
      {watched ? <CheckIcon size={16} /> : <EyeCheckIcon size={16} />}
    </button>
  );
}
