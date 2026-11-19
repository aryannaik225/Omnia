"use client";

import { AnimatePresence, motion, useInView } from "framer-motion";
import { ChevronLeft, Pause, Play, SkipForward } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { drawScene, type SceneId } from "./filmScenes";
import { Heading, Lede, Reel } from "./ui";

type Log = { id: number; ev: string; detail: string; tone: string };

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
};

const SERIES = "The Long Signal";
const EPISODES: Array<{ title: string; scene: SceneId; subs: string[] }> = [
  { title: "Dunes of Ashar", scene: 0, subs: ["— How far to the relay?", "— Two days, if the wind is kind.", "— And if it isn't?", "— Then we walk at night."] },
  { title: "Low Tide", scene: 1, subs: ["— You hear that?", "— It's coming from the lighthouse.", "— Nobody's lived there in thirty years.", "— Then who keeps turning the light on?"] },
  { title: "Ghost Frequency", scene: 2, subs: ["— She said meet her under the red sign.", "— Every sign in this city is red.", "— Then we check every one.", "— Bring an umbrella."] },
  { title: "Northern Lights", scene: 3, subs: ["— Make a wish.", "— It's not a shooting star.", "— It's better than one.", "— Then I get two wishes."] },
];
const DURATION = 52 * 60;

/** The "film" in the player: a procedurally painted, continuously animated scene. */
function FilmCanvas({ scene, running }: { scene: SceneId; running: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const clock = useRef(0);
  const size = useRef({ w: 0, h: 0 });
  useEffect(() => {
    clock.current = 6; // every episode opens a few seconds in
  }, [scene]);
  useEffect(() => {
    const c = ref.current!;
    const g = c.getContext("2d")!;
    const fit = () => {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      size.current = { w: c.width, h: c.height };
      drawScene(g, scene, c.width, c.height, clock.current);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      clock.current += dt;
      drawScene(g, scene, size.current.w, size.current.h, clock.current);
      raf = requestAnimationFrame(loop);
    };
    if (running) raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [scene, running]);
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" aria-hidden />;
}

/** A still frame of an episode, for the episode strip. */
function Thumb({ scene }: { scene: SceneId }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    c.width = 320;
    c.height = 180;
    drawScene(c.getContext("2d")!, scene, 320, 180, 14);
  }, [scene]);
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" aria-hidden />;
}

export function SmartPlayer() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-100px" });
  const [playing, setPlaying] = useState(true);
  const [t, setT] = useState(24 * 60 + 13);
  const [ep, setEp] = useState(0);
  const [watched, setWatched] = useState(0);
  const [pill, setPill] = useState(false);
  const [hub, setHub] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const nextId = useRef(0);
  const pillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const log = useCallback((ev: string, detail: string, tone = "text-white/70") => {
    setLogs((l) => [{ id: nextId.current++, ev, detail, tone }, ...l].slice(0, 9));
  }, []);

  // playback clock + 3-second telemetry sync
  useEffect(() => {
    if (!inView || !playing || hub) return;
    const id = setInterval(() => {
      setT((v) => Math.min(DURATION, v + 1));
      setWatched((w) => w + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [inView, playing, hub]);
  const live = useRef({ t, ep });
  live.current = { t, ep };
  useEffect(() => {
    if (!inView || !playing || hub) return;
    const id = setInterval(() => log("sync_playback_telemetry", `{ ep: ${live.current.ep + 1}, currentTime: ${fmt(live.current.t)}, paused: false }`, "text-[#64d2ff]"), 3000);
    return () => clearInterval(id);
  }, [inView, playing, hub, log]);

  const toggle = () => {
    log(playing ? "pause" : "playing", playing ? "active watch time frozen" : "resumed", playing ? "text-[#ffd60a]" : "text-[#30d158]");
    setPlaying(!playing);
  };
  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const to = Math.round(((e.clientX - r.left) / r.width) * DURATION);
    log(to > t ? "seeked ⏩" : "seeked ⏪", `${fmt(t)} → ${fmt(to)}  (${to > t ? "+" : "−"}${fmt(Math.abs(to - t))})`, "text-[#bf5af2]");
    setT(to);
  };
  const nextEp = () => {
    log("episode_complete", `S1 E${ep + 1} “${EPISODES[ep].title}” marked watched`, "text-[#30d158]");
    const n = (ep + 1) % EPISODES.length;
    setEp(n);
    setT(0);
    log("title_hop", `URL + DOM changed → now tracking S1 E${n + 1} “${EPISODES[n].title}”`, "text-[#ff9f0a]");
  };
  const pickEp = (n: number) => {
    if (n === ep) return;
    log("title_hop", `episode picked in the OTT's own menu → S1 E${n + 1} “${EPISODES[n].title}”`, "text-[#ff9f0a]");
    log("sync_playback_telemetry", `{ ep: ${ep + 1}, currentTime: ${fmt(t)}, left_at: ${Math.round((t / DURATION) * 100)}% }`, "text-[#64d2ff]");
    setEp(n);
    setT(0);
    if (!playing) setPlaying(true);
  };
  const backToHub = useCallback(() => {
    setHub(true);
    log("back_to_hub", "final state flushed to SQLite · catalog restored at scroll position", "text-white");
    setTimeout(() => setHub(false), 2600);
  }, [log]);
  const wake = () => {
    setPill(true);
    if (pillTimer.current) clearTimeout(pillTimer.current);
    pillTimer.current = setTimeout(() => setPill(false), 2200);
  };

  // The real hotkey works here too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inView && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        backToHub();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inView, backToHub]);

  const created = useRef(false);
  useEffect(() => {
    if (created.current) return;
    created.current = true;
    log("player_window_created", "WebView2 · per-profile data dir · telemetry_injector.js attached", "text-white/50");
  }, [log]);

  const subs = EPISODES[ep].subs;
  const sub = subs[Math.floor(t / 6) % subs.length];

  return (
    <section id="player" className="relative overflow-hidden bg-black px-4 py-32 sm:px-8">
      <div className="pointer-events-none absolute left-1/2 top-1/3 h-[700px] w-[1100px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(255,159,10,0.10),transparent_65%)]" />
      <div className="relative mx-auto max-w-[1180px]">
        <Reel n={4} label="The smart player" />
        <div className="mt-5 grid gap-6 lg:grid-cols-[1.25fr_1fr] lg:items-end">
          <Heading>
            A player that <span className="italic text-white/55">keeps the receipts.</span>
          </Heading>
          <Lede>
            Hit play and Omnia opens the title in a chromeless native WebView2 window, not a browser full of tabs. A tiny invisible observer watches the video element: real watch time, pauses, scrubs, even when you skip to the next episode inside Netflix.
          </Lede>
        </div>

        <div ref={ref} className="mt-14 grid gap-4 lg:grid-cols-[1.55fr_1fr]">
          {/* player window */}
          <div className="overflow-hidden rounded-[22px] border border-white/10 bg-[#050506] shadow-[0_50px_120px_-30px_rgba(0,0,0,0.9)]" onPointerMove={wake}>
            <div className="relative aspect-video overflow-hidden">
              <motion.div
                animate={{ scale: hub ? 0.6 : 1, opacity: hub ? 0 : 1, borderRadius: hub ? 40 : 0 }}
                transition={{ duration: 0.7, ease: [0.2, 0.7, 0.2, 1] }}
                className="absolute inset-0 overflow-hidden"
              >
                {/* the "film": a painted, living scene per episode */}
                <AnimatePresence initial={false}>
                  <motion.div key={ep} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.8 }} className="absolute inset-0">
                    <FilmCanvas scene={EPISODES[ep].scene} running={inView && playing && !hub} />
                  </motion.div>
                </AnimatePresence>
                {/* 2.39:1 letterbox */}
                <div className="absolute inset-x-0 top-0 h-[12%] bg-black" />
                <div className="absolute inset-x-0 bottom-0 h-[12%] bg-black" />
                <AnimatePresence mode="wait">
                  <motion.p
                    key={`${ep}-${sub}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                    className="absolute inset-x-0 bottom-[15%] px-6 text-center font-grotesk text-[clamp(12px,1.6vw,18px)] font-medium text-white [text-shadow:0_2px_6px_#000]"
                  >
                    {sub}
                  </motion.p>
                </AnimatePresence>
                <AnimatePresence>
                  {t < 5 && (
                    <motion.div key={`title-${ep}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.9 }} className="absolute left-[6%] top-[17%]">
                      <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-white/70">{SERIES} · Episode {ep + 1}</p>
                      <p className="mt-1 font-display text-[clamp(20px,3vw,38px)] italic text-white [text-shadow:0_2px_20px_rgba(0,0,0,0.6)]">{EPISODES[ep].title}</p>
                    </motion.div>
                  )}
                </AnimatePresence>
                {!playing && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <Play size={54} className="text-white/80" fill="currentColor" />
                  </div>
                )}
              </motion.div>

              {/* back to hub pill */}
              <AnimatePresence>
                {(pill || !playing) && !hub && (
                  <motion.button
                    initial={{ opacity: 0, y: -8, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8 }}
                    onClick={backToHub}
                    className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-[12px] px-3 py-2 text-[13px] font-semibold text-white lg-glass"
                  >
                    <ChevronLeft size={16} /> Back to Hub
                  </motion.button>
                )}
              </AnimatePresence>
              <AnimatePresence>
                {hub && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
                    <span className="font-display text-[clamp(26px,3.6vw,44px)] italic text-white">Back in the hub.</span>
                    <span className="font-mono text-[12px] text-white/50">Continue Watching updated · S1 E{ep + 1} at {fmt(t)}</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* controls */}
            <div className="flex items-center gap-3 border-t border-white/[0.06] px-4 py-3">
              <button onClick={toggle} aria-label={playing ? "Pause" : "Play"} className="rounded-[10px] p-2 text-white hover:bg-white/10">
                {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              </button>
              <div className="group relative h-6 flex-1 cursor-pointer" onPointerDown={seek} role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={DURATION} aria-valuenow={t}>
                <div className="absolute inset-x-0 top-1/2 h-[4px] -translate-y-1/2 rounded-full bg-white/15 transition-[height] group-hover:h-[6px]">
                  <div className="h-full rounded-full bg-white" style={{ width: `${(t / DURATION) * 100}%` }} />
                </div>
              </div>
              <span className="whitespace-nowrap text-right font-mono text-[12px] text-white/60">
                {fmt(t)} / {fmt(DURATION)}
              </span>
              <button onClick={nextEp} className="flex items-center gap-1 rounded-[10px] px-2.5 py-1.5 text-[12px] font-semibold text-white/80 hover:bg-white/10">
                <SkipForward size={14} /> Next ep
              </button>
            </div>
            <div className="flex items-center justify-between border-t border-white/[0.06] px-4 py-2.5 text-[12px] text-white/45">
              <span className="truncate">
                {SERIES} · S1 E{ep + 1} — <span className="text-white/75">{EPISODES[ep].title}</span>
              </span>
              <span className="hidden gap-1.5 sm:flex">
                <kbd className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">Alt</kbd>+<kbd className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">Space</kbd>
                <span className="mx-1 text-white/25">or</span>
                <kbd className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">Ctrl</kbd>+<kbd className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">Shift</kbd>+
                <kbd className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">H</kbd>
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2 border-t border-white/[0.06] p-3">
              {EPISODES.map((e, i) => (
                <button
                  key={e.title}
                  onClick={() => pickEp(i)}
                  aria-label={`Play episode ${i + 1}: ${e.title}`}
                  aria-current={i === ep}
                  className={`group text-left transition-opacity ${i === ep ? "opacity-100" : "opacity-60 hover:opacity-100"}`}
                >
                  <span className={`relative block aspect-video overflow-hidden rounded-[8px] ring-1 transition ${i === ep ? "ring-white/70" : "ring-white/10 group-hover:ring-white/30"}`}>
                    <Thumb scene={e.scene} />
                    {i === ep && (
                      <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
                        <span className="block h-full bg-white" style={{ width: `${(t / DURATION) * 100}%` }} />
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-white/70">
                    <span className="font-mono text-white/40">E{i + 1}</span> {e.title}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* telemetry console */}
          <div className="flex flex-col overflow-hidden rounded-[22px] lg-glass">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
              <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/50">telemetry_injector.js</span>
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-white/50">
                <span className={`h-1.5 w-1.5 rounded-full ${playing && !hub ? "animate-pulse bg-[#30d158]" : "bg-[#ffd60a]"}`} />
                {playing && !hub ? "tracking" : "paused"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-px border-b border-white/[0.06] bg-white/[0.06]">
              <Stat label="Active watch time" value={fmt(watched)} />
              <Stat label="Completion" value={`${Math.round((t / DURATION) * 100)}%`} />
            </div>
            {/* Fixed height when stacked (phones/tablets) so new lines never push the page down; beside the player it fills the row. */}
            <ul className="relative h-[260px] flex-none space-y-1.5 overflow-hidden p-4 font-mono text-[11.5px] leading-snug lg:h-auto lg:min-h-[260px] lg:flex-1">
              <AnimatePresence initial={false}>
                {logs.map((l) => (
                  <motion.li key={l.id} layout initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="break-words">
                    <span className={l.tone}>{l.ev}</span> <span className="text-white/40">{l.detail}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[rgba(18,18,22,0.9)] to-transparent" />
            </ul>
            <p className="border-t border-white/[0.06] px-4 py-3 text-[12px] text-white/40">Try it: pause, scrub the bar, pick another episode, or press Ctrl + Shift + H.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[rgba(18,18,22,0.9)] px-4 py-3">
      <p className="text-[11px] text-white/40">{label}</p>
      <p className="mt-0.5 font-mono text-[20px] text-white">{value}</p>
    </div>
  );
}
