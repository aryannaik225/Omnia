/**
 * "My Subscriptions" filtering: a strict intersection of each title's streaming providers
 * (flatrate / free / ads in the active region) with the user's saved providers.
 *
 * Every title is verified, including rows already filtered at the source (`trusted`): TMDB's
 * discover filter checks "has one of your providers" and "is streaming somewhere" separately,
 * so a title you could only rent on a subscribed service can slip through. Trusted titles stay
 * visible while their check runs (no empty rows on first paint) and drop out if it fails;
 * untrusted titles only appear once confirmed. A failed lookup hides the title.
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
  /** Already filtered at the source under the current filter state: shown while verified. */
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
    if (t.providerName) return families.has(providerFamily(-1, t.providerName).key);
    const v = verdicts[verdictKey(t)];
    if (v !== undefined) return v;
    return t.trusted ? true : undefined;
  };

  const pendingIds = active
    ? targets
        .filter((t) => !t.providerName && verdicts[verdictKey(t)] === undefined)
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
        // Strict: a title is shown only when one of its streaming providers is yours. A failed
        // lookup can't prove that, so it's hidden.
        const ok = streaming !== null && [...streaming].some((f) => families.has(f));
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
