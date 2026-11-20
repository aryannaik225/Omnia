import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { supabaseConfigured } from "@/lib/supabase/env";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * "Paste an image URL" for a profile picture (signed-in users only). Most image hosts don't
 * allow a page to read their pixels, so the server downloads the image once and hands the bytes
 * back; the browser then crops / compresses it to a 256×256 WebP and uploads that to Storage,
 * exactly like a file upload (and like Omnia Desktop's fetch_avatar_image).
 *
 * SSRF guards: http(s) only, public hosts only (every DNS answer checked, again on each of at
 * most 3 redirects), no credentials in the URL, image content types only, 10 MB cap, 8 s timeout.
 * No cookies or user data are sent to the image host.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/avif"]);

function privateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function privateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]!);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith("64:ff9b:") || v.startsWith("2001:db8");
}

const isPrivate = (ip: string) => (isIP(ip) === 4 ? privateV4(ip) : privateV6(ip));

/** Throws unless the URL is a public http(s) address. */
async function assertPublic(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a web address.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an http(s) link to an image.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Use a link to an image on the public web.");
  if (url.port && !["80", "443", ""].includes(url.port)) throw new Error("Use a standard http(s) link.");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new Error("That website couldn't be found.");
  if (addresses.some(isPrivate)) throw new Error("Use a link to an image on the public web.");
  return url;
}

export async function POST(req: Request) {
  if (!supabaseConfigured()) return NextResponse.json({ error: "Accounts aren't enabled on this deployment." }, { status: 503 });
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to set a profile picture." }, { status: 401 });

  let raw: unknown;
  try {
    raw = ((await req.json()) as { url?: unknown })?.url;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof raw !== "string" || raw.trim().length > 2048) return NextResponse.json({ error: "Paste a link to an image." }, { status: 400 });

  try {
    let url = await assertPublic(raw.trim());
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(url, {
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9", "User-Agent": "OmniaAvatarFetcher/1.0" },
      });
      if (res.status < 300 || res.status >= 400) break;
      const next = res.headers.get("location");
      if (!next || hop === MAX_REDIRECTS) throw new Error("That link redirects too many times.");
      url = await assertPublic(new URL(next, url).toString());
    }
    if (!res || !res.ok) throw new Error(`The image couldn't be downloaded (HTTP ${res?.status ?? "error"}).`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!TYPES.has(type)) throw new Error("That link isn't a PNG, JPEG, WebP, GIF or AVIF image. Copy the image address itself (right-click → Copy image address).");
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("That image is larger than 10 MB.");

    // Read with a hard cap (content-length can be missing or wrong).
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new Error("That image is larger than 10 MB.");
        }
        chunks.push(value);
      }
    }
    if (!size) throw new Error("That image is empty.");
    const body = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.byteLength;
    }
    return new NextResponse(body, { headers: { "Content-Type": type === "image/jpg" ? "image/jpeg" : type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (e) {
    const msg = e instanceof Error && !/fetch failed|aborted|timeout/i.test(e.message) ? e.message : "The image couldn't be downloaded from that link.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
