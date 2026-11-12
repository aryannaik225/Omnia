/**
 * Brand & franchise pills (Apple TV Channels / Disney+ hubs style): theme gradients with an
 * animated light sweep on hover. Hubs are read back from SQLite, so user-added hubs appear too.
 */
import { m } from "framer-motion";
import { useRef } from "react";
import { hubRule } from "../../config/hubsRegistry";
import type { CustomHub } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { RowShell } from "./MediaCarouselRow";

export function HubPill({ hub, width = 236, onClick }: { hub: CustomHub; width?: number | "fill"; onClick: () => void }) {
  const rule = hubRule(hub);
  const { from, to, accent } = rule.theme;
  return (
    <m.button
      onClick={onClick}
      whileHover={{ scale: 1.05, zIndex: 5 }}
      whileFocus={{ scale: 1.05, zIndex: 5 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 320, damping: 24 }}
      className="media-card group relative shrink-0 overflow-hidden text-left outline-none"
      style={{ width: width === "fill" ? "100%" : width, aspectRatio: "16 / 9", background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)` }}
      aria-label={`${hub.displayName} hub`}
    >
      {/* Animated light sweep */}
      <span
        className="pointer-events-none absolute inset-0 -translate-x-full opacity-0 transition-all duration-[1100ms] ease-out group-hover:translate-x-full group-hover:opacity-100"
        style={{ background: `linear-gradient(110deg, transparent 30%, ${accent}55 50%, transparent 70%)` }}
      />
      <span className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full blur-2xl" style={{ background: `${accent}40` }} />
      <span className="specular-sheen" />
      <span className="absolute inset-x-4 bottom-3.5">
        <span className="block text-[19px] font-bold leading-tight tracking-tight drop-shadow" style={{ color: "#fff", textShadow: `0 0 24px ${accent}66` }}>
          {hub.displayName}
        </span>
        {rule.tagline && <span className="mt-0.5 block truncate text-[12px] text-white/75">{rule.tagline}</span>}
      </span>
    </m.button>
  );
}

export function BrandHubsRow() {
  const hubs = useAppStore((s) => s.hubs);
  const navigate = useAppStore((s) => s.navigate);
  const kids = useAppStore((s) => s.isKids());
  const scroller = useRef<HTMLDivElement | null>(null);
  const visible = kids ? hubs.filter((h) => hubRule(h).kidsSafe || ["disney-pixar", "studio-ghibli"].includes(h.hubSlug)) : hubs;
  if (!visible.length) return null;

  return (
    <RowShell
      title="Franchises & Hubs"
      subtitle="Universes, studios and originals"
      onScroll={(dir) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: "smooth" })}
    >
      <div ref={scroller} className="row-scroller">
        {visible.map((h) => (
          <HubPill key={h.hubSlug} hub={h} onClick={() => navigate("hubs", { hub: h.hubSlug })} />
        ))}
      </div>
    </RowShell>
  );
}
