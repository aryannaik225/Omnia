import { NextResponse } from "next/server";
import { summary, type TitleSummary } from "@/lib/tmdb";

/**
 * Title summaries for the library views (Up Next, Upcoming, Library). The tracker only stores
 * ids, so the browser asks for posters / air dates here; the TMDB key stays on the server and
 * each title is cached for an hour.
 */
const MAX = 120;
const CONCURRENCY = 8;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const items = (Array.isArray((body as { items?: unknown })?.items) ? (body as { items: unknown[] }).items : [])
    .filter((x): x is string => typeof x === "string" && /^(movie|tv):\d{1,9}$/.test(x))
    .slice(0, MAX);

  const rawRegion = (body as { region?: unknown })?.region;
  const region = typeof rawRegion === "string" && /^[A-Z]{2}$/.test(rawRegion) ? rawRegion : "US";
  const out: Record<string, TitleSummary | null> = {};
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const key = items[next++];
        const [type, id] = key.split(":");
        out[key] = await summary(type as "movie" | "tv", Number(id), region).catch(() => null);
      }
    }),
  );
  return NextResponse.json({ titles: out });
}
