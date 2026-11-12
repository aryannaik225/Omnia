/**
 * Poster (2:3) and landscape (16:9) cards with the 3D specular hover: spring scale to 1.06,
 * subtle tilt toward the cursor, deeper shadow and a diagonal sheen that tracks the pointer.
 */
import { m, useMotionValue, useReducedMotion, useSpring } from "framer-motion";
import { memo, useRef, type ReactNode } from "react";
import { useRafCallback } from "../../lib/hooks";
import { img } from "../../services/tmdbClient";
import { StarIcon } from "./Icons";

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
  onClick: () => void;
}

export const PosterCard = memo(function PosterCard({ title, posterPath, year, rating, badge, caption, width = 168, onClick }: PosterCardProps) {
  const { ref, rx, ry, onMove, reset } = useSpecular();
  const src = img(posterPath, "w342");
  return (
    <div className="shrink-0" style={{ width: width === "fill" ? "100%" : width }}>
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
      </m.button>
      <div className="mt-2.5 px-0.5">
        <p className="truncate text-[13px] font-medium text-label-primary">{title}</p>
        <p className="flex items-center gap-1.5 truncate text-[12px] text-label-tertiary">
          {year && <span>{year}</span>}
          {rating ? (
            <span className="inline-flex items-center gap-0.5">
              <StarIcon size={10} className="text-yellow-300" />
              {rating.toFixed(1)}
            </span>
          ) : null}
          {caption && <span className="truncate">· {caption}</span>}
        </p>
      </div>
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
    <div className="shrink-0" style={{ width }}>
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
