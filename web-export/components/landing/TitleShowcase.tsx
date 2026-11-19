"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Heart, Play, Plus } from "lucide-react";
import { useState } from "react";
import type { Spotlight } from "@/lib/landing";
import { Heading, Lede, PROVIDERS, Reel, Statuette, TiltCard, type ProviderKey } from "./ui";

const WATCH: Array<{ k: ProviderKey; kind: string }> = [
  { k: "prime", kind: "Included with your plan" },
  { k: "apple", kind: "Rent · 4K HDR" },
  { k: "netflix", kind: "Not in your region" },
];

// A fictional series, so the episode list can be as long as the demo needs.
const SEASONS: Record<number, Array<{ t: string; m: number; p: number }>> = {
  1: [
    { t: "The Signal", m: 52, p: 1 },
    { t: "Low Tide", m: 48, p: 1 },
    { t: "Ghost Frequency", m: 55, p: 1 },
    { t: "Northern Lights", m: 51, p: 1 },
    { t: "Keeper's Log", m: 49, p: 1 },
    { t: "Breakwater", m: 47, p: 0.64 },
    { t: "The Fog Bell", m: 53, p: 0 },
    { t: "Undertow", m: 50, p: 0 },
    { t: "Lamp Room", m: 46, p: 0 },
    { t: "Salt and Iron", m: 58, p: 0 },
    { t: "Saint Elmo's Fire", m: 54, p: 0 },
    { t: "The Last Light", m: 67, p: 0 },
  ],
  2: [
    { t: "Return to Harrow Point", m: 56, p: 0 },
    { t: "Riptide", m: 49, p: 0 },
    { t: "Dead Reckoning", m: 51, p: 0 },
    { t: "Fathom", m: 47, p: 0 },
  ],
};

function EpisodeList() {
  const [season, setSeason] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const eps = SEASONS[season];
  const collapsible = eps.length >= 10;
  const shown = collapsible && !expanded ? eps.slice(0, 5) : eps;
  return (
    <div>
      <div className="flex items-center justify-between">
        <h4 className="text-[17px] font-semibold text-white">Harrow Point</h4>
        <div className="flex rounded-[12px] bg-white/[0.07] p-1 text-[12px] font-semibold">
          {[1, 2].map((s) => (
            <button
              key={s}
              onClick={() => {
                setSeason(s);
                setExpanded(false);
              }}
              className="relative rounded-[9px] px-3 py-1.5"
            >
              {season === s && <motion.span layoutId="season" className="absolute inset-0 rounded-[9px] bg-white/20" />}
              <span className="relative">Season {s}</span>
            </button>
          ))}
        </div>
      </div>
      <motion.ul layout className="mt-4 space-y-1.5">
        <AnimatePresence initial={false}>
          {shown.map((e, i) => (
            <motion.li
              key={`${season}-${e.t}`}
              layout
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3, delay: expanded ? Math.max(0, i - 5) * 0.03 : 0 }}
              className="overflow-hidden"
            >
              <div className="group flex items-center gap-3 rounded-[12px] px-3 py-2 transition-colors hover:bg-white/[0.06]">
                <span className="w-5 font-mono text-[12px] text-white/35">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[14px] text-white/90">{e.t}</span>
                    <span className="shrink-0 font-mono text-[11px] text-white/35">{e.m}m</span>
                  </div>
                  <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-white/10">
                    <div className={`h-full rounded-full ${e.p === 1 ? "bg-white/45" : "bg-white"}`} style={{ width: `${e.p * 100}%` }} />
                  </div>
                </div>
                <Play size={14} className="text-white/0 transition-colors group-hover:text-white/80" fill="currentColor" />
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </motion.ul>
      {collapsible && (
        <motion.button layout onClick={() => setExpanded((v) => !v)} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[12px] py-2.5 text-[13px] font-semibold text-white/80 lg-glass-soft hover:text-white">
          {expanded ? "Show less" : `Show all ${eps.length} episodes`}
          <motion.span animate={{ rotate: expanded ? 180 : 0 }}>
            <ChevronDown size={15} />
          </motion.span>
        </motion.button>
      )}
    </div>
  );
}

export function TitleShowcase({ spotlight }: { spotlight: Spotlight }) {
  const [provider, setProvider] = useState(0);
  const [loved, setLoved] = useState(false);
  const w = WATCH[provider];
  return (
    <section id="details" className="relative bg-black px-4 py-32 sm:px-8">
      <div className="mx-auto max-w-[1180px]">
        <Reel n={5} label="The title page" />
        <div className="mt-5 grid gap-6 lg:grid-cols-[1.25fr_1fr] lg:items-end">
          <Heading>
            And the award <span className="italic text-foil">goes to…</span>
          </Heading>
          <Lede>
            Every movie page knows its history. Best Picture winners wear shimmering gold, other Oscar winners get a gold-trimmed badge, and long seasons fold neatly away until you want them.
          </Lede>
        </div>

        <div className="mt-14 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <TiltCard className="min-h-[520px]" max={5}>
            <div className="absolute inset-0">
              {spotlight.backdrop ? (
                // eslint-disable-next-line @next/next/no-img-element -- optimizer URL
                <img src={spotlight.backdrop} alt="" className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <div className="h-full w-full bg-[radial-gradient(80%_70%_at_70%_30%,#3a4a2a_0%,#1a1d12_45%,#050505_100%)]" />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-[#0b0b0f] via-[#0b0b0f]/60 to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-r from-[#0b0b0f]/90 via-[#0b0b0f]/30 to-transparent" />
            </div>
            <div className="relative z-10 flex h-full min-h-[520px] flex-col justify-end p-7 sm:p-9">
              <motion.span initial={{ opacity: 0, y: 10, scale: 0.9 }} whileInView={{ opacity: 1, y: 0, scale: 1 }} viewport={{ once: true }} transition={{ delay: 0.3, type: "spring" }} className="oscar-badge oscar-badge-gold w-fit">
                <Statuette />
                Oscar Best Picture {spotlight.year}
              </motion.span>
              <AnimatePresence mode="wait">
                <motion.p key={provider} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-4 text-[12px] font-semibold uppercase tracking-[0.14em] text-white/60">
                  {w.kind === "Not in your region" ? "Available elsewhere" : `${w.kind.split(" · ")[0]} on ${PROVIDERS[w.k].name}`}
                </motion.p>
              </AnimatePresence>
              <h3 className="mt-1 text-[clamp(36px,5vw,58px)] font-bold leading-none tracking-tight text-white">{spotlight.title}</h3>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-white/70">
                <span className="rounded-md border border-white/25 px-1.5 text-[11px] font-semibold">A</span>
                <span className="flex items-center gap-1.5 rounded-md border border-white/15 px-1.5 py-0.5 text-[11px] font-bold text-[#7fd4c1]">
                  TMDB <span className="h-1.5 w-8 rounded-full bg-gradient-to-r from-[#90cea1] to-[#01b4e4]" /> <span className="text-white">8.5</span>
                </span>
                <span>{spotlight.year}</span>
                <span>2h 12m</span>
                <span>Comedy · Thriller · Drama</span>
              </div>
              <div className="mt-6 flex flex-wrap gap-2.5">
                <button className="flex items-center gap-2 rounded-[12px] bg-white px-5 py-2.5 text-[14px] font-semibold text-black transition-transform hover:scale-[1.03]">
                  <Play size={15} fill="currentColor" /> Play on {PROVIDERS[w.k].name}
                </button>
                <button className="flex items-center gap-2 rounded-[12px] px-4 py-2.5 text-[14px] font-semibold text-white lg-glass">
                  <Plus size={15} /> Up Next
                </button>
                <button onClick={() => setLoved((v) => !v)} className="flex items-center gap-2 rounded-[12px] px-4 py-2.5 text-[14px] font-semibold text-white lg-glass" aria-pressed={loved}>
                  <motion.span animate={loved ? { scale: [1, 1.4, 1] } : { scale: 1 }}>
                    <Heart size={15} className={loved ? "text-[#ff375f]" : ""} fill={loved ? "currentColor" : "none"} />
                  </motion.span>
                  Love
                </button>
              </div>
              <div className="mt-6">
                <p className="text-[13px] font-semibold text-white/80">Where to watch</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {WATCH.map((x, i) => (
                    <button
                      key={x.k}
                      onClick={() => setProvider(i)}
                      className={`flex items-center gap-2 rounded-[12px] px-3 py-2 text-left transition-all ${i === provider ? "bg-white/[0.16] ring-1 ring-white/40" : "bg-white/[0.06] hover:bg-white/[0.1]"}`}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ background: PROVIDERS[x.k].color }} />
                      <span className="text-[13px] font-semibold text-white">{PROVIDERS[x.k].name}</span>
                      <span className="text-[11px] text-white/45">{x.kind}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </TiltCard>

          <div className="flex flex-col gap-4">
            <div className="rounded-[24px] p-6 lg-glass">
              <EpisodeList />
            </div>
            <div className="rounded-[24px] p-5 lg-glass-soft">
              <p className="text-[13px] font-semibold text-white/80">Two badges, one rule</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="oscar-badge oscar-badge-gold">
                  <Statuette /> Oscar Best Picture
                </span>
                <span className="oscar-badge">
                  <Statuette /> Oscar Winner
                </span>
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-white/45">Built from Academy Award data mapped to TMDB ids, bundled with the app. No lookups, no network.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
