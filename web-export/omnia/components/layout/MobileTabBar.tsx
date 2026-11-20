"use client";
/**
 * Phone layout: a floating Liquid Glass tab bar replaces the sidebar (iPhone via the LAN
 * companion). Four primary tabs plus "More" (a sheet with the secondary screens and the
 * profile switch), icons with short labels, labels dropped on very narrow screens.
 */
import { AnimatePresence, m } from "framer-motion";
import { useState, type ComponentType } from "react";
import { requestScrollTop } from "../../lib/scrollTop";
import { useAppStore, type View } from "../../store/useAppStore";
import Link from "next/link";
import { useTracker } from "@/components/tracker/TrackerProvider";
import { UserAvatar, accountName } from "../common/UserAvatar";
import { BookmarkIcon, GearIcon, GridIcon, HomeIcon, SearchIcon, TvIcon } from "../common/Icons";

type Icon = ComponentType<{ size?: number }>;

const MoreIcon: Icon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5.5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="18.5" cy="12" r="1.8" />
  </svg>
);

const TABS: { view: View; label: string; icon: Icon }[] = [
  { view: "home", label: "Home", icon: HomeIcon },
  { view: "search", label: "Search", icon: SearchIcon },
  { view: "library", label: "Library", icon: BookmarkIcon },
  { view: "hubs", label: "Hubs", icon: GridIcon },
];

const MORE: { view: View; label: string; icon: Icon }[] = [
  { view: "myotts", label: "My OTTs", icon: TvIcon },
  { view: "settings", label: "Settings", icon: GearIcon },
];

export function MobileTabBar() {
  const view = useAppStore((s) => s.view);
  const navigate = useAppStore((s) => s.navigate);
  const tracker = useTracker();
  const [moreOpen, setMoreOpen] = useState(false);
  const inMore = MORE.some((x) => x.view === view);

  const tab = (active: boolean) =>
    `flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[14px] py-1.5 text-[10px] font-medium ${active ? "bg-white/[0.14] text-label-primary" : "text-label-secondary"}`;

  return (
    <>
      <nav
        aria-label="Primary"
        className="glass fixed inset-x-3 z-40 mx-auto flex max-w-[480px] items-stretch gap-1 rounded-[22px] p-1.5"
        style={{ bottom: "max(12px, env(safe-area-inset-bottom))" }}
      >
        {TABS.map(({ view: v, label, icon: Icon }) => (
          <button key={v} onClick={() => (view === v ? requestScrollTop() : navigate(v))} aria-current={view === v ? "page" : undefined} aria-label={label} className={tab(view === v)}>
            <Icon size={21} />
            <span className="truncate max-[359px]:hidden">{label}</span>
          </button>
        ))}
        <button onClick={() => setMoreOpen(true)} aria-label="More" aria-expanded={moreOpen} className={tab(inMore)}>
          <MoreIcon size={21} />
          <span className="truncate max-[359px]:hidden">More</span>
        </button>
      </nav>

      <AnimatePresence>
        {moreOpen && (
          <m.div className="fixed inset-0 z-[45]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setMoreOpen(false)} />
            <m.div
              role="dialog"
              aria-label="More"
              initial={{ y: 40 }}
              animate={{ y: 0 }}
              exit={{ y: 40 }}
              transition={{ type: "spring", stiffness: 340, damping: 32 }}
              className="glass-panel glass-strong absolute inset-x-3 mx-auto max-w-[480px] p-2"
              style={{ bottom: "calc(max(12px, env(safe-area-inset-bottom)) + 72px)" }}
            >
              <Link
                href={tracker.user || !tracker.canSignIn ? "/app/settings" : "/app/login"}
                onClick={() => setMoreOpen(false)}
                className="flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left hover:bg-white/[0.07]"
              >
                <UserAvatar size={32} />
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-semibold">{tracker.user ? accountName(tracker) : "Guest"}</span>
                  <span className="block text-[12px] text-label-tertiary">{tracker.user ? "Synced to your account" : tracker.canSignIn ? "Sign in to save & sync" : "Saved in this browser"}</span>
                </span>
              </Link>
              {MORE.map(({ view: v, label, icon: Icon }) => (
                <button
                  key={v}
                  onClick={() => {
                    setMoreOpen(false);
                    if (view === v) requestScrollTop();
                    else navigate(v);
                  }}
                  aria-current={view === v ? "page" : undefined}
                  className={`flex w-full items-center gap-3 rounded-[14px] px-3 py-3 text-left text-[15px] ${view === v ? "bg-white/[0.12] text-label-primary" : "text-label-secondary hover:bg-white/[0.07]"}`}
                >
                  <Icon size={20} />
                  {label}
                </button>
              ))}
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </>
  );
}
