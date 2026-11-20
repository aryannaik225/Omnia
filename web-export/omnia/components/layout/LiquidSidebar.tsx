"use client";
/**
 * Floating Liquid Glass sidebar. It rests as a collapsed icon rail everywhere, refracting the
 * content beneath it; it expands over the content on hover (or keyboard focus) and can be pinned
 * open with the toggle, which also makes the content column make room for it.
 */
import { m } from "framer-motion";
import { useState, type ComponentType, type FocusEvent } from "react";
import Link from "next/link";
import { useTracker } from "@/components/tracker/TrackerProvider";
import { useLibrary } from "@/components/tracker/useLibrary";
import { flag } from "../../lib/format";
import { requestScrollTop } from "../../lib/scrollTop";
import { useAppStore, type View } from "../../store/useAppStore";
import { BookmarkIcon, GearIcon, GridIcon, HomeIcon, SearchIcon, SidebarIcon, TvIcon } from "../common/Icons";

const wordmark = "/omnia-wordmark.png";

/** Calendar glyph for Upcoming (web: the release calendar of what you follow). */
export const CalendarIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </svg>
);

export const SIDEBAR_EXPANDED = 248;
export const SIDEBAR_COLLAPSED = 76;
/** Wordmark is drawn 32 px tall: the rounded-square mark alone is 32 px wide, mark + "Omnia" 101 px. */
const LOGO_H = 32;
const LOGO_FULL_W = Math.round((LOGO_H * 3232) / 1024);

const NAV: { view: View; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { view: "search", label: "Search", icon: SearchIcon },
  { view: "home", label: "Home", icon: HomeIcon },
  { view: "library", label: "My Library", icon: BookmarkIcon },
  { view: "myotts", label: "My OTTs", icon: TvIcon },
  { view: "hubs", label: "Franchises & Hubs", icon: GridIcon },
  { view: "settings", label: "Settings", icon: GearIcon },
];

export function LiquidSidebar() {
  const view = useAppStore((s) => s.view);
  const navigate = useAppStore((s) => s.navigate);
  const pinned = useAppStore((s) => s.sidebarPinned);
  const togglePinned = useAppStore((s) => s.toggleSidebarPinned);
  const region = useAppStore((s) => s.region);
  const tracker = useTracker();
  const cwCount = useLibrary().upNext.length;
  const [hover, setHover] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const collapsed = !pinned && !hover && !keyboardFocus;
  // Only keyboard focus expands it: a mouse click leaves focus on the button, which must not
  // keep the rail open after the pointer has left.
  const onFocus = (e: FocusEvent<HTMLElement>) => setKeyboardFocus(e.target.matches(":focus-visible"));
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyboardFocus(false);
  };

  return (
    <m.nav
      aria-label="Primary"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocusCapture={onFocus}
      onBlurCapture={onBlur}
      animate={{ width: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED }}
      transition={{ type: "spring", stiffness: 300, damping: 32 }}
      className="glass fixed bottom-4 left-4 top-4 z-40 flex flex-col overflow-hidden rounded-card px-3 py-5"
    >
      <div className="mb-6 flex items-center gap-3 px-2.5">
        <button
          onClick={togglePinned}
          aria-pressed={pinned}
          aria-label={pinned ? "Collapse sidebar" : "Keep sidebar open"}
          title={pinned ? "Collapse sidebar" : "Keep sidebar open"}
          className="shrink-0 rounded-[10px] transition-transform hover:scale-[1.03]"
        >
          {/* Collapsed rail shows just the mark; expanding reveals the "Omnia" lettering. */}
          <m.div
            initial={false}
            animate={{ width: collapsed ? LOGO_H : LOGO_FULL_W }}
            transition={{ type: "spring", stiffness: 300, damping: 32 }}
            className="overflow-hidden"
            style={{ height: LOGO_H }}
          >
            <img src={wordmark} alt="Omnia" draggable={false} style={{ height: LOGO_H, width: LOGO_FULL_W, maxWidth: "none" }} />
          </m.div>
        </button>
        <span className="flex-1" />
        <m.button
          animate={{ opacity: collapsed ? 0 : 1 }}
          onClick={togglePinned}
          aria-pressed={pinned}
          aria-label={pinned ? "Collapse sidebar" : "Keep sidebar open"}
          title={pinned ? "Collapse sidebar" : "Keep sidebar open"}
          tabIndex={collapsed ? -1 : 0}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] transition-colors ${
            pinned ? "bg-white/[0.14] text-label-primary shadow-specular" : "text-label-tertiary hover:bg-white/[0.07] hover:text-label-primary"
          }`}
        >
          <SidebarIcon size={18} />
        </m.button>
      </div>

      <ul className="flex flex-1 flex-col gap-1">
        {NAV.map(({ view: v, label, icon: Icon }) => {
          const active = view === v;
          return (
            <li key={v}>
              <button
                onClick={() => (active ? requestScrollTop() : navigate(v))}
                aria-current={active ? "page" : undefined}
                title={collapsed ? label : undefined}
                className={`relative flex w-full items-center gap-3.5 rounded-pill px-[15.5px] py-2.5 text-[15px] font-medium transition-colors duration-200 ${
                  active ? "text-label-primary" : "text-label-secondary hover:bg-white/[0.07] hover:text-label-primary"
                }`}
              >
                {active && (
                  <m.span
                    layoutId="sidebar-active"
                    className="absolute inset-0 rounded-pill bg-white/[0.14] shadow-specular"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="relative shrink-0">
                  <Icon size={21} />
                  {v === "library" && cwCount > 0 && collapsed && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[#0a84ff]" />}
                </span>
                <m.span animate={{ opacity: collapsed ? 0 : 1 }} className="relative whitespace-nowrap">
                  {label}
                </m.span>
                {v === "library" && cwCount > 0 && !collapsed && (
                  <span className="relative ml-auto rounded-full bg-white/[0.12] px-2 text-[11px] font-semibold">{cwCount}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/* Account: guests track in this browser; signing in (optional) syncs everywhere. */}
      <Link
        href={tracker.user ? "/app/settings" : tracker.canSignIn ? "/app/login" : "/app/settings"}
        className="flex items-center gap-3 rounded-pill px-1.5 py-1.5 text-left hover:bg-white/[0.07]"
        title={tracker.user ? "Account" : tracker.canSignIn ? "Sign in to save & sync" : "Guest"}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#5e5ce6] to-[#0a84ff] text-[16px] font-bold shadow-specular">
          {(tracker.user?.email?.[0] ?? "G").toUpperCase()}
        </span>
        <m.span animate={{ opacity: collapsed ? 0 : 1 }} className="min-w-0 whitespace-nowrap">
          <span className="block truncate text-[14px] font-semibold">{tracker.user ? tracker.user.email?.split("@")[0] ?? "Signed in" : "Guest"}</span>
          <span className="block text-[12px] text-label-tertiary">
            {flag(region)} {region} · {tracker.user ? "Synced" : tracker.canSignIn ? "Sign in to sync" : "Saved in this browser"}
          </span>
        </m.span>
      </Link>
    </m.nav>
  );
}
