import { NextResponse, type NextRequest } from "next/server";

/**
 * Read-only TMDB proxy for the web app. The browser runs the desktop app's TMDB client
 * (omnia/services/tmdbClient.ts) unchanged, but its requests come here so the API key never
 * leaves the server. Only public catalog GET endpoints are allowed, and responses are cached
 * (Next's data cache + CDN) so repeat views cost nothing.
 */
const BASE = "https://api.themoviedb.org/3";
const ALLOWED = /^(trending|discover|movie|tv|search|person|collection|watch|network|company|genre|configuration)(\/[\w-]+)*$/;
const SAFE_SEGMENT = /^[\w-]{1,64}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const key = process.env.TMDB_API_KEY ?? "";
  if (!key) return NextResponse.json({ status_message: "TMDB_API_KEY is not set" }, { status: 503 });

  const { path } = await params;
  if (!path.length || path.length > 6 || !path.every((p) => SAFE_SEGMENT.test(p))) return NextResponse.json({ status_message: "Bad path" }, { status: 400 });
  const joined = path.join("/");
  if (!ALLOWED.test(joined)) return NextResponse.json({ status_message: "Not allowed" }, { status: 403 });

  const url = new URL(`${BASE}/${joined}`);
  req.nextUrl.searchParams.forEach((v, k) => {
    if (k !== "api_key" && k.length <= 64 && v.length <= 512) url.searchParams.set(k, v);
  });
  const bearer = key.length > 60; // v4 read token
  if (!bearer) url.searchParams.set("api_key", key);

  // Searches change with every keystroke and age fast; everything else is stable for an hour.
  const ttl = joined.startsWith("search") ? 600 : 3600;
  let res: Response;
  try {
    res = await fetch(url, { headers: bearer ? { Authorization: `Bearer ${key}` } : undefined, next: { revalidate: ttl } });
  } catch {
    return NextResponse.json({ status_message: "TMDB unreachable" }, { status: 502 });
  }
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status === 401 ? 503 : res.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": res.ok ? `public, max-age=300, s-maxage=${ttl}, stale-while-revalidate=86400` : "no-store",
    },
  });
}
