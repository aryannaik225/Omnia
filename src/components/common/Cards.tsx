/**
 * Poster (2:3) and landscape (16:9) cards with the 3D specular hover: spring scale to 1.06,
 * subtle tilt toward the cursor, deeper shadow and a diagonal sheen that tracks the pointer.
 */
import { m, useMotionValue, useReducedMotion, useSpring } from "framer-motion";
import { memo, useRef, type ReactNode } from "react";
import { useRafCallback } from "../../lib/hooks";
import { img } from "../../services/tmdbClient";
import tmdbLogo from "../../assets/tmdb-logo.svg";
import { ChevronRightIcon } from "./Icons";

const SPRING = { type: "spring", stiffness: 320, damping: 24, mass: 0.6 } as const;

function useSpecular() {
  const ref = useRef<HTMLButtonElement | null>(null);
  const reduce = useReducedMotion();
  const rx = useSpring(useMotionValue(0), { stiffness: 220, damping: 20 });
  const ry = useSpring(useMotionValue(0), { stiffness: 220, damping: 20 });
  const onMove = useRafCallback((x: number, y: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (x - r.left) / r.width;
    const py = (y - r.top) / r.height;
    el.style.setProperty("--mx", `${px * 100}%`);
    el.style.setProperty("--my", `${py * 100}%`);
    if (!reduce) {
      rx.set((0.5 - py) * 8);
      ry.set((px - 0.5) * 10);
    }
  });
  const reset = () => {
    rx.set(0);
    ry.set(0);
  };
  return { ref, rx, ry, onMove, reset };
}

interface PosterCardProps {
  title: string;
  posterPath: string | null;
  year?: number | null;
  rating?: number | null;
  /** Small pill on the artwork (e.g. "97% match"). */
  badge?: ReactNode;
  /** Micro-copy under the title (e.g. "Because you liked Dark"). */
  caption?: string | null;
  /** Pixel width, or "fill" to take the grid cell's width. */
  width?: number | "fill";
  /** 0..1 progress bar over the bottom of the artwork. */
  progress?: number | null;
  /** Secondary line under the title (e.g. "S2 E1 · Episode title"). */
  subtitle?: string | null;
  /** Element shown in the artwork's top-right corner on hover (e.g. remove). */
  cornerAction?: ReactNode;
  /** Artwork only (no title / year / rating lines), e.g. Top 10 cards. */
  hideMeta?: boolean;
  onClick: () => void;
}

export const PosterCard = memo(function PosterCard({
  title,
  posterPath,
  year,
  rating,
  badge,
  caption,
  width = 168,
  progress,
  subtitle,
  cornerAction,
  hideMeta = false,
  onClick,
}: PosterCardProps) {
  const { ref, rx, ry, onMove, reset } = useSpecular();
  const src = img(posterPath, "w342");
  return (
    // Phones cap row posters via `--poster-max` (liquid-glass.css) so ~3 fit per screen.
    <div className="shrink-0" style={{ width: width === "fill" ? "100%" : `min(${width}px, var(--poster-max, ${width}px))` }}>
      <m.button
        ref={ref}
        type="button"
        onClick={onClick}
        onPointerMove={(e) => onMove(e.clientX, e.clientY)}
        onPointerLeave={reset}
        whileHover={{ scale: 1.06, zIndex: 5 }}
        whileFocus={{ scale: 1.06, zIndex: 5 }}
        whileTap={{ scale: 0.98 }}
        transition={SPRING}
        style={{ rotateX: rx, rotateY: ry, transformPerspective: 800 }}
        className="media-card group block aspect-[2/3] w-full text-left outline-none"
        aria-label={title}
      >
        {src ? (
          <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="flex h-full w-full items-end bg-gradient-to-br from-white/10 to-white/[0.02] p-3 text-sm font-semibold">{title}</div>
        )}
        <span className="specular-sheen" />
        {badge && <span className="absolute left-2 top-2">{badge}</span>}
        {progress != null && (
          <span className="absolute inset-x-2.5 bottom-2.5 block">
            <span className="progress-track block !bg-black/40">
              <span className="progress-fill block" style={{ width: `${Math.max(3, Math.min(100, progress * 100))}%` }} />
            </span>
          </span>
        )}
        {cornerAction && <span className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">{cornerAction}</span>}
      </m.button>
      {!hideMeta && (
        <div className="mt-2.5 px-0.5">
          <p className="truncate text-[13px] font-medium text-label-primary">{title}</p>
          {subtitle && <p className="truncate text-[12px] text-label-secondary">{subtitle}</p>}
          <p className="flex items-center gap-1.5 truncate text-[12px] text-label-tertiary">
            {year && <span>{year}</span>}
            {rating ? <TmdbRating value={rating} /> : null}
            {caption && <span className="truncate">{year || rating ? "· " : ""}{caption}</span>}
          </p>
        </div>
      )}
    </div>
  );
});

/** The official TMDB logo next to the score ("[TMDB] 8.3"). */
export function TmdbRating({ value, size = "sm" }: { value: number; size?: "sm" | "md" }) {
  return (
    <span className={`inline-flex shrink-0 items-center ${size === "md" ? "gap-1.5" : "gap-1"}`} aria-label={`TMDB rating ${value.toFixed(1)}`}>
      <img src={tmdbLogo} alt="" draggable={false} className={size === "md" ? "h-[11px] w-auto" : "h-[8px] w-auto"} />
      <span className="tabular-nums">{value.toFixed(1)}</span>
    </span>
  );
}

/**
 * Top 10 card: a huge outlined rank numeral whose right edge tucks under the poster's
 * bottom-left corner (Netflix-style). "10" is wider, so its card reserves more room.
 */
export const Top10Card = memo(function Top10Card({ rank, title, posterPath, onClick }: { rank: number; title: string; posterPath: string | null; onClick: () => void }) {
  return (
    <div className={`top10-card relative flex shrink-0 items-end ${rank >= 10 ? "top10-card--wide" : ""}`}>
      <span aria-hidden className="top10-rank">
        {rank}
      </span>
      <div className="top10-poster relative z-[1]">
        <PosterCard title={`${rank}. ${title}`} posterPath={posterPath} width="fill" hideMeta onClick={onClick} />
      </div>
    </div>
  );
});

/** The 21st slot of a row: opens the full-page grid for that category. */
export function ViewMoreCard({ onClick, landscape = false, label = "View More" }: { onClick: () => void; landscape?: boolean; label?: string }) {
  return (
    <div className="shrink-0" style={{ width: landscape ? "min(300px, var(--landscape-max, 300px))" : "min(168px, var(--poster-max, 168px))" }}>
      <m.button
        type="button"
        onClick={onClick}
        whileHover={{ scale: 1.06, zIndex: 5 }}
        whileFocus={{ scale: 1.06, zIndex: 5 }}
        whileTap={{ scale: 0.98 }}
        transition={SPRING}
        className={`view-more-card group flex w-full flex-col items-center justify-center gap-3 outline-none ${landscape ? "aspect-video" : "aspect-[2/3]"}`}
        aria-label={label}
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/12 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition-transform duration-300 group-hover:translate-x-1">
          <ChevronRightIcon size={22} />
        </span>
        <span className="text-[14px] font-semibold tracking-tight">{label}</span>
      </m.button>
    </div>
  );
}

/** "Browse by Service": the provider's app icon on glass, with its own colours bleeding behind. */
export const ServiceCard = memo(function ServiceCard({ name, logoPath, onClick }: { name: string; logoPath: string | null; onClick: () => void }) {
  const src = img(logoPath, "w154");
  return (
    <div className="shrink-0" style={{ width: "min(220px, var(--landscape-max, 220px))" }}>
      <m.button
        type="button"
        onClick={onClick}
        whileHover={{ scale: 1.06, zIndex: 5 }}
        whileFocus={{ scale: 1.06, zIndex: 5 }}
        whileTap={{ scale: 0.98 }}
        transition={SPRING}
        className="media-card group relative flex aspect-video w-full items-center justify-center overflow-hidden outline-none"
        aria-label={`Popular on ${name}`}
      >
        {src && <img src={src} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-150 object-cover opacity-45 blur-2xl saturate-150" draggable={false} />}
        <span className="absolute inset-0 bg-[rgba(18,18,22,0.45)]" />
        {src ? (
          <img src={src} alt="" loading="lazy" className="relative h-[54%] w-auto rounded-[14px] shadow-[0_8px_24px_rgba(0,0,0,0.45)]" draggable={false} />
        ) : (
          <span className="relative text-[18px] font-bold">{name}</span>
        )}
        <span className="specular-sheen" />
        <span className="absolute inset-x-3 bottom-2 truncate text-center text-[12px] font-medium text-white/80">{name}</span>
      </m.button>
    </div>
  );
});

interface LandscapeCardProps {
  title: string;
  imagePath: string | null;
  subtitle?: ReactNode;
  /** 0..1 progress bar along the bottom edge. */
  progress?: number | null;
  topLeft?: ReactNode;
  topRight?: ReactNode;
  width?: number;
  onClick: () => void;
}

export const LandscapeCard = memo(function LandscapeCard({ title, imagePath, subtitle, progress, topLeft, topRight, width = 300, onClick }: LandscapeCardProps) {
  const { ref, rx, ry, onMove, reset } = useSpecular();
  const src = img(imagePath, "w780");
  return (
    <div className="shrink-0" style={{ width: `min(${width}px, var(--landscape-max, ${width}px))` }}>
      <m.button
        ref={ref}
        type="button"
        onClick={onClick}
        onPointerMove={(e) => onMove(e.clientX, e.clientY)}
        onPointerLeave={reset}
        whileHover={{ scale: 1.05, zIndex: 5 }}
        whileFocus={{ scale: 1.05, zIndex: 5 }}
        whileTap={{ scale: 0.98 }}
        transition={SPRING}
        style={{ rotateX: rx, rotateY: ry, transformPerspective: 900 }}
        className="media-card group block aspect-video w-full text-left outline-none"
        aria-label={title}
      >
        {src ? (
          <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-white/10 to-white/[0.02]" />
        )}
        <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
        <span className="specular-sheen" />
        {topLeft && <span className="absolute left-2.5 top-2.5">{topLeft}</span>}
        {topRight && <span className="absolute right-2.5 top-2.5">{topRight}</span>}
        <span className="absolute inset-x-3 bottom-3">
          <span className="block truncate text-[14px] font-semibold drop-shadow">{title}</span>
          {subtitle && <span className="mt-0.5 block truncate text-[12px] text-white/75">{subtitle}</span>}
          {progress != null && (
            <span className="progress-track mt-2 block">
              <span className="progress-fill block" style={{ width: `${Math.max(2, Math.min(100, progress * 100))}%` }} />
            </span>
          )}
        </span>
      </m.button>
    </div>
  );
});

export const SkeletonCard = ({ landscape = false, width }: { landscape?: boolean; width?: number | "fill" }) => (
  <div className="shrink-0" style={{ width: width === "fill" ? "100%" : width ?? (landscape ? 300 : 168) }}>
    <div className={`skeleton w-full rounded-card ${landscape ? "aspect-video" : "aspect-[2/3]"}`} />
    {!landscape && <div className="skeleton mt-2.5 h-3 w-3/4 rounded" />}
  </div>
);

export const MatchBadge = ({ percent }: { percent: number }) => (
  <span className="rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-semibold text-[#30d158] backdrop-blur-md">{percent}% match</span>
);
