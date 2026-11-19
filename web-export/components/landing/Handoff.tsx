"use client";

import { AnimatePresence, motion, useInView } from "framer-motion";
import { Check, ChevronLeft, ChevronRight, Globe, Home, Monitor, Play, PlayCircle, Plus, RefreshCw, Search, Smartphone, Tv, Wifi } from "lucide-react";
import qrcode from "qrcode-generator";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Catalog, CatalogKey, ShowPoster } from "@/lib/landing";
import { Heading, Lede, PosterArt, Reel } from "./ui";

const PIN_TTL = 600;
const newPin = () => String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, "$1 $2");

/**
 * The QR on this page is not a pairing code. Scan it. (A different classic every time the PIN rotates.)
 */
const PRANKS = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ", // Never Gonna Give You Up
  "https://www.youtube.com/watch?v=QH2-TGUlwu4", // Nyan Cat
  "https://www.youtube.com/watch?v=J---aiyznGQ", // Keyboard Cat
  "https://www.youtube.com/watch?v=y6120QOlsfU", // Darude - Sandstorm
];

/** Same QR rendering as the desktop app's Settings → Linked Devices: dark modules on white, 4-module quiet zone. */
function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { d, n };
  }, [text]);
  const pad = 4;
  return (
    <svg width={size} height={size} viewBox={`${-pad} ${-pad} ${path.n + pad * 2} ${path.n + pad * 2}`} className="rounded-[12px] bg-white" role="img" aria-label="Pairing QR code" shapeRendering="crispEdges">
      <path d={path.d} fill="#000" />
    </svg>
  );
}

/* ───────────── the screen being driven ───────────── */

const SHELF: Array<{ k: CatalogKey; on: string }> = [
  { k: "stranger-things", on: "Netflix" },
  { k: "severance", on: "Apple TV+" },
  { k: "the-last-of-us", on: "HBO Max" },
  { k: "the-boys", on: "Prime Video" },
  { k: "andor", on: "Disney+" },
  { k: "wednesday", on: "Netflix" },
  { k: "house-of-the-dragon", on: "HBO Max" },
  { k: "the-bear", on: "Hulu" },
];
const COLS = 4;

type Target = "pc" | "tv";
type Key = "up" | "down" | "left" | "right" | "ok" | "back" | "home" | "playpause";
type Screen = { focus: number; playing: null | number; paused: boolean; pos: number; toast: string | null };

function TheScreen({ catalog, target, s, paired }: { catalog: Catalog; target: Target; s: Screen; paired: boolean }) {
  const now = s.playing !== null ? SHELF[s.playing] : null;
  const p = now ? catalog[now.k] : null;
  const fmt = (x: number) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
  return (
    <div className="relative aspect-video overflow-hidden rounded-[8px] bg-[#07070a]">
      {/* Omnia's hub */}
      <div className="absolute inset-0 flex">
        <div className="m-[2%] flex w-[6%] flex-col items-center gap-[7%] rounded-[8px] bg-white/[0.06] py-[3%]">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className={`h-[5px] w-[5px] rounded-full ${i === 1 ? "bg-white/80" : "bg-white/25"}`} />
          ))}
        </div>
        <div className="min-w-0 flex-1 py-[2.5%] pr-[2.5%]">
          <div className="flex items-center justify-between">
            <span className="text-[clamp(8px,1.4vw,12px)] font-semibold text-white">Continue Watching</span>
            <span className="rounded-full bg-white/10 px-1.5 text-[clamp(6px,0.9vw,8px)] text-white/60">{target === "pc" ? "🖥️ Living-room PC" : "📺 Omnia TV"}</span>
          </div>
          <div className="mt-[3%] grid grid-cols-4 gap-[3%]">
            {SHELF.map((it, i) => {
              const focused = paired && s.focus === i;
              const t = catalog[it.k];
              return (
                <motion.div
                  key={it.k}
                  animate={{ scale: focused ? 1.08 : 1, zIndex: focused ? 2 : 1 }}
                  transition={{ type: "spring", stiffness: 420, damping: 28 }}
                  className={`relative aspect-video overflow-hidden rounded-[5px] ${focused ? "ring-2 ring-white shadow-[0_8px_24px_rgba(0,0,0,0.6)]" : "opacity-80"}`}
                >
                  <PosterArt p={{ ...t, poster: t.backdrop ?? t.poster }} className="absolute inset-0" />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent" />
                  <span className="absolute bottom-[6%] left-[6%] right-[6%] truncate text-[clamp(5px,0.85vw,8px)] font-semibold text-white">{t.title}</span>
                </motion.div>
              );
            })}
          </div>
          <p className="mt-[3%] truncate text-[clamp(6px,1vw,9px)] text-white/45">
            {paired ? (
              <>
                Focused: <span className="text-white/80">{catalog[SHELF[s.focus].k].title}</span> · {SHELF[s.focus].on}
              </>
            ) : (
              "Pair a phone to drive this screen"
            )}
          </p>
        </div>
      </div>

      {/* playing: Omnia's player on the PC, or the OTT app on the TV */}
      <AnimatePresence>
        {p && now && (
          <motion.div key="play" initial={{ opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.45 }} className="absolute inset-0 z-10 bg-black">
            <PosterArt p={{ ...p, poster: p.backdrop ?? p.poster }} className={`absolute inset-0 transition-[filter] duration-500 ${s.paused ? "brightness-50" : ""}`} />
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-black/40" />
            <span className="absolute left-[3%] top-[4%] rounded-[6px] px-1.5 py-0.5 text-[clamp(6px,1vw,9px)] font-semibold text-white lg-glass">
              {target === "pc" ? "‹ Back to Hub" : `${now.on} app`}
            </span>
            {s.paused && (
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="flex h-[18%] w-[10%] items-center justify-center rounded-full bg-black/40">
                  <Play className="h-1/2 w-1/2 text-white" fill="currentColor" />
                </span>
              </span>
            )}
            <div className="absolute inset-x-[4%] bottom-[6%]">
              <p className="truncate text-[clamp(8px,1.5vw,13px)] font-bold text-white">{p.title}</p>
              <p className="text-[clamp(6px,0.9vw,8px)] text-white/60">{target === "pc" ? `Playing in Omnia's player · ${now.on}` : `Handed to the ${now.on} app on Android TV`}</p>
              <div className="mt-[2%] flex items-center gap-1.5">
                <div className="h-[3px] flex-1 rounded-full bg-white/25">
                  <div className="h-full rounded-full bg-white transition-[width] duration-300" style={{ width: `${(s.pos / 3120) * 100}%` }} />
                </div>
                <span className="font-mono text-[clamp(5px,0.8vw,8px)] text-white/60">{fmt(s.pos)}</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {s.toast && (
          <motion.span
            key={s.toast + s.pos}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="absolute right-[4%] top-[4%] z-20 rounded-full bg-white/90 px-2 py-0.5 font-mono text-[clamp(6px,1vw,9px)] font-semibold text-black"
          >
            {s.toast}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ───────────── the phone (the real LAN companion UI) ───────────── */

function TabBar({ tab, setTab, hint }: { tab: "home" | "remote"; setTab: (t: "home" | "remote") => void; hint: boolean }) {
  const items = [
    { id: "home", label: "Home", icon: <Home size={13} /> },
    { id: "search", label: "Search", icon: <Search size={13} /> },
    { id: "continue", label: "Watching", icon: <PlayCircle size={13} /> },
    { id: "remote", label: "Remote", icon: <RemoteGlyph /> },
    { id: "more", label: "More", icon: <span className="text-[12px] leading-none tracking-[1px]">•••</span> },
  ] as const;
  return (
    <div className="absolute inset-x-2 bottom-2 z-20">
      <AnimatePresence>
        {hint && (
          <motion.button
            type="button"
            onClick={() => setTab("remote")}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: [0, -3, 0] }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ y: { repeat: Infinity, duration: 1.6, ease: "easeInOut" }, opacity: { duration: 0.3, delay: 0.4 } }}
            className="absolute bottom-full right-[18%] mb-1.5 whitespace-nowrap rounded-full bg-[#64d2ff] px-2 py-[3px] text-[7px] font-bold text-black shadow-[0_4px_14px_rgba(100,210,255,0.6)]"
          >
            Try the remote ↓
          </motion.button>
        )}
      </AnimatePresence>
    <div className="flex gap-0.5 rounded-[14px] border border-white/10 bg-[rgba(30,30,36,0.72)] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-xl">
      {items.map((it) => {
        const active = (it.id === "home" && tab === "home") || (it.id === "remote" && tab === "remote");
        const clickable = it.id === "home" || it.id === "remote";
        return (
          <button
            key={it.id}
            onClick={() => clickable && setTab(it.id as "home" | "remote")}
            className={`relative flex min-w-0 flex-1 flex-col items-center gap-[1px] rounded-[10px] py-1 text-[6.5px] font-medium ${active ? "bg-white/[0.14] text-white" : it.id === "remote" && hint ? "text-[#9be4ff]" : "text-white/55"} ${clickable ? "" : "cursor-default"}`}
            tabIndex={clickable ? 0 : -1}
            aria-label={it.id === "remote" && hint ? "Remote: try it" : it.label}
          >
            {/* the cue: a breathing glow behind the Remote tab until it's opened */}
            {hint && it.id === "remote" && (
              <>
                <motion.span
                  aria-hidden
                  className="absolute inset-0 rounded-[10px] bg-[#64d2ff]/20 ring-1 ring-[#64d2ff]"
                  animate={{ opacity: [0.35, 1, 0.35], boxShadow: ["0 0 0px rgba(100,210,255,0)", "0 0 16px rgba(100,210,255,0.85)", "0 0 0px rgba(100,210,255,0)"] }}
                  transition={{ repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
                />
                <span aria-hidden className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#64d2ff] opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[#64d2ff]" />
                </span>
              </>
            )}
            <span className="relative">{it.icon}</span>
            <span className="relative">{it.label}</span>
          </button>
        );
      })}
    </div>
    </div>
  );
}

function RemoteGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="6" y="2.5" width="12" height="19" rx="6" />
      <circle cx="12" cy="9" r="2.2" />
      <path d="M12 4.8v.6M12 12.6v.6M8.4 9h.6M15 9h.6M10 16.5h4" />
    </svg>
  );
}

function PhoneHome({ hero, top }: { hero: ShowPoster; top: ShowPoster[] }) {
  return (
    <div className="no-scrollbar h-full overflow-hidden">
      <div className="relative h-[62%]">
        <PosterArt p={{ ...hero, poster: hero.backdrop ?? hero.poster }} className="absolute inset-0 [&>img]:object-[60%_center]" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black" />
        {/* glass search bar + region, as in the real phone layout */}
        <div className="absolute inset-x-2 top-7 flex items-center gap-1 rounded-[12px] border border-white/10 bg-[rgba(30,30,36,0.55)] p-1 backdrop-blur-md">
          <span className="flex flex-1 items-center gap-1 rounded-[9px] bg-black/30 px-1.5 py-1 text-[6.5px] text-white/50">
            <Search size={8} /> Movies, shows, people…
          </span>
          <span className="flex items-center gap-0.5 rounded-[9px] bg-white/10 px-1.5 py-1 text-[6.5px] font-semibold text-white">
            <Globe size={7} /> US
          </span>
        </div>
        <div className="absolute inset-x-2 bottom-1">
          <p className="text-[13px] font-bold leading-tight text-white">{hero.title}</p>
          <p className="mt-0.5 flex items-center gap-1 text-[6.5px] text-white/75">
            <span className="rounded-[2px] border border-white/40 px-[2px] font-semibold">{hero.cert}</span>
            <span className="rounded-[3px] border border-[#01b4e4]/60 px-[3px] font-bold text-[#90cea1]">TMDB</span>
            {hero.year} · Drama · Mystery
          </p>
          <div className="mt-1.5 flex gap-1">
            <span className="flex flex-1 items-center justify-center gap-0.5 rounded-[7px] bg-white py-1 text-[6.5px] font-semibold text-black">
              <Play size={6} fill="currentColor" /> Play Now
            </span>
            <span className="flex flex-1 items-center justify-center gap-0.5 rounded-[7px] border border-white/15 bg-white/10 py-1 text-[6.5px] font-semibold text-white">
              <Plus size={7} /> Up Next
            </span>
            <span className="flex flex-1 items-center justify-center rounded-[7px] border border-white/15 bg-white/10 py-1 text-[6.5px] font-semibold text-white">More Info</span>
          </div>
          <div className="mt-1.5 flex justify-end gap-[2px]">
            <span className="h-[3px] w-3 rounded-full bg-white" />
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-[3px] w-[3px] rounded-full bg-white/40" />
            ))}
          </div>
        </div>
      </div>
      <div className="px-2 pt-2">
        <p className="text-[9px] font-bold text-white">Top 10 Today</p>
        <p className="text-[6px] text-white/45">The movies and series everyone is watching …</p>
        <div className="mt-1.5 flex gap-1">
          {top.map((t, i) => (
            <div key={t.id} className="relative flex shrink-0 items-end">
              <span className="-mr-1.5 font-display text-[34px] font-bold leading-[0.8] text-transparent [-webkit-text-stroke:1px_rgba(255,255,255,0.35)]">{i + 1}</span>
              <PosterArt p={t} className="aspect-[2/3] w-[40px] rounded-[5px]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** `at` positions the key (a plain wrapper, since framer's tap transform would replace Tailwind's translate). */
function Pad({ children, onPress, className = "", at = "", label }: { children: ReactNode; onPress: () => void; className?: string; at?: string; label: string }) {
  const btn = (
    <motion.button
      type="button"
      aria-label={label}
      whileTap={{ scale: 0.9, backgroundColor: "rgba(255,255,255,0.24)" }}
      onClick={onPress}
      className={`flex select-none items-center justify-center rounded-full bg-white/[0.09] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] ${className}`}
    >
      {children}
    </motion.button>
  );
  return at ? <div className={at}>{btn}</div> : btn;
}

function PhoneRemote({ target, setTarget, press }: { target: Target; setTarget: (t: Target) => void; press: (k: Key) => void }) {
  return (
    <div className="flex h-full flex-col items-center px-2 pt-8">
      <p className="self-start text-[13px] font-bold text-white">Remote</p>
      <p className="self-start text-[6.5px] text-white/50">Control Omnia on your TV or PC</p>
      <div className="mt-2 flex gap-1" role="radiogroup" aria-label="Screen">
        {(["tv", "pc"] as const).map((t) => (
          <button
            key={t}
            role="radio"
            aria-checked={target === t}
            onClick={() => setTarget(t)}
            className={`rounded-full px-2 py-[3px] text-[6.5px] font-semibold ${target === t ? "bg-white text-black" : "bg-white/10 text-white/70"}`}
          >
            {t === "pc" ? "🖥️ Living-room PC" : "📺 Omnia TV"}
          </button>
        ))}
      </div>
      {/* D-pad, as in RemoteView */}
      <div className="relative mt-3 h-[118px] w-[118px] rounded-full bg-white/[0.05] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]">
        <Pad label="Up" onPress={() => press("up")} at="absolute left-1/2 top-1 -translate-x-1/2" className="h-[32px] w-[32px]">
          <ChevronLeft size={13} className="rotate-90" />
        </Pad>
        <Pad label="Down" onPress={() => press("down")} at="absolute bottom-1 left-1/2 -translate-x-1/2" className="h-[32px] w-[32px]">
          <ChevronLeft size={13} className="-rotate-90" />
        </Pad>
        <Pad label="Left" onPress={() => press("left")} at="absolute left-1 top-1/2 -translate-y-1/2" className="h-[32px] w-[32px]">
          <ChevronLeft size={13} />
        </Pad>
        <Pad label="Right" onPress={() => press("right")} at="absolute right-1 top-1/2 -translate-y-1/2" className="h-[32px] w-[32px]">
          <ChevronRight size={13} />
        </Pad>
        <Pad label="OK" onPress={() => press("ok")} at="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" className="h-[42px] w-[42px] !bg-white/[0.16] text-[9px] font-semibold">
          OK
        </Pad>
      </div>
      <div className="mt-3 grid w-full max-w-[136px] grid-cols-3 gap-1.5">
        <Pad label="Back" onPress={() => press("back")} className="h-6 text-[7px] font-medium">
          Back
        </Pad>
        <Pad label="Home" onPress={() => press("home")} className="h-6">
          <Home size={10} />
        </Pad>
        <Pad label="Play / Pause" onPress={() => press("playpause")} className="h-6 gap-[1px] text-[7px] font-semibold">
          <Play size={7} fill="currentColor" />❚❚
        </Pad>
      </div>
      <p className="mt-2 px-1 text-center text-[6px] leading-snug text-white/40">
        {target === "pc" ? "While a title plays: OK pauses / plays, ◀ ▶ skip 10 s, Back returns to the hub." : "Play hands the title to the Netflix / Prime app on the TV."}
      </p>
    </div>
  );
}

/* ───────────── section ───────────── */

type Stage = "idle" | "pairing" | "paired";

export function Handoff({ catalog }: { catalog: Catalog }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const [pin, setPin] = useState("482 913");
  const [prank, setPrank] = useState(0);
  const [left, setLeft] = useState(PIN_TTL);
  const [stage, setStage] = useState<Stage>("idle");
  const [typed, setTyped] = useState(0);
  const [tab, setTab] = useState<"home" | "remote">("home");
  const [target, setTarget] = useState<Target>("tv");
  const [screen, setScreen] = useState<Screen>({ focus: 0, playing: null, paused: false, pos: 0, toast: null });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // a random prank per visit (client-only, so the server HTML and hydration agree)
  useEffect(() => setPrank(Math.floor(Math.random() * PRANKS.length)), []);

  useEffect(() => {
    if (!inView) return;
    const id = setInterval(() => setLeft((v) => (v <= 1 ? PIN_TTL : v - 1)), 1000);
    return () => clearInterval(id);
  }, [inView]);
  const rotate = useCallback(() => {
    setPin(newPin());
    setPrank((v) => (v + 1 + Math.floor(Math.random() * (PRANKS.length - 1))) % PRANKS.length);
  }, []);
  useEffect(() => {
    if (left === PIN_TTL && stage === "idle") rotate();
  }, [left, stage, rotate]);

  // pairing: the phone "types" the PIN, then both devices light up
  useEffect(() => {
    if (stage !== "pairing") return;
    if (typed < 6) {
      const t = setTimeout(() => setTyped((v) => v + 1), 170);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStage("paired"), 500);
    return () => clearTimeout(t);
  }, [stage, typed]);

  // playback clock on the driven screen
  useEffect(() => {
    if (screen.playing === null || screen.paused || !inView) return;
    const id = setInterval(() => setScreen((s) => ({ ...s, pos: Math.min(3120, s.pos + 1) })), 1000);
    return () => clearInterval(id);
  }, [screen.playing, screen.paused, inView]);

  const pair = () => {
    if (stage === "paired") {
      setStage("idle");
      setTyped(0);
      setTab("home");
      setScreen({ focus: 0, playing: null, paused: false, pos: 0, toast: null });
      rotate(); // rotated after each pairing
      setLeft(PIN_TTL);
      return;
    }
    setTyped(0);
    setStage("pairing");
  };

  const toast = (msg: string) => {
    setScreen((s) => ({ ...s, toast: msg }));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setScreen((s) => ({ ...s, toast: null })), 900);
  };

  const press = (k: Key) => {
    navigator.vibrate?.(12);
    setScreen((s) => {
      const playing = s.playing !== null;
      if (playing) {
        if (k === "back" || k === "home") return { ...s, playing: null, paused: false };
        if ((k === "ok" && target === "pc") || k === "playpause") return { ...s, paused: !s.paused };
        if (target === "pc" && k === "left") return { ...s, pos: Math.max(0, s.pos - 10) };
        if (target === "pc" && k === "right") return { ...s, pos: Math.min(3120, s.pos + 10) };
        return s;
      }
      const n = SHELF.length;
      const f = s.focus;
      if (k === "left") return { ...s, focus: f % COLS === 0 ? f : f - 1 };
      if (k === "right") return { ...s, focus: f % COLS === COLS - 1 ? f : Math.min(n - 1, f + 1) };
      if (k === "up") return { ...s, focus: f - COLS >= 0 ? f - COLS : f };
      if (k === "down") return { ...s, focus: f + COLS < n ? f + COLS : f };
      if (k === "home") return { ...s, focus: 0 };
      if (k === "ok" || k === "playpause") return { ...s, playing: f, paused: false, pos: 600 + ((f * 437) % 1800) };
      return s;
    });
    if (screen.playing !== null && target === "pc" && (k === "left" || k === "right")) toast(k === "left" ? "−10 s" : "+10 s");
  };

  // arrow keys drive the screen too, while the remote is open
  useEffect(() => {
    if (stage !== "paired" || tab !== "remote" || !inView) return;
    const map: Record<string, Key> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "ok", Backspace: "back" };
    const onKey = (e: KeyboardEvent) => {
      const k = map[e.key];
      if (!k || (e.target as HTMLElement)?.closest("input,textarea")) return;
      e.preventDefault();
      press(k);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const digits = pin.replace(" ", "");
  const paired = stage === "paired";
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  const hero = catalog.severance;
  const top = [catalog["dune-part-two"], catalog["stranger-things"], catalog["the-last-of-us"]];

  return (
    <section id="devices" className="relative overflow-hidden bg-black px-4 py-32 sm:px-8">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[500px] bg-[radial-gradient(60%_60%_at_50%_100%,rgba(100,210,255,0.10),transparent_70%)]" />
      <div className="relative mx-auto max-w-[1180px]">
        <Reel n={8} label="Phone, TV & remote" />
        <div className="mt-5 grid gap-6 lg:grid-cols-[1.25fr_1fr] lg:items-end">
          <Heading>
            The remote your PC <span className="italic text-white/55">never came with.</span>
          </Heading>
          <Lede>
            TVs ship with a remote. PCs don&apos;t. Pair your phone once and it becomes one: browse on the phone, then drive the big screen with a D-pad from the bed or the bean bag. Pause, skip ten seconds, back to the hub, without getting up. Nothing to install on iPhone; Android TV gets a tiny app that hands Play to the real OTT app.
          </Lede>
        </div>

        <div ref={ref} className="mt-14 grid items-center gap-6 xl:grid-cols-[minmax(380px,0.95fr)_1.5fr]">
          {/* desktop settings panel */}
          <div className="rounded-[24px] p-6 lg-glass">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[12px] text-white/45">Settings</p>
                <h3 className="text-[19px] font-semibold text-white">Linked Devices</h3>
              </div>
              <span className="flex items-center gap-1.5 rounded-full bg-[#30d158]/15 px-2.5 py-1 text-[11px] font-semibold text-[#30d158]">
                <Wifi size={12} /> LAN server on
              </span>
            </div>
            <div className="mt-5 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
              <motion.div animate={paired ? { scale: [1, 0.96, 1] } : {}} className="relative shrink-0">
                <QrCode text={PRANKS[prank]} />
                <AnimatePresence>
                  {paired && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 flex items-center justify-center rounded-[12px] bg-black/70 backdrop-blur-sm">
                      <Check size={42} className="text-[#30d158]" />
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
              <div className="w-full">
                <p className="text-[13px] text-white/45">Pairing PIN</p>
                <div className="mt-1 flex gap-1 font-mono text-[32px] font-semibold tracking-[0.06em] text-white">
                  {digits.split("").map((d, i) => (
                    <AnimatePresence mode="popLayout" key={i}>
                      <motion.span key={`${d}-${i}-${pin}`} initial={{ y: -14, opacity: 0 }} animate={{ y: 0, opacity: 1, transition: { delay: i * 0.04 } }} className={i === 3 ? "ml-3" : ""}>
                        {d}
                      </motion.span>
                    </AnimatePresence>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2 text-[12px] text-white/45">
                  <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0 -rotate-90">
                    <circle cx="8" cy="8" r="6.5" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="2" />
                    <circle cx="8" cy="8" r="6.5" fill="none" stroke="#fff" strokeWidth="2" strokeDasharray={40.8} strokeDashoffset={40.8 * (1 - left / PIN_TTL)} strokeLinecap="round" />
                  </svg>
                  rotates in {mm}:{ss} · after each pairing · after 5 wrong guesses
                </div>
                <button onClick={pair} className="mt-4 flex items-center gap-2 whitespace-nowrap rounded-[12px] px-3.5 py-2 text-[13px] font-semibold text-white lg-glass-soft hover:bg-white/10">
                  {paired ? (
                    <>
                      <RefreshCw size={14} /> Unpair, new PIN
                    </>
                  ) : (
                    <>
                      <Smartphone size={14} /> Pair a phone (demo)
                    </>
                  )}
                </button>
              </div>
            </div>
            <ul className="mt-6 space-y-1.5 text-[12px] text-white/45">
              <li>• Only a SHA-256 of each device token is stored</li>
              <li>• Pairing page only for unknown devices; allow-listed commands for paired ones</li>
              <li>• Off by default. One switch to revoke everything</li>
            </ul>
          </div>

          {/* phone + the screen it drives */}
          <div className="relative flex flex-col items-center gap-8 sm:flex-row sm:items-end sm:justify-center">
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
              {paired &&
                [0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="absolute h-[280px] w-[280px] rounded-full border border-[#64d2ff]/30"
                    initial={{ scale: 0.3, opacity: 0.7 }}
                    animate={{ scale: 2.3, opacity: 0 }}
                    transition={{ repeat: Infinity, duration: 3.2, delay: i * 1.05, ease: "easeOut" }}
                  />
                ))}
            </div>

            {/* phone */}
            <div className="relative z-10 w-[210px] shrink-0">
              <div className="rounded-[36px] border border-white/15 bg-[#0b0b0f] p-[7px] shadow-[0_40px_80px_-20px_rgba(0,0,0,0.9)]">
                <div className="relative aspect-[9/19.5] overflow-hidden rounded-[30px] bg-black">
                  <div className="absolute left-1/2 top-2 z-30 h-[16px] w-[58px] -translate-x-1/2 rounded-full bg-black" />
                  <AnimatePresence mode="wait">
                    {!paired ? (
                      <motion.div key="pin" exit={{ opacity: 0 }} className="flex h-full flex-col items-center justify-center gap-3 px-4">
                        <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-white/10">
                          <Smartphone size={16} className="text-white/80" />
                        </span>
                        <span className="text-[12px] font-semibold text-white">Pair with Omnia</span>
                        <span className="text-center text-[8.5px] leading-snug text-white/45">Enter the PIN shown in Settings → Linked Devices on your PC</span>
                        <div className="grid grid-cols-6 gap-1">
                          {Array.from({ length: 6 }).map((_, i) => (
                            <span key={i} className={`flex h-7 w-5 items-center justify-center rounded-md font-mono text-[12px] ${i < typed ? "bg-white/20 text-white" : "bg-white/[0.07] text-transparent"}`}>
                              {digits[i]}
                            </span>
                          ))}
                        </div>
                        {stage === "pairing" && <span className="text-[8px] text-[#64d2ff]">Pairing…</span>}
                      </motion.div>
                    ) : (
                      <motion.div key="app" initial={{ opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} className="h-full">
                        <AnimatePresence mode="wait" initial={false}>
                          <motion.div key={tab} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="h-full">
                            {tab === "home" ? <PhoneHome hero={hero} top={top} /> : <PhoneRemote target={target} setTarget={setTarget} press={press} />}
                          </motion.div>
                        </AnimatePresence>
                        <TabBar tab={tab} setTab={setTab} hint={tab === "home"} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
              <p className={`mt-3 flex items-center justify-center gap-1.5 text-[12px] ${paired && tab !== "remote" ? "font-semibold text-[#64d2ff]" : "text-white/45"}`}>
                <Smartphone size={13} /> {paired ? (tab === "remote" ? "Your phone, now a remote" : "Paired! Now tap Remote") : "iPhone · Safari, no app"}
              </p>
            </div>

            {/* the screen: a PC monitor, or a TV */}
            <div className="relative z-10 w-full max-w-[460px] sm:w-[min(48vw,460px)]">
              <div className={`border border-white/10 bg-[#0b0b0f] p-2 shadow-[0_40px_100px_-20px_rgba(0,0,0,0.9)] ${target === "pc" ? "rounded-[14px]" : "rounded-[6px] p-1"}`}>
                <TheScreen catalog={catalog} target={target} s={screen} paired={paired} />
              </div>
              {target === "pc" ? (
                <>
                  <div className="mx-auto h-8 w-[16%] bg-gradient-to-b from-white/15 to-white/5" />
                  <div className="mx-auto h-2 w-[34%] rounded-t-[6px] bg-white/10" />
                </>
              ) : (
                <div className="mx-auto flex w-[70%] justify-between">
                  <span className="h-5 w-1.5 -skew-x-12 bg-white/15" />
                  <span className="h-5 w-1.5 skew-x-12 bg-white/15" />
                </div>
              )}
              <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-white/45">
                {target === "pc" ? <Monitor size={13} /> : <Tv size={13} />}
                {target === "pc" ? "Your PC · driven from the phone" : "Android TV · discovered over UDP"}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
