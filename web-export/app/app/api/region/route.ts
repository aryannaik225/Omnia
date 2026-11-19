import { NextResponse, type NextRequest } from "next/server";

/**
 * The visitor's country (ISO 3166-1 alpha-2) for the catalog region.
 *
 * 1. Vercel's edge geolocation header `x-vercel-ip-country`: instant, no lookup, no cost.
 *    (Cloudflare's `cf-ipcountry` is honoured too.)
 * 2. Off Vercel (local development / self-hosting), the server asks an IP-country service. On
 *    localhost the server's public IP *is* the developer's connection, so this gives the right
 *    country; it is never used on Vercel, where it would return the data centre's location.
 * 3. `{ country: null }`: the browser falls back to its time zone / language, then US.
 */
export const dynamic = "force-dynamic";

const CODE = /^[A-Z]{2}$/;
const BOGUS = new Set(["XX", "T1", "ZZ", "EU", "AP"]);

async function lookup(url: string, pick: (j: Record<string, unknown>) => unknown, ip: string | null): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(url.replace("{ip}", ip ?? ""), { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!res.ok) return null;
    const code = pick((await res.json()) as Record<string, unknown>);
    return typeof code === "string" && CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

const isPrivate = (ip: string) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80|::ffff:127\.)/i.test(ip);

export async function GET(req: NextRequest) {
  const header = (req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry") ?? "").toUpperCase();
  if (CODE.test(header) && !BOGUS.has(header)) return NextResponse.json({ country: header, source: "edge" }, { headers: { "Cache-Control": "private, no-store" } });

  if (!process.env.VERCEL) {
    // A public client IP (self-hosted behind a proxy) is looked up as itself; a private one
    // (localhost) means "this machine's own connection", which the services see without an IP.
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    const ip = forwarded && !isPrivate(forwarded) ? forwarded : null;
    const country =
      (await lookup("https://ipwho.is/{ip}?fields=success,country_code", (j) => (j.success ? j.country_code : null), ip)) ??
      (await lookup("http://ip-api.com/json/{ip}?fields=status,countryCode", (j) => (j.status === "success" ? j.countryCode : null), ip));
    if (country) return NextResponse.json({ country, source: "ip" }, { headers: { "Cache-Control": "private, no-store" } });
  }
  return NextResponse.json({ country: null, source: null }, { headers: { "Cache-Control": "private, no-store" } });
}
