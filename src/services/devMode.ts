/**
 * Hidden Developer Options (Settings → tap the version 7 times). "Direct Stream Testing" adds a
 * "Stream (Dev)" button to title pages that opens a plain HLS / MP4 test player. Both flags
 * live in `app_settings`, so they follow the desktop (and its paired devices).
 */
import { create } from "zustand";
import { settings } from "./tauriBridge";

export const DEV_UNLOCKED = "dev_options_unlocked";
export const DEV_DIRECT_STREAM = "dev_direct_stream";

interface DevState {
  loaded: boolean;
  unlocked: boolean;
  directStream: boolean;
  /** The test player: open with a title (and optionally a URL to start with). */
  player: { title: string; url: string } | null;
  load: () => Promise<void>;
  unlock: () => Promise<void>;
  lock: () => Promise<void>;
  setDirectStream: (on: boolean) => Promise<void>;
  openPlayer: (title: string, url?: string) => void;
  closePlayer: () => void;
}

export const useDevMode = create<DevState>((set, get) => ({
  loaded: false,
  unlocked: false,
  directStream: false,
  player: null,
  load: async () => {
    if (get().loaded) return;
    const all = await settings.getAll().catch(() => ({}) as Record<string, string>);
    set({ loaded: true, unlocked: all[DEV_UNLOCKED] === "true", directStream: all[DEV_UNLOCKED] === "true" && all[DEV_DIRECT_STREAM] === "true" });
  },
  unlock: async () => {
    await settings.set(DEV_UNLOCKED, "true");
    set({ unlocked: true });
  },
  lock: async () => {
    await Promise.all([settings.set(DEV_UNLOCKED, "false"), settings.set(DEV_DIRECT_STREAM, "false")]);
    set({ unlocked: false, directStream: false });
  },
  setDirectStream: async (on) => {
    await settings.set(DEV_DIRECT_STREAM, String(on));
    set({ directStream: on });
  },
  openPlayer: (title, url = "") => set({ player: { title, url } }),
  closePlayer: () => set({ player: null }),
}));
