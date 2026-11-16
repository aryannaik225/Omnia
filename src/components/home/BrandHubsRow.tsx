/**
 * Brand & franchise pills (Apple TV Channels / Disney+ hubs style): TMDB collection / network
 * artwork under a theme-tinted scrim, the brand logo, and an animated light sweep on hover.
 * Hubs are read back from SQLite, so user-added hubs appear (and get artwork) too.
 */
import { m } from "framer-motion";
import { useRef, useState } from "react";
import { hubRule } from "../../config/hubsRegistry";
import { useAsync, useInView } from "../../lib/hooks";
import { hubArtwork } from "../../services/catalog";
import { img } from "../../services/tmdbClient";
import type { CustomHub } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { RowShell } from "./MediaCarouselRow";

export function HubPill({ hub, width = 236, onClick }: { hub: CustomHub; width?: number | "fill"; onClick: () => void }) {
  const rule = hubRule(hub);
  const { from, to, accent } = rule.theme;
  const region = useAppStore((s) => s.region);
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const [ref, inView] = useInView<HTMLButtonElement>("400px");
  const art = useAsync(() => hubArtwork(hub, region), [hub.hubSlug, region], inView && tmdbReady);
  // A different still of the franchise each time the card mounts (app start, page visit).
  const [pick] = useState(() => Math.random());
  const [backdropLoaded, setBackdropLoaded] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  // A logo asset set on the hub row (user-added hubs) wins over the TMDB one.
  const pool = art.data?.backdrops ?? [];
  const backdrop = img(pool.length ? pool[Math.floor(pick * pool.length)] : art.data?.backdropPath, "w780");
  const logo = hub.logoAsset ?? img(art.data?.logoPath, "w300");

  return (
    <m.button
      ref={ref}
      onClick={onClick}
      whileHover={{ scale: 1.05, zIndex: 5 }}
      whileFocus={{ scale: 1.05, zIndex: 5 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 320, damping: 24 }}
      className="media-card group relative shrink-0 overflow-hidden text-left outline-none"
      style={{ width: width === "fill" ? "100%" : `min(${width}px, var(--landscape-max, ${width}px))`, aspectRatio: "16 / 9", background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)` }}
      aria-label={`${hub.displayName} hub`}
    >
      {backdrop && (
        <img
          src={backdrop}
          alt=""
          loading="lazy"
          onLoad={() => setBackdropLoaded(true)}
          className={`absolute inset-0 h-full w-full object-cover transition-[opacity,transform] duration-700 ease-out group-hover:scale-[1.04] ${backdropLoaded ? "opacity-100" : "opacity-0"}`}
        />
      )}
      {/* Theme tint + legibility scrim over the artwork */}
      <span
        className="pointer-events-none absolute inset-0"
        style={{
          background: `linear-gradient(180deg, ${from}26 0%, ${from}8c 55%, ${from}f2 100%), linear-gradient(120deg, ${to}59 0%, transparent 60%)`,
        }}
      />
      {/* Animated light sweep */}
      <span
        className="pointer-events-none absolute inset-0 -translate-x-full opacity-0 transition-all duration-[1100ms] ease-out group-hover:translate-x-full group-hover:opacity-100"
        style={{ background: `linear-gradient(110deg, transparent 30%, ${accent}55 50%, transparent 70%)` }}
      />
      <span className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full blur-2xl" style={{ background: `${accent}40` }} />
      <span className="specular-sheen" />
      {logo && !logoFailed && (
        <img
          src={logo}
          alt=""
          loading="lazy"
          onError={() => setLogoFailed(true)}
          // TMDB brand logos are mostly dark-on-transparent: render them as a white mark.
          className="pointer-events-none absolute left-4 top-3.5 h-6 max-w-[45%] object-contain object-left opacity-90 drop-shadow"
          style={{ filter: "brightness(0) invert(1)" }}
        />
      )}
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
