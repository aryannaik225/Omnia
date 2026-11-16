/**
 * Playback on a phone / TV: there is no Omnia player window there, so "Play" hands the title to
 * the installed OTT app, which tracks progress on its own servers; the desktop's background
 * delta sync later reads it from there.
 *
 * - TV (Android): an `ACTION_VIEW` intent via the thin client's Rust `open_in_app`, trying the
 *   app's own scheme first (`nflx://…`), then the web URL (App Links route it to the app).
 * - iPhone (Safari): a sheet with a real link the user taps. iOS only hands a URL to an app
 *   (Universal Links) on a user tap, never on a script redirect after an async lookup.
 */
import { create } from "zustand";
import type { OpenPlayerRequest } from "./tauriBridge";
import { platformMode, tvNative } from "./platform";

/** Candidate URLs for an Android intent, most specific first. */
export function appLinks(providerName: string, url: string): string[] {
  const out: string[] = [];
  const nf = /netflix\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(watch|title)\/(\d+)/i.exec(url);
  if (/netflix/i.test(providerName) && nf) out.push(`nflx://www.netflix.com/${nf[1]!.toLowerCase()}/${nf[2]}`);
  const gti = /primevideo\.com\/(?:[^?#]*\/)?detail\/([A-Za-z0-9.]+)/i.exec(url) ?? /[?&]gti=([A-Za-z0-9.]+)/i.exec(url);
  if (/prime|amazon/i.test(providerName) && gti) out.push(`https://app.primevideo.com/detail?gti=${gti[1]}`);
  out.push(url);
  return [...new Set(out)];
}

export interface PendingHandoff {
  title: string;
  providerName: string;
  url: string;
  isSearch: boolean;
}

export const useHandoff = create<{ pending: PendingHandoff | null; clear: () => void }>((set) => ({
  pending: null,
  clear: () => set({ pending: null }),
}));

export async function handOffPlayback(request: OpenPlayerRequest): Promise<void> {
  if (request.mode === "connect") {
    throw new Error("Link OTT accounts in Omnia on your PC: it signs in inside its own player window.");
  }
  const url = request.directUrl;
  if (!url) throw new Error(`No ${request.providerName} link for this title.`);
  if (platformMode === "tv") {
    try {
      await tvNative.openInApp(appLinks(request.providerName, url));
    } catch {
      throw new Error(`Couldn't open ${request.providerName}. Is its app installed on this TV?`);
    }
    return;
  }
  useHandoff.setState({
    pending: { title: request.title ?? "this title", providerName: request.providerName, url, isSearch: /[?&](q|query|search|phrase)=/i.test(url) },
  });
}
