"use client";

import Image from "next/image";
import { AnimatePresence, motion, useMotionValue, useScroll, useTransform, type MotionValue } from "framer-motion";
import { Maximize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Heading, Lede, Reel } from "./ui";

const SHOTS = [
  { src: "/screens/home.png", label: "Home", note: "Full-bleed hero, Top 10 Today and a Liquid Glass sidebar." },
  { src: "/screens/title.png", label: "Title page", note: "Ratings, cast, every provider and the right button for each." },
  { src: "/screens/streaming.png", label: "My OTTs", note: "Browse one service at a time, or all of them together." },
  { src: "/screens/top10-services.png", label: "Top 10 by service", note: "What's charting on each platform in your region today." },
];

/** The real desktop UI, tilting up out of the dark as you scroll. */
export function Interface() {
  const ref = useRef<HTMLElement>(null);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [zoom, setZoom] = useState(false);
  // Phones get a flat, full-width window (a steep 3D tilt squashes a 1440px UI into a sliver).
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "center center"] });
  const flat = useMotionValue(0);
  useEffect(() => flat.set(narrow ? 1 : 0), [narrow, flat]);
  const lerp = (a: number, b: number, v: number) => a + (b - a) * Math.min(1, Math.max(0, v));
  const rotateX = useTransform([scrollYProgress, flat] as MotionValue<number>[], ([v, f]: number[]) => (f ? 0 : lerp(38, 0, v)));
  const scale = useTransform([scrollYProgress, flat] as MotionValue<number>[], ([v, f]: number[]) => (f ? lerp(0.94, 1, v) : lerp(0.82, 1, v)));
  const y = useTransform([scrollYProgress, flat] as MotionValue<number>[], ([v, f]: number[]) => (f ? lerp(30, 0, v) : lerp(80, 0, v)));
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [zoom]);
  const glow = useTransform(scrollYProgress, [0.3, 1], [0, 1]);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setI((v) => (v + 1) % SHOTS.length), 4200);
    return () => clearInterval(id);
  }, [paused]);

  return (
    <section ref={ref} className="relative bg-black px-4 pb-32 pt-28 sm:px-8">
      <div className="mx-auto max-w-[1180px]">
        <Reel n={2} label="The interface" />
        <div className="mt-5 grid gap-6 lg:grid-cols-[1.2fr_1fr] lg:items-end">
          <Heading>
            Liquid Glass, <span className="italic text-white/55">lit by whatever you&apos;re watching.</span>
          </Heading>
          <Lede>
            Frosted, refractive panels float over an ambient glow sampled from the artwork in focus. Posters lift with spring physics and a specular sheen. It feels like the living room, not a spreadsheet of thumbnails.
          </Lede>
        </div>
      </div>

      <div className="mx-auto mt-10 max-w-[1240px] [perspective:1600px] sm:mt-16" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}>
        <motion.div style={{ rotateX, scale, y }} className="relative origin-bottom">
          <motion.div style={{ opacity: glow }} className="absolute -inset-10 -z-10 rounded-[60px] bg-[radial-gradient(60%_60%_at_50%_60%,rgba(140,110,255,0.35),transparent_70%)] blur-3xl" />
          <div className="relative overflow-hidden rounded-[12px] border border-white/10 bg-[#0b0b0f] shadow-[0_60px_160px_-40px_rgba(0,0,0,0.9)] sm:rounded-[22px]">
            <div className="flex items-center gap-1.5 border-b border-white/[0.06] bg-white/[0.03] px-3 py-1.5 sm:gap-2 sm:px-4 sm:py-2.5">
              <span className="h-2 w-2 rounded-full bg-white/15 sm:h-3 sm:w-3" />
              <span className="h-2 w-2 rounded-full bg-white/15 sm:h-3 sm:w-3" />
              <span className="h-2 w-2 rounded-full bg-white/15 sm:h-3 sm:w-3" />
              <span className="ml-2 truncate font-mono text-[10px] text-white/35 sm:ml-3 sm:text-[11px]">Omnia — {SHOTS[i].label}</span>
              <button onClick={() => setZoom(true)} className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] text-white/45 hover:bg-white/10 hover:text-white" aria-label="View full size">
                <Maximize2 size={11} /> <span className="hidden sm:inline">Full size</span>
              </button>
            </div>
            <button type="button" onClick={() => setZoom(true)} className="relative block aspect-[1440/900] w-full cursor-zoom-in" aria-label={`View the ${SHOTS[i].label} screenshot full size`}>
              {/* all four stay mounted (and loaded), so switching never shows an empty frame */}
              {SHOTS.map((sh, k) => (
                <motion.div key={sh.src} initial={false} animate={{ opacity: k === i ? 1 : 0, scale: k === i ? 1 : 1.03 }} transition={{ duration: 0.9 }} className="absolute inset-0" aria-hidden={k !== i}>
                  <Image src={sh.src} alt={`Omnia desktop app: ${sh.label}`} fill quality={90} loading="eager" sizes="(max-width: 1240px) 100vw, 1240px" className="object-contain" />
                </motion.div>
              ))}
            </button>
          </div>
          {/* reflection on the "floor" */}
          <div aria-hidden className="pointer-events-none relative mt-1 hidden h-[120px] overflow-hidden sm:block opacity-30 [mask-image:linear-gradient(to_bottom,black,transparent)]">
            <div className="relative aspect-[1440/900] w-full -scale-y-100 blur-[6px]">
              <Image src={SHOTS[i].src} alt="" fill sizes="1240px" className="object-cover object-bottom" />
            </div>
          </div>
        </motion.div>

        <div className="mx-auto mt-5 flex max-w-[900px] flex-wrap justify-center gap-1 sm:-mt-16 sm:gap-2">
          {SHOTS.map((s, k) => (
            <button
              key={s.src}
              onClick={() => setI(k)}
              className={`relative rounded-[12px] px-3 py-2 text-left text-[12px] sm:px-4 sm:text-[13px] transition-colors ${k === i ? "text-white" : "text-white/45 hover:text-white/80"}`}
            >
              {k === i && <motion.span layoutId="shot-pill" className="absolute inset-0 rounded-[12px] lg-glass" transition={{ type: "spring", stiffness: 380, damping: 32 }} />}
              <span className="relative font-medium">{s.label}</span>
            </button>
          ))}
        </div>
        <AnimatePresence mode="wait">
          <motion.p key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="mt-4 text-center text-[14px] text-white/45">
            {SHOTS[i].note}
          </motion.p>
        </AnimatePresence>
        <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-white/25 sm:hidden">Tap the window for full size · it&apos;s a PC app</p>
      </div>

      {/* full-size viewer: the real 1440×900 screenshot, pannable on phones */}
      <AnimatePresence>
        {zoom && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] flex flex-col bg-black/90 backdrop-blur-md"
            onClick={() => setZoom(false)}
            role="dialog"
            aria-label={`${SHOTS[i].label} screenshot`}
          >
            <div className="flex items-center justify-between px-4 py-3">
              <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/50">{SHOTS[i].label} · 1440 × 900</span>
              <button onClick={() => setZoom(false)} className="rounded-full p-2 text-white/70 hover:bg-white/10" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="no-scrollbar flex-1 overflow-auto px-4 pb-6 md:flex md:items-center md:justify-center" onClick={(e) => e.stopPropagation()}>
              {/* eslint-disable-next-line @next/next/no-img-element -- native resolution on purpose */}
              <img src={SHOTS[i].src} alt={`Omnia desktop app: ${SHOTS[i].label}`} width={1440} height={900} className="h-auto max-w-none rounded-[12px] md:max-h-full md:max-w-full md:object-contain" style={{ width: narrow ? 1100 : undefined }} />
            </div>
            {narrow && <p className="pb-5 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-white/35">Swipe to pan · tap outside to close</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
