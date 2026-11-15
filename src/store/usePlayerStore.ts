/**
 * Playback & account-sync state: launching the WebView2 player, reacting to its telemetry
 * events (Back to Hub, progress, in-player title hops, profile mismatches), the OTT profile
 * handshake and history imports.
 *
 * Provider routing: Play uses the profile's remembered OTT for that title; otherwise a title on a
 * single streaming service plays straight away, and one on several asks "Where do you want to
 * watch this?" (the answer is saved per profile + title in SQLite).
 */
import { create } from "zustand";
import { groupLinks, nextEpisode, rankLinks, type LinkGroup } from "../services/catalog";
import { providerFamily } from "../lib/providers";
import { details as tmdbDetails, providerHints, toCatalogEntry, type MediaDetails } from "../services/tmdbClient";
import {
  catalog,
  deepLinks,
  events,
  history,
  importer,
  ottMappings,
  player,
  preferredProviders,
  type ContinueWatchingItem,
  type ImportReport,
  type MediaType,
  type OttProfileMapping,
  type PlayerStatus,
  type PreferredProvider,
  type ResolvedLink,
} from "../services/tauriBridge";
import { useAppStore } from "./useAppStore";

export interface ImportState {
  providerName: string;
  stage: "starting" | "fetching" | "matching" | "saving" | "done" | "error";
  done: number;
  total: number;
  report?: ImportReport;
  error?: string;
}

export interface PlayOptions {
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string | null;
  /** A specific link chosen in the UI; otherwise the remembered / only / picked provider. */
  link?: ResolvedLink;
  /** Save `link`'s provider as this profile's default for the title. */
  remember?: boolean;
  /** Ignore the remembered provider and always ask. */
  choose?: boolean;
}

/** An open "Where do you want to watch this?" prompt. */
export interface ProviderPickerRequest {
  details: MediaDetails;
  /** The original play options (episode etc.), replayed with the chosen link. */
  options: PlayOptions;
  /** Provider families, best first: subscribed streaming, then free, then rent / buy. */
  groups: LinkGroup[];
  /** The previously remembered provider, if it's no longer offered or the user asked to change. */
  current: PreferredProvider | null;
}

const STREAMING = new Set(["flatrate", "free", "ads"]);
export const isStreamingLink = (l: ResolvedLink) => STREAMING.has(l.monetizationType);
const familyOf = (p: { providerId: number; providerName: string }) => providerFamily(p.providerId, p.providerName).key;

interface PlayerState {
  status: PlayerStatus | null;
  launching: string | null;
  mappings: OttProfileMapping[];
  imports: Record<string, ImportState>;
  listenersReady: boolean;
  picker: ProviderPickerRequest | null;
  /** Bumped whenever a remembered provider changes (views re-read it). */
  preferenceVersion: number;

  initListeners: () => Promise<() => void>;
  refreshStatus: () => Promise<void>;
  refreshMappings: () => Promise<void>;
  resolveLinks: (d: MediaDetails, forceRefresh?: boolean) => Promise<ResolvedLink[]>;
  playTitle: (d: MediaDetails, opts?: PlayOptions) => Promise<void>;
  closePicker: () => void;
  getPreference: (d: Pick<MediaDetails, "id" | "mediaType">) => Promise<PreferredProvider | null>;
  clearPreference: (d: Pick<MediaDetails, "id" | "mediaType">) => Promise<void>;
  resumeItem: (item: ContinueWatchingItem) => Promise<void>;
  connect: (providerId: number, providerName: string) => Promise<void>;
  importFrom: (providerId: number, providerName: string) => Promise<void>;
  importFile: (file: File) => Promise<void>;
}

const app = () => useAppStore.getState();
const importKey = (profileId: number, providerName: string) => `${profileId}:${providerName}`;

const NETFLIX_WATCH = /^https:\/\/www\.netflix\.com\/watch\/\d{3,12}(?:[/?#]|$)/i;
const NETFLIX_TITLE = /^https:\/\/(?:www\.)?netflix\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?title\/(\d{3,12})/i;

/**
 * Netflix player URL for a resolved link. `/watch/<episode id>` is kept as is; a series or
 * film landing page (`/title/<id>`, what JustWatch returns) becomes `/watch/<id>`, which opens
 * the player directly: for a series Netflix starts the profile's current / next episode.
 */
export function netflixPlayerUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (NETFLIX_WATCH.test(url)) return url;
  const m = url.match(NETFLIX_TITLE);
  return m ? `https://www.netflix.com/watch/${m[1]}` : null;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  status: null,
  launching: null,
  mappings: [],
  imports: {},
  listenersReady: false,
  picker: null,
  preferenceVersion: 0,

  initListeners: async () => {
    const offs = await Promise.all([
      events.onBackToHub(() => {
        set({ status: null });
        void app().refreshContinueWatching();
        app().markRecsStale();
      }),
      events.onPlayerOpened(() => void get().refreshStatus()),
      events.onPlayerClosed(() => {
        set({ status: null });
        void app().refreshContinueWatching();
        app().markRecsStale();
      }),
      events.onPlaybackProgress((p) => {
        const s = app();
        if (s.activeProfile?.profileId !== p.appProfileId) return;
        // Live-update the matching Continue Watching card without a round-trip.
        useAppStore.setState({
          continueWatching: s.continueWatching.map((c) =>
            c.tmdbId === p.tmdbId && c.mediaType === p.mediaType
              ? {
                  ...c,
                  seasonNumber: p.seasonNumber,
                  episodeNumber: p.episodeNumber,
                  progressSeconds: p.progressSeconds,
                  durationSeconds: p.durationSeconds,
                  completionRatio: Math.min(1, p.progressSeconds / Math.max(1, p.durationSeconds)),
                }
              : c,
          ),
        });
      }),
      events.onPlayerTitleChanged(async (e) => {
        // The user switched titles inside the OTT player: identify it and rebind tracking.
        const d = e.detected;
        if (!d.title) return;
        // Strict type: anything with season / episode data is a series, never a film (and the
        // other type is never tried as a fallback). Rust matches exact titles + release year.
        // Season / episode numbers always win over a reported type (the same rule Rust applies).
        const hasEpisode = (d.seasonNumber ?? 0) > 0 || (d.episodeNumber ?? 0) > 0 || !!d.episodeTitle;
        const mediaType: MediaType = hasEpisode ? "tv" : d.mediaType === "tv" || d.mediaType === "movie" ? d.mediaType : "movie";
        try {
          const match = await player.identify(d.title, mediaType, d.releaseYear ?? null);
          if (!match) {
            app().toast({ kind: "warning", title: "Couldn't identify the new title", body: `“${d.title}” won't be tracked.` });
            return;
          }
          const full = await tmdbDetails(match.mediaType, match.tmdbId, app().region).catch(() => null);
          if (full) await catalog.cache([toCatalogEntry(full)]);
          await player.rebind({
            tmdbId: match.tmdbId,
            mediaType: match.mediaType,
            title: match.title,
            originalTitle: match.originalTitle,
            seasonNumber: d.seasonNumber,
            episodeNumber: d.episodeNumber,
            episodeTitle: d.episodeTitle,
          });
          app().toast({ kind: "info", title: "Now tracking", body: match.title });
        } catch (err) {
          app().toast({ kind: "error", title: "Title tracking paused", body: String(err) });
        }
      }),
      events.onOttProfileMismatch((e) => {
        const me = app().activeProfile?.profileName ?? "you";
        const who = e.observedOttProfileName ?? "This profile";
        app().toast(
          e.reason === "unlinked"
            ? { kind: "info", title: `Link your ${e.providerName} profile`, body: `${who} isn't linked to ${me} yet, so nothing is being saved. Use “Link” in the player's top-left pill.` }
            : { kind: "warning", title: `Not tracking: wrong ${e.providerName} profile`, body: `${who} isn't ${me}'s linked profile. Nothing is saved until you switch profiles in ${e.providerName}.` },
        );
      }),
      events.onOttProfileConnected((e) => {
        void get().refreshMappings();
        if (e.importing) {
          set((s) => ({
            imports: { ...s.imports, [importKey(e.appProfileId, e.providerName)]: { providerName: e.providerName, stage: "starting", done: 0, total: 0 } },
          }));
        }
        app().toast({
          kind: "success",
          title: `${e.providerName} linked`,
          body: e.importing
            ? `${e.ottProfileName ?? "Profile"} → importing your history…`
            : `${e.ottProfileName ?? "Profile"} is now tracked for ${app().activeProfile?.profileName ?? "this profile"}.`,
        });
      }),
      events.onHistoryImportProgress((e) =>
        set((s) => ({
          imports: { ...s.imports, [importKey(e.appProfileId, e.providerName)]: { providerName: e.providerName, stage: e.stage, done: e.done, total: e.total } },
        })),
      ),
      events.onBackgroundSync((e) => {
        if (e.appProfileId !== app().activeProfile?.profileId) return;
        void app().refreshContinueWatching();
        app().markRecsStale();
        app().toast({ kind: "info", title: `Synced from ${e.providerName}`, body: `${e.updated} new ${e.updated === 1 ? "entry" : "entries"} from your other devices.` });
      }),
      events.onHistoryImportFinished((e) => {
        if (e.ok) {
          const r = e.report;
          set((s) => ({ imports: { ...s.imports, [importKey(r.appProfileId, r.providerName)]: { providerName: r.providerName, stage: "done", done: r.imported, total: r.imported, report: r } } }));
          app().toast({ kind: "success", title: `${r.providerName} history imported`, body: `${r.imported} entries · ${r.matchedTitles} titles matched` });
          if (r.appProfileId === app().activeProfile?.profileId) {
            void app().refreshContinueWatching();
            void app().loadRecommendations(true);
          }
        } else {
          set((s) => ({ imports: { ...s.imports, [importKey(e.appProfileId, e.providerName)]: { providerName: e.providerName, stage: "error", done: 0, total: 0, error: e.error } } }));
          app().toast({ kind: "error", title: `${e.providerName} import failed`, body: e.error });
        }
      }),
    ]);
    set({ listenersReady: true });
    return () => offs.forEach((off) => off());
  },

  refreshStatus: async () => set({ status: await player.status() }),

  refreshMappings: async () => {
    const p = app().activeProfile;
    if (!p) return;
    set({ mappings: await ottMappings.list(p.profileId) });
  },

  resolveLinks: async (d, forceRefresh = false) => {
    const { region } = app();
    const res = await deepLinks.resolve({
      tmdbId: d.id,
      mediaType: d.mediaType,
      title: d.title,
      originalTitle: d.originalTitle,
      releaseYear: d.year,
      region,
      tmdbProviders: providerHints(d, region),
      forceRefresh,
    });
    return rankLinks(res.links, app().subscriptions);
  },

  playTitle: async (d, opts = {}) => {
    const s = app();
    const profile = s.activeProfile;
    if (!profile) return;
    set({ launching: `${d.mediaType}:${d.id}` });
    try {
      await catalog.cache([toCatalogEntry(d)]);
      let link = opts.link;
      if (!link) {
        const ranked = await get().resolveLinks(d);
        const groups = groupLinks(ranked);
        if (!groups.length) {
          s.toast({ kind: "warning", title: "Not streaming in your region", body: `${d.title} isn't available on any service in ${s.region}.` });
          return;
        }
        const pref = await get().getPreference(d).catch(() => null);
        const preferred = !opts.choose && pref ? groups.find((g) => g.key === familyOf(pref)) : undefined;
        if (preferred) {
          link = preferred.primary;
        } else {
          // Ask whenever there's a real choice of where to stream; rent / buy only matters
          // when nothing streams it.
          const streaming = groups.filter((g) => isStreamingLink(g.primary));
          const candidates = streaming.length ? streaming : groups;
          if (opts.choose || candidates.length > 1) {
            set({ picker: { details: d, options: opts, groups, current: pref } });
            return;
          }
          link = candidates[0]!.primary;
        }
      }
      if (opts.remember) {
        try {
          await preferredProviders.set(profile.profileId, d.id, d.mediaType, link.providerId, link.providerName);
          set((st) => ({ preferenceVersion: st.preferenceVersion + 1 }));
        } catch (e) {
          s.toast({ kind: "warning", title: "Couldn't remember this choice", body: String(e) });
        }
      }
      let season = opts.seasonNumber;
      let episode = opts.episodeNumber;
      if (d.mediaType === "tv" && (season === undefined || episode === undefined)) {
        const progress = await history.titleProgress(profile.profileId, d.id, "tv");
        const next = nextEpisode(progress, d.seasons);
        season = next.seasonNumber;
        episode = next.episodeNumber;
      }
      await player.open({
        appProfileId: profile.profileId,
        providerId: link.providerId,
        providerName: link.providerName,
        mode: "play",
        tmdbId: d.id,
        mediaType: d.mediaType,
        title: d.title,
        originalTitle: d.originalTitle,
        seasonNumber: season ?? 0,
        episodeNumber: episode ?? 0,
        episodeTitle: opts.episodeTitle ?? null,
        directUrl: link.directUrl,
        region: s.region,
      });
      if (link.isFallback) {
        s.toast({ kind: "info", title: `Opened ${link.providerName} search`, body: "No direct link was found, so pick the title on the provider's page." });
      }
    } catch (e) {
      s.toast({ kind: "error", title: "Couldn't start playback", body: String(e) });
    } finally {
      set({ launching: null });
    }
  },

  closePicker: () => set({ picker: null }),

  getPreference: async (d) => {
    const profile = app().activeProfile;
    if (!profile) return null;
    return preferredProviders.get(profile.profileId, d.id, d.mediaType);
  },

  clearPreference: async (d) => {
    const profile = app().activeProfile;
    if (!profile) return;
    await preferredProviders.clear(profile.profileId, d.id, d.mediaType);
    set((st) => ({ preferenceVersion: st.preferenceVersion + 1 }));
  },

  resumeItem: async (item) => {
    const s = app();
    const profile = s.activeProfile;
    if (!profile) return;
    set({ launching: `${item.mediaType}:${item.tmdbId}` });
    try {
      if (item.newEpisode) {
        // A new episode of a caught-up show: play exactly that episode (Netflix jumps to it).
        const d = await tmdbDetails("tv", item.tmdbId, s.region);
        await get().playTitle(d, { seasonNumber: item.newEpisode.seasonNumber, episodeNumber: item.newEpisode.episodeNumber });
        return;
      }
      const isNetflix = /netflix/i.test(item.providerName ?? "");
      // The episode's own player URL, captured by live telemetry or the Netflix importer.
      const episodeUrl = isNetflix ? netflixPlayerUrl(item.directUrl) : null;
      const exactUrl = !item.upNext && (episodeUrl ?? (isNetflix ? null : item.directUrl));

      let directUrl = exactUrl || null;
      let providerId = 0;
      let providerName = item.providerName ?? "Provider";
      if (!directUrl && isNetflix) {
        // No episode URL (e.g. CSV import, or Up Next): open Netflix's player for the title
        // instead of its landing page; Netflix picks the profile's current / next episode.
        const d = await tmdbDetails(item.mediaType, item.tmdbId, s.region);
        const ranked = await get().resolveLinks(d).catch(() => [] as ResolvedLink[]);
        const link = ranked.find((l) => /netflix/i.test(l.providerName) && netflixPlayerUrl(l.directUrl));
        if (link) {
          directUrl = netflixPlayerUrl(link.directUrl);
          providerId = link.providerId;
          providerName = link.providerName;
        }
      }
      if (!directUrl) {
        // Other providers (or nothing resolvable): the normal play flow with its deep links.
        const d = await tmdbDetails(item.mediaType, item.tmdbId, s.region);
        await get().playTitle(d);
        return;
      }
      if (!providerId) {
        // Find the provider id for profile isolation.
        const cached = await deepLinks.cached(item.tmdbId, item.mediaType, s.region).catch(() => []);
        const name = providerName.toLowerCase();
        providerId =
          cached.find((l) => l.providerName.toLowerCase() === name)?.providerId ??
          s.subscriptions.find((p) => p.providerName.toLowerCase() === name)?.providerId ??
          (isNetflix ? 8 : 0);
      }
      await player.open({
        appProfileId: profile.profileId,
        providerId,
        providerName,
        mode: "play",
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        title: item.title ?? "Untitled",
        // A guess until the player confirms the episode (Netflix always reports it).
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        episodeTitle: item.upNext ? null : item.episodeTitle,
        directUrl,
        // Netflix resumes its own bookmark; the saved point is only a hint for other providers.
        resumeAtSeconds: exactUrl ? item.progressSeconds : undefined,
        region: s.region,
      });
    } catch (e) {
      s.toast({ kind: "error", title: "Couldn't resume", body: String(e) });
    } finally {
      set({ launching: null });
    }
  },

  connect: async (providerId, providerName) => {
    const s = app();
    if (!s.activeProfile) return;
    try {
      await player.connect(s.activeProfile.profileId, providerId, providerName, s.region);
    } catch (e) {
      s.toast({ kind: "error", title: `Couldn't open ${providerName}`, body: String(e) });
    }
  },

  importFrom: async (providerId, providerName) => {
    const s = app();
    const profile = s.activeProfile;
    if (!profile) return;
    const key = importKey(profile.profileId, providerName);
    set((st) => ({ imports: { ...st.imports, [key]: { providerName, stage: "starting", done: 0, total: 0 } } }));
    try {
      await importer.fromProvider(profile.profileId, providerId, providerName);
    } catch (e) {
      set((st) => ({ imports: { ...st.imports, [key]: { providerName, stage: "error", done: 0, total: 0, error: String(e) } } }));
      s.toast({ kind: "error", title: `${providerName} import failed`, body: String(e) });
    }
  },

  importFile: async (file) => {
    const s = app();
    const profile = s.activeProfile;
    if (!profile) return;
    const key = importKey(profile.profileId, file.name);
    set((st) => ({ imports: { ...st.imports, [key]: { providerName: file.name, stage: "starting", done: 0, total: 0 } } }));
    try {
      const contents = await file.text();
      const report = await importer.fromFile(profile.profileId, file.name, contents, null);
      set((st) => ({ imports: { ...st.imports, [key]: { providerName: file.name, stage: "done", done: report.imported, total: report.imported, report } } }));
    } catch (e) {
      set((st) => ({ imports: { ...st.imports, [key]: { providerName: file.name, stage: "error", done: 0, total: 0, error: String(e) } } }));
      s.toast({ kind: "error", title: "File import failed", body: String(e) });
    }
  },
}));
