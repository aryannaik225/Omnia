"use client";

import { AnimatePresence, motion, useMotionValue, useScroll, useSpring, useTransform, useVelocity } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { Catalog, CatalogKey } from "@/lib/landing";
import { PosterArt } from "./ui";

type Line = { q: string; k: CatalogKey };

const ROW_A: Line[] = [
  { q: "Here's looking at you, kid.", k: "casablanca" },
  { q: "May the Force be with you.", k: "star-wars" },
  { q: "I'm gonna make him an offer he can't refuse.", k: "godfather" },
  { q: "You're gonna need a bigger boat.", k: "jaws" },
  { q: "Why so serious?", k: "the-dark-knight" },
  { q: "To infinity and beyond!", k: "toy-story" },
  { q: "I'm the king of the world!", k: "titanic" },
  { q: "I am Iron Man.", k: "iron-man" },
];
const ROW_B: Line[] = [
  { q: "You talkin' to me?", k: "taxi-driver" },
  { q: "Houston, we have a problem.", k: "apollo-13" },
  { q: "Get busy living, or get busy dying.", k: "shawshank" },
  { q: "I'll be back.", k: "terminator" },
  { q: "Just keep swimming.", k: "finding-nemo" },
  { q: "There's no place like home.", k: "wizard-of-oz" },
  { q: "I see dead people.", k: "sixth-sense" },
  { q: "You can't handle the truth!", k: "a-few-good-men" },
];

function Row({
  lines,
  catalog,
  reverse,
  duration,
  skew,
  onHover,
}: {
  lines: Line[];
  catalog: Catalog;
  reverse?: boolean;
  duration: number;
  skew: ReturnType<typeof useSpring>;
  onHover: (k: CatalogKey | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const doubled = [...lines, ...lines];
  const track = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  // On hover the line eases down to 75% speed (never stops): the CSS animation's playbackRate is
  // tweened, which keeps its position, so there is no jump.
  const ease = (to: number) => {
    cancelAnimationFrame(raf.current);
    const anim = track.current?.getAnimations()[0];
    if (!anim) return;
    const from = anim.playbackRate;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 500);
      anim.playbackRate = from + (to - from) * (1 - Math.pow(1 - k, 3));
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return (
    <motion.div style={{ skewX: skew }} className="marquee overflow-hidden py-3" onPointerEnter={() => ease(0.75)} onPointerLeave={() => ease(1)}>
      <div ref={track} className={`marquee-track ${reverse ? "reverse" : ""}`} style={{ ["--marquee-duration" as string]: `${duration}s` }}>
        {doubled.map((l, i) => {
          const dim = hover !== null && hover % lines.length !== i % lines.length;
          const t = catalog[l.k];
          return (
            <span
              key={i}
              onPointerEnter={(e) => {
                if (e.pointerType !== "mouse") return;
                setHover(i);
                onHover(l.k);
              }}
              onPointerLeave={() => {
                setHover(null);
                onHover(null);
              }}
              className="group relative flex shrink-0 items-baseline gap-4 px-8 transition-opacity duration-300"
              style={{ opacity: dim ? 0.18 : 1 }}
            >
              <span className="font-display text-[clamp(32px,5vw,76px)] font-semibold italic leading-none tracking-[-0.03em] [word-spacing:0.08em] text-white/90 transition-colors duration-300 group-hover:text-[#fff1b8]">
                “{l.q}”
              </span>
              <span className="whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.22em] text-white/35 transition-colors group-hover:text-white/80">
                {t.title} · {t.year}
              </span>
              <span className="ml-4 text-[28px] text-white/15">✦</span>
            </span>
          );
        })}
      </div>
    </motion.div>
  );
}

/** Interlude: famous lines drift past like end-credits, skewing with scroll speed. Hover a line for its poster. */
export function Dialogues({ catalog }: { catalog: Catalog }) {
  const ref = useRef<HTMLElement>(null);
  const { scrollY } = useScroll();
  const v = useVelocity(scrollY);
  const skew = useSpring(useTransform(v, [-3000, 0, 3000], [8, 0, -8]), { stiffness: 120, damping: 30 });

  // The poster card floats beside the cursor (fixed, so it never touches the marquee's layout).
  const [active, setActive] = useState<CatalogKey | null>(null);
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const x = useSpring(px, { stiffness: 320, damping: 30 });
  const y = useSpring(py, { stiffness: 320, damping: 30 });
  const tilt = useSpring(useTransform(useVelocity(px), [-1500, 0, 1500], [-10, 0, 10]), { stiffness: 200, damping: 20 });
  const p = active ? catalog[active] : null;

  return (
    <section
      ref={ref}
      aria-label="Famous film dialogue"
      className="relative overflow-hidden border-y border-white/[0.06] bg-black py-16"
      onPointerMove={(e) => {
        // keep the card on screen: flip to the left of the cursor near the right edge
        const flip = e.clientX > window.innerWidth - 220;
        px.set(e.clientX + (flip ? -170 : 26));
        py.set(Math.max(12, e.clientY - 210));
      }}
    >
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[12vw] bg-gradient-to-r from-black to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-[12vw] bg-gradient-to-l from-black to-transparent" />
      <p className="mb-6 px-4 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-white/35">Every line you love is on some service, somewhere. Omnia knows which.</p>
      <Row lines={ROW_A} catalog={catalog} duration={80} skew={skew} onHover={setActive} />
      <Row lines={ROW_B} catalog={catalog} reverse duration={95} skew={skew} onHover={setActive} />

      <AnimatePresence>
        {p && (
          <motion.div
            key="poster"
            aria-hidden
            style={{ x, y, rotate: tilt }}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.15 } }}
            transition={{ type: "spring", stiffness: 380, damping: 28 }}
            className="pointer-events-none fixed left-0 top-0 z-50 w-[144px] origin-bottom-left"
          >
            <div className="overflow-hidden rounded-[14px] shadow-[0_30px_60px_-12px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.14)]">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div key={p.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                  <PosterArt p={p} className="aspect-[2/3] w-full" priority />
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="mt-2 rounded-[10px] px-2.5 py-1.5 lg-glass">
              <p className="truncate text-[12px] font-semibold text-white">{p.title}</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-white/50">
                {p.year} · {p.cert}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
