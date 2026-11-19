"use client";

import { motion, useMotionTemplate, useMotionValue, useSpring, useTransform } from "framer-motion";
import { useRef, type ReactNode } from "react";
import type { ShowPoster } from "@/lib/landing";

/** "REEL 03 · THE PLAYER" eyebrow with a film-sprocket strip. */
export function Reel({ n, label, tone = "text-white/55" }: { n: number; label: string; tone?: string }) {
  return (
    <div className={`flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] ${tone}`}>
      <span className="flex gap-[3px]" aria-hidden>
        {Array.from({ length: 4 }).map((_, i) => (
          <span key={i} className="h-[7px] w-[5px] rounded-[1.5px] bg-current opacity-60" />
        ))}
      </span>
      <span>
        Reel {String(n).padStart(2, "0")} · {label}
      </span>
    </div>
  );
}

/** Large serif section heading that rises in on scroll. */
export function Heading({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.h2
      initial={{ opacity: 0, y: 28, filter: "blur(8px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }}
      className={`text-balance font-display text-[34px] font-bold leading-[1.04] tracking-[-0.035em] text-white sm:text-[48px] lg:text-[60px] ${className}`}
    >
      {children}
    </motion.h2>
  );
}

export function Lede({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.p
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.8, delay: 0.1 }}
      className={`max-w-[620px] text-pretty text-[17px] leading-relaxed text-white/60 ${className}`}
    >
      {children}
    </motion.p>
  );
}

/** Liquid-glass card with spring 3D tilt and a specular sheen that follows the cursor. */
export function TiltCard({ children, className = "", max = 8 }: { children: ReactNode; className?: string; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const rx = useSpring(useTransform(py, [0, 1], [max, -max]), { stiffness: 180, damping: 18 });
  const ry = useSpring(useTransform(px, [0, 1], [-max, max]), { stiffness: 180, damping: 18 });
  const gx = useTransform(px, (v) => `${v * 100}%`);
  const gy = useTransform(py, (v) => `${v * 100}%`);
  const sheen = useMotionTemplate`radial-gradient(420px circle at ${gx} ${gy}, rgba(255,255,255,0.13), transparent 45%)`;
  return (
    <motion.div
      ref={ref}
      onPointerMove={(e) => {
        const r = ref.current!.getBoundingClientRect();
        px.set((e.clientX - r.left) / r.width);
        py.set((e.clientY - r.top) / r.height);
      }}
      onPointerLeave={() => {
        px.set(0.5);
        py.set(0.5);
      }}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 1100 }}
      className={`group relative overflow-hidden rounded-[24px] lg-glass ${className}`}
    >
      <motion.div aria-hidden className="pointer-events-none absolute inset-0 z-20 opacity-0 transition-opacity duration-300 group-hover:opacity-100" style={{ background: sheen }} />
      {children}
    </motion.div>
  );
}

/** Real TMDB poster, or generated poster art in the same frame. */
export function PosterArt({ p, className = "", priority = false }: { p: ShowPoster; sizes?: string; className?: string; priority?: boolean }) {
  const pos = /\b(absolute|fixed)\b/.test(className) ? "" : "relative";
  if (p.poster) {
    // `poster` is already an optimizer URL: render it as-is.
    return (
      <div className={`${pos} overflow-hidden bg-white/5 ${className}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- already an optimizer URL */}
        <img src={p.poster} alt={p.title} loading={priority ? "eager" : "lazy"} decoding="async" className="absolute inset-0 h-full w-full object-cover" />
      </div>
    );
  }
  const [a, b] = p.hues;
  return (
    <div
      className={`${pos} flex flex-col justify-end overflow-hidden p-3 ${className}`}
      style={{ background: `radial-gradient(120% 80% at 30% 15%, ${a}cc 0%, transparent 55%), radial-gradient(90% 70% at 90% 100%, ${a}55 0%, transparent 60%), linear-gradient(180deg, ${b} 0%, #000 100%)` }}
      role="img"
      aria-label={p.title}
    >
      <span className="absolute left-3 top-3 font-mono text-[9px] uppercase tracking-[0.25em] text-white/60">{p.year}</span>
      <span className="font-display text-[clamp(16px,2.2vw,24px)] leading-[0.95] text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]">{p.title}</span>
    </div>
  );
}

export function GithubIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.73.5.75 5.48.75 11.75c0 4.97 3.22 9.18 7.69 10.67.56.1.77-.24.77-.54v-1.9c-3.13.68-3.79-1.51-3.79-1.51-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.57 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.16a10.8 10.8 0 0 1 5.64 0c2.15-1.46 3.1-1.16 3.1-1.16.61 1.55.23 2.7.11 2.98.72.79 1.16 1.8 1.16 3.03 0 4.33-2.64 5.28-5.15 5.56.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.78.54 4.46-1.49 7.68-5.7 7.68-10.67C23.25 5.48 18.27.5 12 .5Z" />
    </svg>
  );
}

export function WindowsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 5.1 10.4 4v7.1H3V5.1Zm8.4-1.2L21 2.5v8.6h-9.6V3.9ZM3 12.9h7.4V20L3 18.9v-6Zm8.4 0H21v8.6l-9.6-1.4v-7.2Z" />
    </svg>
  );
}

/** The desktop app's Academy Award statuette glyph. */
export function Statuette({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <circle cx="12" cy="3.6" r="2.1" />
      <path d="M10.2 6.4h3.6l.5 4.2-.9 1v6.2h-2.8v-6.2l-.9-1z" />
      <rect x="8.2" y="18.4" width="7.6" height="1.6" rx=".5" />
      <rect x="7.2" y="20.4" width="9.6" height="2" rx=".6" />
    </svg>
  );
}

export const PROVIDERS = {
  netflix: { name: "Netflix", color: "#e50914" },
  prime: { name: "Prime Video", color: "#1399ff" },
  hotstar: { name: "JioHotstar", color: "#1f80e0" },
  max: { name: "HBO Max", color: "#6b4bff" },
  disney: { name: "Disney+", color: "#113ccf" },
  apple: { name: "Apple TV+", color: "#d1d1d6" },
  paramount: { name: "Paramount+", color: "#0064ff" },
  crunchyroll: { name: "Crunchyroll", color: "#f47521" },
  hulu: { name: "Hulu", color: "#1ce783" },
  peacock: { name: "Peacock", color: "#f7c600" },
} as const;
export type ProviderKey = keyof typeof PROVIDERS;

export function ProviderChip({ k, className = "" }: { k: ProviderKey; className?: string }) {
  const p = PROVIDERS[k];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold lg-glass-soft ${className}`}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color, boxShadow: `0 0 10px ${p.color}` }} />
      {p.name}
    </span>
  );
}
