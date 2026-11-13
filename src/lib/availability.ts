/**
 * "My Subscriptions" filtering for rows that weren't fetched under the current filter: backend
 * recommendation rows computed before a toggle, Continue Watching, the hero's personal picks.
 * Rows already filtered at the source are marked `trusted` and pass through untouched.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { streamingFamilies } from "../services/catalog";
import type { MediaType } from "../services/tauriBridge";
import { useAppStore } from "../store/useAppStore";
import { providerFamily } from "./providers";

export interface AvailabilityTarget {
  id: number;
  mediaType: MediaType;
  /** Known provider for this item (e.g. where it was last watched): decides without a lookup. */
  providerName?: string | null;
  /** Already filtered at the source under the current filter state. */
  trusted?: boolean;
}

/** Sorted, comma-joined family keys the catalog is restricted to ("" = all platforms). */
export function useFilterFamilies(): string {
  return useAppStore((s) => {
    const ids = new Set(s.catalogContext().providers);
    if (!ids.size) return "";
    const keys = new Set(s.subscriptions.filter((p) => ids.has(p.providerId)).map((p) => providerFamily(p.providerId, p.providerName).key));
    return [...keys].sort().join(",");
  });
}

export interface FilteredItems<T> {
  items: T[];
  /** Some items are still being verified (they stay hidden until confirmed). */
  checking: boolean;
  /** A subscription / provider filter is in effect. */
  active: boolean;
}

export function useSubscriptionFilter<T>(items: T[], target: (item: T) => AvailabilityTarget): FilteredItems<T> {
  const region = useAppStore((s) => s.region);
  const familyKey = useFilterFamilies();
  const active = familyKey !== "";
  const scope = `${region}|${familyKey}`;
  const [verdicts, setVerdicts] = useState<Record<string, boolean>>({});
  // Targets are re-derived every render: trust can flip (e.g. the filter toggled) while the
  // items array itself is unchanged, so memos key on `signature`, not on `items` alone.
  const targets = items.map(target);
  const signature = targets.map((t) => `${t.mediaType}:${t.id}:${t.trusted ? 1 : 0}:${t.providerName ?? ""}`).join("|");
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  const families = useMemo(() => new Set(familyKey.split(",").filter(Boolean)), [familyKey]);
  const verdictKey = (t: AvailabilityTarget) => `${scope}|${t.mediaType}:${t.id}`;

  /** Synchronous verdict when possible, `undefined` while a lookup is pending. */
  const decide = (t: AvailabilityTarget): boolean | undefined => {
    if (t.trusted) return true;
    if (t.providerName) return families.has(providerFamily(-1, t.providerName).key);
    return verdicts[verdictKey(t)];
  };

  const pendingIds = active
    ? targets
        .filter((t) => decide(t) === undefined)
        .map((t) => `${t.mediaType}:${t.id}`)
        .join(",")
    : "";

  useEffect(() => {
    if (!pendingIds) return;
    let alive = true;
    for (const ref of pendingIds.split(",")) {
      const [mt, id] = ref.split(":") as [MediaType, string];
      const key = `${scope}|${ref}`;
      void streamingFamilies(mt, Number(id), region).then((streaming) => {
        if (!alive) return;
        // Unknown (lookup failed) stays visible rather than blanking rows on a network hiccup.
        const ok = streaming === null || [...streaming].some((f) => families.has(f));
        setVerdicts((v) => (key in v ? v : { ...v, [key]: ok }));
      });
    }
    return () => {
      alive = false;
    };
  }, [pendingIds, scope, region, families]);

  return useMemo(() => {
    if (!active) return { items, checking: false, active };
    const out: T[] = [];
    let checking = false;
    targetsRef.current.forEach((t, i) => {
      const v = decide(t);
      if (v === undefined) checking = true;
      else if (v) out.push(items[i]!);
    });
    return { items: out, checking, active };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, signature, active, verdicts, families, scope]);
}
