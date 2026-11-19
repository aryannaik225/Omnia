"use client";
/**
 * Web edition of the desktop app's UI store (src/store/useAppStore.ts): the same shape the
 * ported components read, minus everything the Rust backend owns. Preferences, the region and
 * subscriptions persist in localStorage; watch tracking lives in components/tracker.
 *
 * Navigation maps desktop "views" onto Next routes (/app, /app/search, /app/hubs/…); the shell
 * registers the router and keeps `view` in sync with the URL.
 */
import { create } from "zustand";
import { registryAsCustomHubs } from "../config/hubsRegistry";
import { DEFAULT_PALETTE, type Rgb } from "../lib/color";
import { providerFamily } from "../lib/providers";
import { detectRegion, FALLBACK_REGION, readStoredRegion, storeRegion, type RegionSource } from "../lib/region";
import type { CatalogContext, MediaSummary } from "../services/tmdbClient";
import type { CustomHub, MediaType, SubscribedProvider } from "../services/tauriBridge";

/** `continue` / `upcoming` / `watchlist` are sections of My Library (kept so ported links work). */
export type View = "home" | "search" | "library" | "continue" | "upcoming" | "myotts" | "hubs" | "watchlist" | "settings" | "browse";

export interface RowRef {
  id: string;
  arg?: string;
  label?: string;
}

export type BrowseTarget =
  | { kind: "row"; ref: RowRef; logoPath?: string | null }
  | { kind: "static"; key: string; title: string; subtitle?: string; items: MediaSummary[] };

export const browseKey = (t: BrowseTarget | null) => (!t ? "" : t.kind === "static" ? `s:${t.key}` : `r:${t.ref.id}:${t.ref.arg ?? ""}`);

export type ModalEntry =
  | { kind: "title"; id: number; mediaType: MediaType; seed?: MediaSummary; autoplay?: boolean }
  | { kind: "person"; id: number };

export interface Toast {
  id: number;
  kind: "info" | "success" | "warning" | "error";
  title: string;
  body?: string;
  /** Optional call to action (e.g. "Sign in"). */
  action?: { label: string; href: string };
}

const PREFS_KEY = "omnia.prefs.v1";
const SUBS_KEY = "omnia.subscriptions.v1";

interface Prefs {
  subscriptionsOnly: boolean;
  kidsSafeMode: boolean;
  trailerAutoplay: boolean;
  sidebarPinned: boolean;
}
const DEFAULT_PREFS: Prefs = { subscriptionsOnly: false, kidsSafeMode: false, trailerAutoplay: true, sidebarPinned: false };

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: preferences last for this visit.
  }
}

let toastSeq = 1;
let routerPush: ((href: string) => void) | null = null;
/** The shell hands the Next router to the store so `navigate` can change routes. */
export const registerRouter = (push: (href: string) => void) => {
  routerPush = push;
};

export function viewHref(view: View, opts?: { hub?: string | null; browse?: BrowseTarget; q?: string; section?: string }): string {
  switch (view) {
    case "home":
      return "/app";
    case "search":
      return opts?.q ? `/app/search?q=${encodeURIComponent(opts.q)}` : "/app/search";
    case "library":
      return opts?.section ? `/app/library/${opts.section}` : "/app/library";
    case "continue":
      return "/app/library/ongoing";
    case "upcoming":
      return "/app/library/upcoming";
    case "myotts":
      return "/app/my-otts";
    case "hubs":
      return opts?.hub ? `/app/hubs/${encodeURIComponent(opts.hub)}` : "/app/hubs";
    case "watchlist":
      return "/app/library/watchlist";
    case "settings":
      return "/app/settings";
    case "browse": {
      const t = opts?.browse;
      if (!t || t.kind === "static") return `/app/browse${t ? `?s=${encodeURIComponent(t.key)}` : ""}`;
      const p = new URLSearchParams({ row: t.ref.id });
      if (t.ref.arg) p.set("arg", t.ref.arg);
      if (t.ref.label) p.set("label", t.ref.label);
      if (t.logoPath) p.set("logo", t.logoPath);
      return `/app/browse?${p}`;
    }
  }
}

/** Route → view (for the sidebar's active state and per-view scroll memory). */
export function viewFromPath(path: string): View {
  if (path.startsWith("/app/search")) return "search";
  if (path.startsWith("/app/library")) return "library";
  if (path.startsWith("/app/my-otts")) return "myotts";
  if (path.startsWith("/app/hubs")) return "hubs";
  if (path.startsWith("/app/settings")) return "settings";
  if (path.startsWith("/app/browse")) return "browse";
  return "home";
}

interface AppState {
  /** False until the region has been read from storage (or detected): catalog rows wait for it. */
  regionReady: boolean;
  region: string;
  regionSource: RegionSource;
  subscriptions: SubscribedProvider[];
  subscriptionsOnly: boolean;
  kidsSafeMode: boolean;
  trailerAutoplay: boolean;
  tmdbReady: boolean;

  view: View;
  activeHub: string | null;
  browse: BrowseTarget | null;
  browseFrom: View;
  providerFilter: string | null;
  searchQuery: string;
  sidebarPinned: boolean;
  scrollPositions: Partial<Record<string, number>>;

  modalStack: ModalEntry[];
  ambient: [Rgb, Rgb, Rgb];
  hubs: CustomHub[];
  toasts: Toast[];

  boot: () => void;
  setRegion: (code: string, source: RegionSource) => Promise<void>;
  redetectRegion: () => Promise<string | null>;
  saveSubscriptions: (providers: SubscribedProvider[]) => Promise<void>;
  setSubscriptionsOnly: (on: boolean) => Promise<void>;
  setKidsSafeMode: (on: boolean) => Promise<void>;
  setTrailerAutoplay: (on: boolean) => Promise<void>;

  syncRoute: (path: string, search: URLSearchParams) => void;
  navigate: (view: View, opts?: { hub?: string | null; browse?: BrowseTarget; section?: string }) => void;
  rememberScroll: (key: string, top: number) => void;
  setSearchQuery: (q: string) => void;
  setProviderFilter: (familyKey: string | null) => void;
  toggleSidebarPinned: () => void;
  setAmbient: (palette: [Rgb, Rgb, Rgb]) => void;

  openTitle: (entry: Omit<Extract<ModalEntry, { kind: "title" }>, "kind">) => void;
  openPerson: (id: number) => void;
  popModal: () => void;
  closeModals: () => void;

  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;

  catalogContext: () => CatalogContext;
  isKids: () => boolean;
}

const prefsOf = (s: AppState): Prefs => ({
  subscriptionsOnly: s.subscriptionsOnly,
  kidsSafeMode: s.kidsSafeMode,
  trailerAutoplay: s.trailerAutoplay,
  sidebarPinned: s.sidebarPinned,
});

const readSubs = (region: string): SubscribedProvider[] => readJson<Record<string, SubscribedProvider[]>>(SUBS_KEY, {})[region] ?? [];

let regionCheckedThisSession = false;

export const useAppStore = create<AppState>((set, get) => ({
  regionReady: false,
  region: FALLBACK_REGION,
  regionSource: "auto",
  subscriptions: [],
  subscriptionsOnly: false,
  kidsSafeMode: false,
  trailerAutoplay: true,
  tmdbReady: true,

  view: "home",
  activeHub: null,
  browse: null,
  browseFrom: "home",
  providerFilter: null,
  searchQuery: "",
  sidebarPinned: false,
  scrollPositions: {},

  modalStack: [],
  ambient: DEFAULT_PALETTE,
  hubs: registryAsCustomHubs(),
  toasts: [],

  boot: () => {
    const prefs = readJson<Prefs>(PREFS_KEY, DEFAULT_PREFS);
    const stored = readStoredRegion();
    set({ ...prefs });
    if (stored) {
      set({ region: stored.code, regionSource: stored.source, regionReady: true, subscriptions: readSubs(stored.code) });
      // Auto regions are re-checked once per visit (VPN, travel); a manual choice never is.
      if (stored.source === "auto" && !regionCheckedThisSession) {
        regionCheckedThisSession = true;
        void detectRegion().then((code) => {
          if (code !== get().region && get().regionSource === "auto") void get().setRegion(code, "auto");
        });
      }
      return;
    }
    regionCheckedThisSession = true;
    void detectRegion().then((code) => {
      storeRegion({ code, source: "auto" });
      set({ region: code, regionSource: "auto", regionReady: true, subscriptions: readSubs(code) });
    });
  },

  setRegion: async (code, source) => {
    storeRegion({ code, source });
    set({ region: code, regionSource: source, regionReady: true, providerFilter: null, subscriptions: readSubs(code) });
  },

  redetectRegion: async () => {
    const code = await detectRegion();
    await get().setRegion(code, "auto");
    return code;
  },

  saveSubscriptions: async (providers) => {
    const all = readJson<Record<string, SubscribedProvider[]>>(SUBS_KEY, {});
    all[get().region] = providers;
    writeJson(SUBS_KEY, all);
    set({ subscriptions: providers, providerFilter: null, ...(providers.length ? {} : { subscriptionsOnly: false }) });
    writeJson(PREFS_KEY, prefsOf(get()));
  },

  setSubscriptionsOnly: async (on) => {
    set({ subscriptionsOnly: on });
    writeJson(PREFS_KEY, prefsOf(get()));
  },
  setKidsSafeMode: async (on) => {
    set({ kidsSafeMode: on });
    writeJson(PREFS_KEY, prefsOf(get()));
  },
  setTrailerAutoplay: async (on) => {
    set({ trailerAutoplay: on });
    writeJson(PREFS_KEY, prefsOf(get()));
  },

  syncRoute: (path, search) => {
    const view = viewFromPath(path);
    const hub = view === "hubs" ? decodeURIComponent(path.split("/")[3] ?? "") || null : null;
    const patch: Partial<AppState> = { view, activeHub: hub };
    if (view === "browse") {
      const row = search.get("row");
      const current = get().browse;
      if (row && !(current?.kind === "row" && current.ref.id === row && (current.ref.arg ?? "") === (search.get("arg") ?? ""))) {
        patch.browse = { kind: "row", ref: { id: row, arg: search.get("arg") ?? undefined, label: search.get("label") ?? undefined }, logoPath: search.get("logo") };
      }
    } else {
      patch.browseFrom = view;
    }
    if (view === "search") patch.searchQuery = search.get("q") ?? get().searchQuery;
    set(patch);
  },

  navigate: (view, opts) => {
    if (view === "browse") set({ browse: opts?.browse ?? get().browse, scrollPositions: { ...get().scrollPositions, browse: 0 } });
    routerPush?.(viewHref(view, { ...opts, q: view === "search" ? get().searchQuery.trim() : undefined }));
  },
  rememberScroll: (key, top) => set((s) => ({ scrollPositions: { ...s.scrollPositions, [key]: top } })),
  setSearchQuery: (q) => {
    set({ searchQuery: q });
  },
  setProviderFilter: (familyKey) => set({ providerFilter: familyKey }),
  toggleSidebarPinned: () => {
    set({ sidebarPinned: !get().sidebarPinned });
    writeJson(PREFS_KEY, prefsOf(get()));
  },
  setAmbient: (palette) => set({ ambient: palette }),

  openTitle: (entry) => set((s) => ({ modalStack: [...s.modalStack, { kind: "title", ...entry }] })),
  openPerson: (id) => set((s) => ({ modalStack: [...s.modalStack, { kind: "person", id }] })),
  popModal: () => set((s) => ({ modalStack: s.modalStack.slice(0, -1) })),
  closeModals: () => set({ modalStack: [] }),

  toast: (t) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.kind === "error" || t.action ? 8000 : 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  catalogContext: () => {
    const s = get();
    const providers = s.providerFilter
      ? s.subscriptions.filter((p) => providerFamily(p.providerId, p.providerName).key === s.providerFilter).map((p) => p.providerId)
      : s.subscriptionsOnly
        ? s.subscriptions.filter((p) => p.isActive).map((p) => p.providerId)
        : [];
    return { region: s.region, providers, kids: s.isKids() };
  },

  isKids: () => get().kidsSafeMode,
}));

export function availabilityKey(s: Pick<AppState, "region" | "catalogContext">): string {
  return `${s.region}|${s.catalogContext().providers.slice().sort((a, b) => a - b).join(",")}`;
}

export const useCatalogKey = () =>
  useAppStore((s) => [s.region, s.subscriptionsOnly, s.providerFilter, s.subscriptions.map((p) => p.providerId).join(","), s.kidsSafeMode].join("|"));
