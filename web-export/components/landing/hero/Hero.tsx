"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { ArrowRight, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ShowPoster } from "@/lib/landing";
import { PosterArt, WindowsIcon } from "../ui";

const TheaterScene = dynamic(() => import("./TheaterScene"), { ssr: false });

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Shown before the scene is ready and where WebGL isn't available: the same theater in CSS. */
function StaticTheater({ posters }: { posters: ShowPoster[] }) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-black" aria-hidden>
      <div className="absolute inset-x-0 top-[16%] flex justify-center gap-3 [perspective:900px]">
        {posters.slice(0, 9).map((p, i) => {
          const d = i - 4;
          return (
            <div key={p.id} className="w-[11vw] min-w-[70px] shrink-0" style={{ transform: `rotateY(${-d * 9}deg) translateZ(${Math.abs(d) * 22}px)` }}>
              <PosterArt p={p} className="aspect-[2/3] rounded-[10px]" sizes="12vw" />
            </div>
          );
        })}
      </div>
      <div className="absolute inset-x-0 top-[48%] h-[40%] bg-gradient-to-b from-[#5a46b4]/15 to-transparent blur-2xl" />
    </div>
  );
}

export function Hero({ posters, version }: { posters: ShowPoster[]; version: string }) {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion() ?? false;
  const [active, setActive] = useState(true);
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [mobile, setMobile] = useState(false);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const fade = useTransform(scrollYProgress, [0, 0.85], [1, 0]);
  const lift = useTransform(scrollYProgress, [0, 1], [0, -120]);
  const curtain = useTransform(scrollYProgress, [0.2, 1], [0, 1]);

  useEffect(() => {
    setWebgl(hasWebGL());
    const mq = window.matchMedia("(max-width: 768px)");
    const onMq = () => setMobile(mq.matches);
    onMq();
    mq.addEventListener("change", onMq);
    const io = new IntersectionObserver(([e]) => setActive(e.isIntersecting), { threshold: 0.01 });
    if (ref.current) io.observe(ref.current);
    const onVis = () => setActive(document.visibilityState === "visible" && (ref.current?.getBoundingClientRect().bottom ?? 1) > 0);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      mq.removeEventListener("change", onMq);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <section ref={ref} id="top" className="relative h-[100svh] min-h-[640px] w-full overflow-hidden bg-black">
      <StaticTheater posters={posters} />
      {webgl && (
        <motion.div className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 2.2, ease: "easeOut" }}>
          <TheaterScene posters={posters} active={active} reduced={reduced} mobile={mobile} />
        </motion.div>
      )}

      {/* lens vignette + bottom fade into the page */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_40%,transparent_60%,rgba(0,0,0,0.75)_100%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[42%] bg-gradient-to-t from-black via-black/45 to-transparent" />
      <motion.div className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: curtain }} />

      <motion.div style={{ opacity: fade, y: lift }} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-[max(env(safe-area-inset-bottom),56px)] sm:px-8">
        <div className="mx-auto max-w-[1180px]">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6, duration: 0.9 }}
            className="mb-5 hidden items-center gap-2 rounded-full sm:inline-flex [@media(max-height:820px)]:!hidden px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.22em] text-white/70 lg-glass-soft"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#ff453a] opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#ff453a]" />
            </span>
            Now showing · Omnia v{version}
          </motion.div>
          <h1 className="font-display text-[clamp(36px,5.6vw,88px)] font-extrabold leading-[0.98] tracking-[-0.038em] [word-spacing:0.1em] text-white">
            <motion.span className="block" initial={{ opacity: 0, y: 40, filter: "blur(12px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ delay: 0.8, duration: 1.2, ease: [0.2, 0.7, 0.2, 1] }}>
              Every streaming service.
            </motion.span>
            <motion.span className="block italic text-foil" initial={{ opacity: 0, y: 40, filter: "blur(12px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ delay: 1.05, duration: 1.2, ease: [0.2, 0.7, 0.2, 1] }}>
              One marquee.
            </motion.span>
          </h1>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.5, duration: 1 }} className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <p className="max-w-[560px] text-pretty text-[16px] leading-relaxed text-white/65 sm:text-[17px]">
              Netflix, Prime Video, Disney+, HBO Max, Apple TV+ and the rest, searched as one library, played in one feather-light native player and remembered to the second. Your taste never
              leaves your PC.
            </p>
            <div className="pointer-events-auto flex flex-wrap gap-3">
              <a href="#download" className="group inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-[14px] bg-white px-5 py-3.5 text-[15px] font-semibold text-black shadow-[0_10px_40px_-10px_rgba(255,255,255,0.6)] transition-transform hover:scale-[1.03]">
                <WindowsIcon /> Download for Windows
                <span className="rounded-md bg-black/10 px-1.5 py-0.5 font-mono text-[11px]">v{version}</span>
              </a>
              <Link href="/app" className="group inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[14px] px-5 py-3.5 text-[15px] font-medium text-white lg-glass transition-colors hover:bg-white/10">
                Open in browser <ArrowRight size={16} className="transition-transform group-hover:translate-x-1" />
              </Link>
            </div>
          </motion.div>
        </div>
      </motion.div>

      <motion.a
        href="#problem"
        aria-label="Scroll down"
        style={{ opacity: fade }}
        className="absolute bottom-4 left-1/2 z-10 hidden -translate-x-1/2 flex-col items-center gap-1 font-mono text-[10px] uppercase tracking-[0.3em] text-white/40 md:flex"
      >
        Dim the lights
        <motion.span animate={reduced ? undefined : { y: [0, 6, 0] }} transition={{ repeat: Infinity, duration: 2.2 }}>
          <ChevronDown size={16} />
        </motion.span>
      </motion.a>
    </section>
  );
}
