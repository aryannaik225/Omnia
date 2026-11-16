/**
 * Where this copy of the Omnia UI runs, and how it reaches the backend.
 *
 * - `desktop`: inside the Tauri desktop app → in-process IPC to the Rust backend.
 * - `lan`:     served by the desktop's LAN companion server to a browser (iPhone Safari) →
 *              same-origin `POST /api/invoke/<command>`, authorised by the pairing cookie.
 * - `tv`:      the Android TV thin client (built with `VITE_OMNIA_THIN_CLIENT=1`) → the
 *              desktop's LAN server over HTTP with the bearer token from pairing; its own tiny
 *              Rust side only discovers the PC and opens OTT apps.
 *
 * Nothing here talks to anything but the user's own PC on the local network.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export type PlatformMode = "desktop" | "lan" | "tv";

const hasTauriIpc = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const platformMode: PlatformMode =
  import.meta.env.VITE_OMNIA_THIN_CLIENT === "1" ? "tv" : hasTauriIpc() ? "desktop" : "lan";

export const isRemote = platformMode !== "desktop";

/** TV-style focus navigation: the TV client, or forced with `?tv=1` (remembered) for testing. */
export const tvNavigation = (() => {
  if (platformMode === "tv") return true;
  try {
    const q = new URLSearchParams(window.location.search).get("tv");
    if (q === "1") localStorage.setItem("omnia.tvNavigation", "1");
    if (q === "0") localStorage.removeItem("omnia.tvNavigation");
    return localStorage.getItem("omnia.tvNavigation") === "1";
  } catch {
    return false;
  }
})();

/** Turns D-pad navigation on / off for this device (Developer Options), then reloads. */
export function setTvNavigation(on: boolean) {
  try {
    if (on) localStorage.setItem("omnia.tvNavigation", "1");
    else localStorage.removeItem("omnia.tvNavigation");
  } catch {
    /* storage unavailable */
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("tv");
  window.location.replace(url.toString());
}

// ---------------------------------------------------------------------------------------------
// TV client: the paired PC
// ---------------------------------------------------------------------------------------------

export interface PairedServer {
  host: string;
  port: number;
  name: string;
  token: string;
}

const SERVER_KEY = "omnia.pairedServer";

export function pairedServer(): PairedServer | null {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    const s = raw ? (JSON.parse(raw) as PairedServer) : null;
    return s && typeof s.host === "string" && typeof s.token === "string" ? s : null;
  } catch {
    return null;
  }
}

export function savePairedServer(s: PairedServer | null) {
  try {
    if (s) localStorage.setItem(SERVER_KEY, JSON.stringify(s));
    else localStorage.removeItem(SERVER_KEY);
  } catch {
    /* storage unavailable: the TV pairs again next launch */
  }
}

export const serverBase = (host: string, port: number) => `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

/** Raised when the PC no longer accepts this device (revoked in Settings, or a new install). */
export class NotPairedError extends Error {
  constructor() {
    super("This device isn't paired with Omnia any more.");
  }
}

/** Fired on `window` when a remote call comes back 401: the UI goes back to pairing. */
export const UNPAIRED_EVENT = "omnia:unpaired";

async function remoteInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  let url = `/api/invoke/${command}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (platformMode === "tv") {
    const s = pairedServer();
    if (!s) throw new NotPairedError();
    url = serverBase(s.host, s.port) + url;
    headers.authorization = `Bearer ${s.token}`;
  }
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(args ?? {}), credentials: "same-origin" });
  } catch {
    throw new Error("Can't reach Omnia on your PC. Is it running, on the same Wi-Fi?");
  }
  const body = await res.json().catch(() => null);
  if (res.status === 401) {
    window.dispatchEvent(new Event(UNPAIRED_EVENT));
    throw new NotPairedError();
  }
  // The desktop bridge rejects with the command's error string, exactly like Tauri's invoke.
  if (!res.ok) throw typeof body === "string" ? body : `Request failed (${res.status})`;
  return body as T;
}

/** The one backend call every service uses. */
export function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return platformMode === "desktop" ? tauriInvoke<T>(command, args) : remoteInvoke<T>(command, args);
}

// ---------------------------------------------------------------------------------------------
// Phone remote control (via the PC's LAN server)
// ---------------------------------------------------------------------------------------------

export type RemoteKey = "up" | "down" | "left" | "right" | "ok" | "back" | "home" | "playpause";

export interface RemoteTarget {
  /** `"pc"` or a paired TV's device id. */
  id: string;
  name: string;
  kind: "pc" | "tv";
}

/** URL + headers for a LAN-server route from this client (same origin, or the TV's paired PC). */
function lanRequest(path: string): { url: string; headers: Record<string, string> } {
  if (platformMode === "tv") {
    const s = pairedServer();
    if (!s) throw new NotPairedError();
    return { url: serverBase(s.host, s.port) + path, headers: { authorization: `Bearer ${s.token}` } };
  }
  return { url: path, headers: {} };
}

export const remoteControl = {
  /** Screens the phone can drive: TVs that are on, then this PC. */
  targets: async (): Promise<RemoteTarget[]> => {
    const { url, headers } = lanRequest("/api/remote/targets");
    const res = await fetch(url, { headers, credentials: "same-origin" });
    if (res.status === 401) window.dispatchEvent(new Event(UNPAIRED_EVENT));
    if (!res.ok) throw new Error("Can't reach Omnia on your PC.");
    return (await res.json()) as RemoteTarget[];
  },
  send: async (target: string, key: RemoteKey): Promise<void> => {
    const { url, headers } = lanRequest("/api/remote/send");
    const res = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ target, key }), credentials: "same-origin" });
    if (!res.ok && res.status !== 204) throw new Error("The key didn't reach Omnia.");
  },
  /** TV: the next key sent to this screen (long-poll, ~25 s), or null when none came. */
  poll: async (signal: AbortSignal): Promise<RemoteKey | null> => {
    const { url, headers } = lanRequest("/api/remote/poll");
    const res = await fetch(url, { headers, signal });
    if (res.status === 401) throw new NotPairedError();
    if (res.status === 204 || !res.ok) return null;
    const j = (await res.json()) as { key?: RemoteKey };
    return j.key ?? null;
  },
};

/** The TV client's own Rust commands (never forwarded to the PC). */
export const tvNative = {
  discover: () => tauriInvoke<{ host: string; port: number; name: string }[]>("discover_lan_servers"),
  /** Opens the first URL an installed app accepts; resolves to the URL that opened. */
  openInApp: (urls: string[]) => tauriInvoke<string>("open_in_app", { urls }),
};

/** Unauthenticated probe of a PC (TV setup): is Omnia there, and does it know this device? */
export async function pingServer(host: string, port: number, token?: string): Promise<{ name: string; paired: boolean } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${serverBase(host, port)}/api/ping`, {
      signal: ctrl.signal,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = (await res.json()) as { omnia?: number; name?: string; paired?: boolean };
    return j.omnia === 1 ? { name: j.name ?? "Omnia PC", paired: !!j.paired } : null;
  } catch {
    return null;
  }
}

/** Pairs the TV with a PC using the PIN shown in the PC's Settings. */
export async function pairWithServer(host: string, port: number, pin: string, name: string): Promise<PairedServer> {
  let res: Response;
  try {
    res = await fetch(`${serverBase(host, port)}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin, deviceName: "Android TV" }),
    });
  } catch {
    throw new Error("Can't reach that PC. Check the address and that Omnia is running.");
  }
  const j = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !j.token) throw new Error(j.error ?? "Pairing failed.");
  const server = { host, port, name, token: j.token };
  savePairedServer(server);
  return server;
}
