/**
 * Playback & account-sync state: launching the WebView2 player, reacting to its telemetry
 * events (Back to Hub, progress, in-player title hops, profile mismatches), the OTT profile
 * handshake and history imports.
 */
import { create } from "zustand";
import { nextEpisode, rankLinks } from "../services/catalog";
import { details as tmdbDetails, providerHints, searchTitle, toCatalogEntry, type MediaDetails } from "../services/tmdbClient";
import {
  catalog,
  deepLinks,
  events,
  history,
  importer,
  ottMappings,
  player,
  type ContinueWatchingItem,
  type ImportReport,
  type OttProfileMapping,
  type PlayerStatus,
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
  /** A specific link chosen in the UI; otherwise the best ranked link is used. */
  link?: ResolvedLink;
}

interface PlayerState {
  status: PlayerStatus | null;
  launching: string | null;
  mappings: OttProfileMapping[];
  imports: Record<string, ImportState>;
  listenersReady: boolean;

  initListeners: () => Promise<() => void>;
  refreshStatus: () => Promise<void>;
  refreshMappings: () => Promise<void>;
  resolveLinks: (d: MediaDetails, forceRefresh?: boolean) => Promise<ResolvedLink[]>;
  playTitle: (d: MediaDetails, opts?: PlayOptions) => Promise<void>;
  resumeItem: (item: ContinueWatchingItem) => Promise<void>;
  connect: (providerId: number, providerName: string) => Promise<void>;
  importFrom: (providerId: number, providerName: string) => Promise<void>;
  importFile: (file: File) => Promise<void>;
}

const app = () => useAppStore.getState();
const importKey = (profileId: number, providerName: string) => `${profileId}:${providerName}`;

export const usePlayerStore = create<PlayerState>((set, get) => ({
  status: null,
  launching: null,
  mappings: [],
  imports: {},
  listenersReady: false,

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
        const isTv = !!d.episodeNumber;
        try {
          const hits = await searchTitle(d.title, isTv ? "tv" : "movie");
          const fallback = hits.length ? hits : await searchTitle(d.title, isTv ? "movie" : "tv");
          const match = fallback[0];
          if (!match) {
            app().toast({ kind: "warning", title: "Couldn't identify the new title", body: `“${d.title}” won't be tracked.` });
            return;
          }
          const full = await tmdbDetails(match.mediaType, match.id, app().region).catch(() => null);
          if (full) await catalog.cache([toCatalogEntry(full)]);
          await player.rebind({
            tmdbId: match.id,
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
      const link = opts.link ?? (await get().resolveLinks(d))[0];
      if (!link) {
        s.toast({ kind: "warning", title: "Not streaming in your region", body: `${d.title} isn't available on any service in ${s.region}.` });
        return;
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

  resumeItem: async (item) => {
    const s = app();
    const profile = s.activeProfile;
    if (!profile) return;
    set({ launching: `${item.mediaType}:${item.tmdbId}` });
    try {
      // Up Next: start the following episode via the title's deep links.
      if (item.upNext || !item.directUrl) {
        const d = await tmdbDetails(item.mediaType, item.tmdbId, s.region);
        await get().playTitle(d);
        return;
      }
      // Exact resume page captured by telemetry; find the provider id for profile isolation.
      const cached = await deepLinks.cached(item.tmdbId, item.mediaType, s.region).catch(() => []);
      const name = (item.providerName ?? "").toLowerCase();
      const providerId =
        cached.find((l) => l.providerName.toLowerCase() === name)?.providerId ??
        s.subscriptions.find((p) => p.providerName.toLowerCase() === name)?.providerId ??
        0;
      await player.open({
        appProfileId: profile.profileId,
        providerId,
        providerName: item.providerName ?? "Provider",
        mode: "play",
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        title: item.title ?? "Untitled",
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        episodeTitle: item.episodeTitle,
        directUrl: item.directUrl,
        resumeAtSeconds: item.progressSeconds,
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
