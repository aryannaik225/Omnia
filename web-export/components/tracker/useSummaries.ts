"use client";
import { useEffect, useMemo, useState } from "react";
import type { TitleSummary } from "@/lib/tmdb";
import { useAppStore } from "@/omnia/store/useAppStore";

/** Keyed by `${region}|${key}`: a movie's upcoming release depends on the region. */
const cache = new Map<string, TitleSummary | null>();
const CHUNK = 120;

/** Fetches (and caches for the page's lifetime) title summaries for `movie:123` / `tv:456` keys. */
export function useSummaries(keys: string[]) {
  const region = useAppStore((s) => s.region);
  const sig = useMemo(() => [...new Set(keys)].sort().join(","), [keys]);
  const ck = (k: string) => `${region}|${k}`;
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const missing = sig ? sig.split(",").filter((k) => !cache.has(ck(k))) : [];
    if (!missing.length) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      for (let i = 0; i < missing.length; i += CHUNK) {
        const chunk = missing.slice(i, i + CHUNK);
        try {
          const res = await fetch("/app/api/titles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: chunk, region }) });
          const json = (await res.json()) as { titles?: Record<string, TitleSummary | null> };
          for (const k of chunk) cache.set(ck(k), json.titles?.[k] ?? null);
        } catch {
          // Leave them uncached so the next render can retry.
        }
        if (!cancelled) bump((n) => n + 1);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, region]);

  const map = new Map<string, TitleSummary>();
  if (sig) for (const k of sig.split(",")) {
    const v = cache.get(ck(k));
    if (v) map.set(k, v);
  }
  const pending = sig ? sig.split(",").some((k) => !cache.has(ck(k))) : false;
  return { titles: map, loading: loading || pending };
}
