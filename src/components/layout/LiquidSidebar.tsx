/**
 * Floating Liquid Glass sidebar. It refracts the content scrolling beneath it, collapses to an
 * icon rail when the user scrolls deep into a grid, and re-expands on hover/focus.
 */
import { m } from "framer-motion";
import { useState, type ComponentType } from "react";
import { flag } from "../../lib/format";
import { useAppStore, type View } from "../../store/useAppStore";
import { usePlayerStore } from "../../store/usePlayerStore";
import { Avatar } from "../common/Avatar";
import { BookmarkIcon, GearIcon, GridIcon, HomeIcon, PlayCircleIcon, SearchIcon, TvIcon } from "../common/Icons";

export const SIDEBAR_EXPANDED = 248;
export const SIDEBAR_COLLAPSED = 76;

const NAV: { view: View; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { view: "search", label: "Search", icon: SearchIcon },
  { view: "home", label: "Home", icon: HomeIcon },
  { view: "continue", label: "Watching Now", icon: PlayCircleIcon },
  { view: "myotts", label: "My OTTs", icon: TvIcon },
  { view: "hubs", label: "Franchises & Hubs", icon: GridIcon },
  { view: "watchlist", label: "Watchlist", icon: BookmarkIcon },
  { view: "settings", label: "Settings", icon: GearIcon },
];

export function LiquidSidebar() {
  const view = useAppStore((s) => s.view);
  const navigate = useAppStore((s) => s.navigate);
  const collapsedByScroll = useAppStore((s) => s.sidebarCollapsed);
  const profile = useAppStore((s) => s.activeProfile);
  const openGate = useAppStore((s) => s.openProfileGate);
  const region = useAppStore((s) => s.region);
  const cwCount = useAppStore((s) => s.continueWatching.length);
  const playing = usePlayerStore((s) => s.status);
  const [hover, setHover] = useState(false);
  const collapsed = collapsedByScroll && !hover;

  return (
    <m.nav
      aria-label="Primary"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocusCapture={() => setHover(true)}
      onBlurCapture={() => setHover(false)}
      animate={{ width: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED }}
      transition={{ type: "spring", stiffness: 300, damping: 32 }}
      className="glass fixed bottom-4 left-4 top-4 z-40 flex flex-col overflow-hidden rounded-card px-3 py-5"
    >
      <div className="mb-6 flex items-center gap-3 px-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-white/90 to-white/50 text-[15px] font-bold text-ink-900 shadow-specular">
          O
        </span>
        <m.span animate={{ opacity: collapsed ? 0 : 1 }} className="whitespace-nowrap text-[20px] font-semibold tracking-tight">
          Omnia
        </m.span>
      </div>

      <ul className="flex flex-1 flex-col gap-1">
        {NAV.map(({ view: v, label, icon: Icon }) => {
          const active = view === v;
          return (
            <li key={v}>
              <button
                onClick={() => navigate(v)}
                aria-current={active ? "page" : undefined}
                title={collapsed ? label : undefined}
                className={`relative flex w-full items-center gap-3.5 rounded-pill px-3 py-2.5 text-[15px] font-medium transition-colors duration-200 ${
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
                  {v === "continue" && cwCount > 0 && collapsed && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[#0a84ff]" />}
                </span>
                <m.span animate={{ opacity: collapsed ? 0 : 1 }} className="relative whitespace-nowrap">
                  {label}
                </m.span>
                {v === "continue" && cwCount > 0 && !collapsed && (
                  <span className="relative ml-auto rounded-full bg-white/[0.12] px-2 text-[11px] font-semibold">{cwCount}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {playing && (
        <div className="mb-3 flex items-center gap-2 rounded-pill bg-[#30d158]/15 px-3 py-2 text-[12px] font-medium text-[#30d158]">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[#30d158]" />
          {!collapsed && <span className="truncate">Playing on {playing.providerName}</span>}
        </div>
      )}

      {profile && (
        <button onClick={openGate} className="flex items-center gap-3 rounded-pill px-1.5 py-1.5 text-left hover:bg-white/[0.07]" title="Switch profile">
          <Avatar name={profile.profileName} avatar={profile.avatarAsset} size={40} />
          <m.span animate={{ opacity: collapsed ? 0 : 1 }} className="min-w-0 whitespace-nowrap">
            <span className="block truncate text-[14px] font-semibold">{profile.profileName}</span>
            <span className="block text-[12px] text-label-tertiary">
              {flag(region)} {region} · Switch profile
            </span>
          </m.span>
        </button>
      )}
    </m.nav>
  );
}
