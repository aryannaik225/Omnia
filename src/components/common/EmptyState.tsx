/**
 * Liquid Glass empty state: shown where a profile has no watch activity yet (new profile, or
 * history just cleared) instead of an empty gap. Two sizes: `row` (a 16:9-card-height panel in
 * a Home row) and `page` (centred hero for full views).
 */
import { m, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { useAppStore } from "../../store/useAppStore";
import { LinkIcon, SparklesIcon } from "./Icons";

/** The Omnia ring with a play glyph, drawn in SVG so it stays crisp at any size. */
function RingGlyph({ size }: { size: number }) {
  const reduce = useReducedMotion();
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-hidden>
      {/* Soft ambient glow behind the glass. */}
      <div className="absolute inset-[-18%] rounded-full bg-[radial-gradient(circle,rgba(10,132,255,0.35),rgba(10,132,255,0)_65%)] blur-xl" />
      <m.svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        className="relative"
        animate={reduce ? undefined : { rotate: [0, 4, 0, -4, 0] }}
        transition={reduce ? undefined : { duration: 9, repeat: Infinity, ease: "easeInOut" }}
      >
        <defs>
          <linearGradient id="omnia-empty-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8fd3ff" />
            <stop offset="0.55" stopColor="#3b82f6" />
            <stop offset="1" stopColor="#1e3a8a" />
          </linearGradient>
          <linearGradient id="omnia-empty-play" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#bcd4ff" />
          </linearGradient>
        </defs>
        <ellipse cx="50" cy="50" rx="38" ry="30" transform="rotate(-28 50 50)" fill="none" stroke="url(#omnia-empty-ring)" strokeWidth="9" />
        <ellipse cx="50" cy="50" rx="38" ry="30" transform="rotate(-28 50 50)" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
        <path d="M43 37.5 L63 50 L43 62.5 Z" fill="url(#omnia-empty-play)" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" strokeLinejoin="round" />
      </m.svg>
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  body: ReactNode;
  size?: "row" | "page";
  /** Shows "Discover something" (Home) and "Import your history" (Connect Accounts) actions. */
  actions?: boolean;
}

export function EmptyState({ title, body, size = "page", actions = true }: EmptyStateProps) {
  const navigate = useAppStore((s) => s.navigate);
  const view = useAppStore((s) => s.view);
  const openAccounts = useAppStore((s) => s.setAccountSyncOpen);
  const row = size === "row";

  const buttons = actions && (
    <div className={`flex flex-wrap gap-2.5 ${row ? "" : "justify-center"}`}>
      <button
        className="glass-button !bg-white/90 !px-4 !py-2 !text-[#0b0b0f] hover:!bg-white"
        onClick={() => {
          if (view === "home") document.querySelector("main")?.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" });
          else navigate("home");
        }}
      >
        <SparklesIcon size={15} /> Discover something
      </button>
      <button className="glass-button !px-4 !py-2" onClick={() => openAccounts(true)}>
        <LinkIcon size={15} /> Import your history
      </button>
    </div>
  );

  return (
    <m.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
      className={`glass-panel relative overflow-hidden ${
        row ? "flex min-h-[176px] items-center gap-7 px-8 py-6" : "mx-auto flex max-w-[560px] flex-col items-center px-10 py-12 text-center"
      }`}
      role="status"
    >
      {/* Specular sheen across the glass. */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,rgba(255,255,255,0.08),rgba(255,255,255,0)_40%)]" />
      <RingGlyph size={row ? 92 : 132} />
      <div className={`relative min-w-0 ${row ? "flex-1" : "mt-6"}`}>
        <p className={`${row ? "text-[19px]" : "text-[24px]"} font-bold tracking-tight`}>{title}</p>
        <p className={`mt-1.5 text-label-secondary ${row ? "max-w-[560px] text-[14px]" : "text-[15px]"}`}>{body}</p>
        <div className={row ? "mt-4" : "mt-6"}>{buttons}</div>
      </div>
    </m.div>
  );
}
