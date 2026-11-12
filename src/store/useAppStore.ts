/**
 * App-wide UI state: active profile, region, subscriptions, navigation, filters, catalog data
 * owned by the Rust backend (Continue Watching, watchlist, recommendations) and toasts.
 * Every backend call goes through the typed bridge; per-profile data is reset on profile switch.
 */
import { create } from "zustand";
import { registryAsCustomHubs } from "../config/hubsRegistry";
import { detectRegionByIp } from "../services/catalog";
import { envTmdbKey, hasTmdbCredential, setTmdbCredential, summaryToCatalogEntry, type CatalogContext, type MediaSummary } from "../services/tmdbClient";
import {
  catalog,
  history,
  hubs,
  profiles as profilesApi,
  recommendations,
  settings as settingsApi,
  SettingKeys,
  subscriptions as subscriptionsApi,
  watchlist as watchlistApi,
  type AppProfile,
  type ContinueWatchingItem,
  type CustomHub,
  type MediaType,
  type RecommendationsResponse,
  type SubscribedProvider,
  type WatchlistItem,
} from "../services/tauriBridge";
import { DEFAULT_PALETTE, type Rgb } from "../lib/color";

export type View = "home" | "search" | "continue" | "myotts" | "hubs" | "watchlist" | "settings";

export type ModalEntry =
  | { kind: "title"; id: number; mediaType: MediaType; seed?: MediaSummary; autoplay?: boolean }
  | { kind: "person"; id: number };

export interface Toast {
  id: number;
  kind: "info" | "success" | "warning" | "error";
  title: string;
  body?: string;
}

const TRAILER_AUTOPLAY = "trailer_autoplay";
const keyOf = (id: number, mt: MediaType) => `${mt}:${id}`;
let toastSeq = 1;

interface AppState {
  booted: boolean;
  bootError: string | null;
  profiles: AppProfile[];
  activeProfile: AppProfile | null;
  profileGateOpen: boolean;

  settings: Record<string, string>;
  region: string;
  regionSource: "auto" | "manual";
  subscriptions: SubscribedProvider[];
  subscriptionsOnly: boolean;
  kidsSafeMode: boolean;
  trailerAutoplay: boolean;
  tmdbReady: boolean;

  view: View;
  activeHub: string | null;
  providerFilter: number | null;
  searchQuery: string;
  sidebarCollapsed: boolean;
  scrollPositions: Partial<Record<View, number>>;

  modalStack: ModalEntry[];
  accountSyncOpen: boolean;
  ambient: [Rgb, Rgb, Rgb];

  hubs: CustomHub[];
  continueWatching: ContinueWatchingItem[];
  watchlist: WatchlistItem[];
  watchlistKeys: Set<string>;
  recs: RecommendationsResponse | null;
  recsLoading: boolean;
  recsError: string | null;
  recsStale: boolean;
  toasts: Toast[];

  bootstrap: () => Promise<void>;
  selectProfile: (p: AppProfile) => Promise<void>;
  openProfileGate: () => void;
  reloadProfiles: () => Promise<void>;
  saveProfile: (input: { profileId?: number; name: string; isKids: boolean; avatar: string | null }) => Promise<AppProfile>;
  deleteProfile: (profileId: number) => Promise<boolean>;

  setRegion: (code: string, source: "auto" | "manual") => Promise<void>;
  redetectRegion: () => Promise<string | null>;
  loadSubscriptions: () => Promise<void>;
  saveSubscriptions: (providers: SubscribedProvider[]) => Promise<void>;
  setSubscriptionsOnly: (on: boolean) => Promise<void>;
  setKidsSafeMode: (on: boolean) => Promise<void>;
  setTrailerAutoplay: (on: boolean) => Promise<void>;
  setTmdbKey: (key: string) => Promise<void>;

  navigate: (view: View, opts?: { hub?: string | null }) => void;
  rememberScroll: (view: View, top: number) => void;
  setSearchQuery: (q: string) => void;
  setProviderFilter: (id: number | null) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setAmbient: (palette: [Rgb, Rgb, Rgb]) => void;

  openTitle: (entry: Omit<Extract<ModalEntry, { kind: "title" }>, "kind">) => void;
  openPerson: (id: number) => void;
  popModal: () => void;
  closeModals: () => void;
  setAccountSyncOpen: (open: boolean) => void;

  refreshContinueWatching: () => Promise<void>;
  refreshWatchlist: () => Promise<void>;
  toggleWatchlist: (m: MediaSummary) => Promise<boolean>;
  isInWatchlist: (id: number, mt: MediaType) => boolean;
  loadRecommendations: (force?: boolean) => Promise<void>;
  markRecsStale: () => void;

  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;

  catalogContext: () => CatalogContext;
  isKids: () => boolean;
}

export const useAppStore = create<AppState>((set, get) => ({
  booted: false,
  bootError: null,
  profiles: [],
  activeProfile: null,
  profileGateOpen: true,

  settings: {},
  region: "US",
  regionSource: "auto",
  subscriptions: [],
  subscriptionsOnly: false,
  kidsSafeMode: false,
  trailerAutoplay: true,
  tmdbReady: false,

  view: "home",
  activeHub: null,
  providerFilter: null,
  searchQuery: "",
  sidebarCollapsed: false,
  scrollPositions: {},

  modalStack: [],
  accountSyncOpen: false,
  ambient: DEFAULT_PALETTE,

  hubs: [],
  continueWatching: [],
  watchlist: [],
  watchlistKeys: new Set(),
  recs: null,
  recsLoading: false,
  recsError: null,
  recsStale: true,
  toasts: [],

  // ------------------------------------------------------------------------------------------
  // Boot & profiles
  // ------------------------------------------------------------------------------------------

  bootstrap: async () => {
    try {
      let all = await settingsApi.getAll();

      // TMDB credential: .env wins and is mirrored into local settings for the Rust side.
      const stored = all[SettingKeys.tmdbApiKey] ?? "";
      if (envTmdbKey && envTmdbKey !== stored) {
        await settingsApi.set(SettingKeys.tmdbApiKey, envTmdbKey);
      } else if (!envTmdbKey && stored) {
        setTmdbCredential(stored);
      }

      // Region: IP geolocation on first launch, and on every launch while in auto mode
      // (travellers); a manual (VPN) choice is never overridden.
      let region = all[SettingKeys.regionCode];
      const source = (all[SettingKeys.regionSource] as "auto" | "manual") ?? "auto";
      if (!region || source === "auto") {
        const detected = await detectRegionByIp();
        if (detected && detected !== region) {
          region = detected;
          await settingsApi.set(SettingKeys.regionCode, detected);
        }
      }
      region = region ?? "US";

      // Seed / refresh the hub registry, then read hubs back from SQLite (user-added hubs too).
      await hubs.upsert(registryAsCustomHubs());
      const [hubList, profileList] = await Promise.all([hubs.list(), profilesApi.list()]);
      all = await settingsApi.getAll();

      set({
        booted: true,
        settings: all,
        region,
        regionSource: source,
        subscriptionsOnly: all[SettingKeys.subscriptionsOnly] === "true",
        kidsSafeMode: all[SettingKeys.kidsSafeMode] === "true",
        trailerAutoplay: all[TRAILER_AUTOPLAY] !== "false",
        tmdbReady: hasTmdbCredential(),
        hubs: hubList,
        profiles: profileList,
        profileGateOpen: true,
      });
      await get().loadSubscriptions();
    } catch (e) {
      set({ booted: true, bootError: e instanceof Error ? e.message : String(e) });
    }
  },

  selectProfile: async (p) => {
    await settingsApi.set(SettingKeys.activeProfileId, String(p.profileId));
    set({
      activeProfile: p,
      profileGateOpen: false,
      continueWatching: [],
      watchlist: [],
      watchlistKeys: new Set(),
      recs: null,
      recsError: null,
      recsStale: true,
      modalStack: [],
      view: "home",
      activeHub: null,
      scrollPositions: {},
    });
    await Promise.all([get().refreshContinueWatching(), get().refreshWatchlist()]);
    void get().loadRecommendations();
  },

  openProfileGate: () => set({ profileGateOpen: true, modalStack: [], accountSyncOpen: false }),

  reloadProfiles: async () => {
    const list = await profilesApi.list();
    const active = get().activeProfile;
    set({ profiles: list, activeProfile: active ? list.find((p) => p.profileId === active.profileId) ?? null : null });
  },

  saveProfile: async ({ profileId, name, isKids, avatar }) => {
    const saved = profileId
      ? await profilesApi.update(profileId, name, isKids, avatar)
      : await profilesApi.create(name, isKids, avatar);
    await get().reloadProfiles();
    return saved;
  },

  deleteProfile: async (profileId) => {
    const ok = await profilesApi.remove(profileId);
    if (!ok) get().toast({ kind: "warning", title: "Can't delete the last profile" });
    await get().reloadProfiles();
    return ok;
  },

  // ------------------------------------------------------------------------------------------
  // Region, subscriptions & preferences
  // ------------------------------------------------------------------------------------------

  setRegion: async (code, source) => {
    await settingsApi.set(SettingKeys.regionCode, code);
    await settingsApi.set(SettingKeys.regionSource, source);
    set({ region: code, regionSource: source, providerFilter: null, recsStale: true });
    await get().loadSubscriptions();
    void get().loadRecommendations(true);
  },

  redetectRegion: async () => {
    const code = await detectRegionByIp();
    if (code) await get().setRegion(code, "auto");
    else get().toast({ kind: "error", title: "Couldn't detect your region", body: "Check your connection or pick one manually." });
    return code;
  },

  loadSubscriptions: async () => {
    const subs = await subscriptionsApi.list(get().region, true);
    set({ subscriptions: subs });
  },

  saveSubscriptions: async (providers) => {
    const saved = await subscriptionsApi.replace(get().region, providers);
    set({ subscriptions: saved, providerFilter: null, recsStale: true });
    void get().loadRecommendations(true);
  },

  setSubscriptionsOnly: async (on) => {
    await settingsApi.set(SettingKeys.subscriptionsOnly, String(on));
    set({ subscriptionsOnly: on, recsStale: true });
    void get().loadRecommendations(true);
  },

  setKidsSafeMode: async (on) => {
    await settingsApi.set(SettingKeys.kidsSafeMode, String(on));
    set({ kidsSafeMode: on, recsStale: true });
    void get().loadRecommendations(true);
  },

  setTrailerAutoplay: async (on) => {
    await settingsApi.set(TRAILER_AUTOPLAY, String(on));
    set({ trailerAutoplay: on });
  },

  setTmdbKey: async (key) => {
    await settingsApi.set(SettingKeys.tmdbApiKey, key.trim());
    setTmdbCredential(key);
    set({ tmdbReady: hasTmdbCredential() });
    void get().loadRecommendations(true);
  },

  // ------------------------------------------------------------------------------------------
  // Navigation & UI
  // ------------------------------------------------------------------------------------------

  navigate: (view, opts) =>
    set((s) => ({
      view,
      activeHub: opts?.hub !== undefined ? opts.hub : view === "hubs" ? s.activeHub : null,
    })),
  rememberScroll: (view, top) => set((s) => ({ scrollPositions: { ...s.scrollPositions, [view]: top } })),
  setSearchQuery: (q) => set((s) => ({ searchQuery: q, view: q.trim() ? "search" : s.view === "search" ? "home" : s.view })),
  setProviderFilter: (id) => set({ providerFilter: id }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setAmbient: (palette) => set({ ambient: palette }),

  openTitle: (entry) => set((s) => ({ modalStack: [...s.modalStack, { kind: "title", ...entry }] })),
  openPerson: (id) => set((s) => ({ modalStack: [...s.modalStack, { kind: "person", id }] })),
  popModal: () => set((s) => ({ modalStack: s.modalStack.slice(0, -1) })),
  closeModals: () => set({ modalStack: [] }),
  setAccountSyncOpen: (open) => set({ accountSyncOpen: open }),

  // ------------------------------------------------------------------------------------------
  // Backend-owned catalog data (profile-scoped)
  // ------------------------------------------------------------------------------------------

  refreshContinueWatching: async () => {
    const p = get().activeProfile;
    if (!p) return;
    const items = await history.continueWatching(p.profileId, 30);
    if (get().activeProfile?.profileId === p.profileId) set({ continueWatching: items });
  },

  refreshWatchlist: async () => {
    const p = get().activeProfile;
    if (!p) return;
    const items = await watchlistApi.list(p.profileId);
    if (get().activeProfile?.profileId === p.profileId) {
      set({ watchlist: items, watchlistKeys: new Set(items.map((i) => keyOf(i.tmdbId, i.mediaType))) });
    }
  },

  toggleWatchlist: async (m) => {
    const p = get().activeProfile;
    if (!p) return false;
    const inList = get().isInWatchlist(m.id, m.mediaType);
    if (inList) {
      await watchlistApi.remove(p.profileId, m.id, m.mediaType);
    } else {
      await catalog.cache([summaryToCatalogEntry(m)]);
      await watchlistApi.add(p.profileId, m.id, m.mediaType);
      get().toast({ kind: "success", title: "Added to Up Next", body: m.title });
    }
    set({ recsStale: true });
    await get().refreshWatchlist();
    return !inList;
  },

  isInWatchlist: (id, mt) => get().watchlistKeys.has(keyOf(id, mt)),

  loadRecommendations: async (force = false) => {
    const p = get().activeProfile;
    if (!p || !get().tmdbReady) return;
    if (get().recsLoading && !force) return; // one in-flight computation at a time
    set({ recsLoading: true, recsError: null });
    try {
      const recs = await recommendations.get(p.profileId, force);
      if (get().activeProfile?.profileId === p.profileId) set({ recs, recsLoading: false, recsStale: false });
    } catch (e) {
      // Not stale anymore: failures must not trigger automatic retry loops (Retry is explicit).
      set({ recsLoading: false, recsStale: false, recsError: e instanceof Error ? e.message : String(e) });
    }
  },

  markRecsStale: () => set({ recsStale: true }),

  // ------------------------------------------------------------------------------------------
  // Toasts & derived context
  // ------------------------------------------------------------------------------------------

  toast: (t) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.kind === "error" ? 8000 : 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  catalogContext: () => {
    const s = get();
    const providers = s.providerFilter
      ? [s.providerFilter]
      : s.subscriptionsOnly
        ? s.subscriptions.filter((p) => p.isActive).map((p) => p.providerId)
        : [];
    return { region: s.region, providers, kids: s.isKids() };
  },

  isKids: () => !!get().activeProfile?.isKidsProfile || get().kidsSafeMode,
}));

/** Subscribe to the catalog context as a stable string key (for effect deps). */
export const useCatalogKey = () =>
  useAppStore((s) =>
    [s.region, s.subscriptionsOnly, s.providerFilter, s.subscriptions.map((p) => p.providerId).join(","), s.kidsSafeMode, s.activeProfile?.isKidsProfile].join("|"),
  );
