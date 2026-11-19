"use client";
/**
 * Floating filter bar: search, My Subscriptions / All Platforms and the region (VPN) switcher.
 * Per-service shortcuts live in the sidebar's My OTTs view, so they aren't repeated here.
 */
import { AnimatePresence, m } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { flag, regionName } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { availableRegions } from "../../services/tmdbClient";
import { useAppStore } from "../../store/useAppStore";
import { CheckIcon, GlobeIcon, RefreshIcon, SearchIcon } from "../common/Icons";

const FALLBACK_REGIONS = ["IN", "US", "GB", "CA", "AU", "DE", "FR", "ES", "IT", "JP", "KR", "BR", "MX", "SG", "AE", "NL"];

export function RegionSwitcher({ onClose }: { onClose: () => void }) {
  const region = useAppStore((s) => s.region);
  const source = useAppStore((s) => s.regionSource);
  const setRegion = useAppStore((s) => s.setRegion);
  const redetect = useAppStore((s) => s.redetectRegion);
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const [query, setQuery] = useState("");
  const regions = useAsync(() => availableRegions(), [], tmdbReady);
  const list = useMemo(() => {
    const all = regions.data ?? FALLBACK_REGIONS.map((code) => ({ code, name: regionName(code) }));
    const q = query.trim().toLowerCase();
    return q ? all.filter((r) => r.name.toLowerCase().includes(q) || r.code.toLowerCase() === q) : all;
  }, [regions.data, query]);

  return (
    <m.div
      initial={{ opacity: 0, y: -8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      className="glass-panel glass-strong absolute right-0 top-14 z-50 w-[min(320px,calc(100vw-32px))] p-3"
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <p className="text-[13px] text-label-secondary">
          {source === "auto" ? "Detected from your location" : "Set manually (VPN / travel)"}
        </p>
        <button
          className="chip"
          onClick={async () => {
            await redetect();
            onClose();
          }}
        >
          <RefreshIcon size={14} /> Auto
        </button>
      </div>
      <input autoFocus className="glass-input mb-2" placeholder="Search countries" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="max-h-[320px] overflow-y-auto pr-1">
        {list.map((r) => (
          <li key={r.code}>
            <button
              className="flex w-full items-center gap-3 rounded-pill px-2.5 py-2 text-left text-[14px] hover:bg-white/[0.08]"
              onClick={async () => {
                await setRegion(r.code, "manual");
                onClose();
              }}
            >
              <span className="text-lg">{flag(r.code)}</span>
              <span className="flex-1 truncate">{r.name}</span>
              {r.code === region && <CheckIcon size={16} className="text-[#0a84ff]" />}
            </button>
          </li>
        ))}
      </ul>
    </m.div>
  );
}

export function TopFilterBar() {
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const subscriptionsOnly = useAppStore((s) => s.subscriptionsOnly);
  const setSubscriptionsOnly = useAppStore((s) => s.setSubscriptionsOnly);
  const subs = useAppStore((s) => s.subscriptions);
  const region = useAppStore((s) => s.region);
  const navigate = useAppStore((s) => s.navigate);
  const view = useAppStore((s) => s.view);
  const [regionOpen, setRegionOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!regionOpen) return;
    const onDown = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setRegionOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [regionOpen]);

  return (
    <div className="glass-panel relative flex items-center gap-3 rounded-[20px] px-3 py-2.5 max-md:gap-2 max-md:px-2">
      <label className="relative w-[300px] shrink-0 max-md:w-auto max-md:min-w-0 max-md:flex-1">
        <SearchIcon size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-label-tertiary" />
        <input
          className="glass-input !py-2 pl-10"
          placeholder="Movies, shows, people…"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            // Typing anywhere opens Search, like the desktop app.
            if (e.target.value.trim() && view !== "search") navigate("search");
          }}
          aria-label="Search"
        />
      </label>

      <div className="segmented shrink-0 max-md:hidden" role="tablist" aria-label="Availability">
        <button
          data-active={subscriptionsOnly}
          onClick={() => {
            if (!subs.length) {
              navigate("settings");
              return;
            }
            void setSubscriptionsOnly(true);
          }}
          title={subs.length ? undefined : "Choose your subscriptions in Settings"}
        >
          My Subscriptions
        </button>
        <button data-active={!subscriptionsOnly} onClick={() => void setSubscriptionsOnly(false)}>
          All Platforms
        </button>
      </div>

      <div className="flex-1 max-md:hidden" />

      <div ref={popRef} className="relative shrink-0">
        <button className="chip !py-2" onClick={() => setRegionOpen((o) => !o)} aria-expanded={regionOpen} aria-label="Change region">
          <GlobeIcon size={15} />
          <span className="text-base leading-none">{flag(region)}</span>
          <span className="font-semibold text-label-primary">{region}</span>
        </button>
        <AnimatePresence>{regionOpen && <RegionSwitcher onClose={() => setRegionOpen(false)} />}</AnimatePresence>
      </div>
    </div>
  );
}
