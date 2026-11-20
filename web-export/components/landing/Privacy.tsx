"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { Heading, Lede, Reel } from "./ui";

type ModId = "ui" | "player" | "core" | "db" | "onnx" | "lan";
type Mod = { id: ModId; x: number; y: number; w: number; h: number; title: string; sub: string; detail: string; rows?: string[] };

const MODS: Mod[] = [
  { id: "ui", x: 60, y: 92, w: 250, h: 92, title: "Omnia UI", sub: "React 19 · main window", detail: "The catalog, title pages and settings. It talks only to the Rust core over Tauri IPC: even TMDB is reached through the core, so no API key ever sits in the UI." },
  { id: "player", x: 450, y: 92, w: 250, h: 92, title: "Player window", sub: "WebView2 · per-profile data dir", detail: "Each Omnia profile gets its own isolated WebView2 folder. OTT cookies live there and are never read into the backend. An injected observer reports only playback time to the core." },
  { id: "core", x: 250, y: 236, w: 260, h: 104, title: "Rust core", sub: "Tauri 2 · tokio · reqwest", detail: "Resolves deep links, records telemetry, runs the recommender and owns the database. Its everyday traffic goes only to the hosts on the right; the few one-off and opt-in ones are listed below the drawing." },
  { id: "db", x: 60, y: 392, w: 240, h: 128, title: "SQLite", sub: "omnia.db · local app data", detail: "History, playback events, taste vectors, profiles and settings, all in one file on your disk. Delete the file and Omnia forgets you.", rows: ["watch_history", "playback_events", "media_embeddings", "title_vectors", "favorites · watchlist"] },
  { id: "onnx", x: 318, y: 392, w: 170, h: 104, title: "ONNX Runtime", sub: "MiniLM-L6 · int8", detail: "The sentence-embedding model runs on your CPU. Plots and keywords become 384-d vectors locally; nothing is sent out to be embedded." },
  { id: "lan", x: 506, y: 392, w: 212, h: 112, title: "LAN server", sub: "axum · port 8765", detail: "Off until you flip it on. Then it serves Omnia to paired phones and TVs on your Wi-Fi only: IP-literal hosts, PIN pairing, hashed device tokens." },
];

type Flow = "both" | "in" | "out";
/** Paths run from the first module to the second; `flow` says which way data actually moves. */
type Link = { id: string; from: ModId; d: string; flow: Flow; label?: string; lx?: number; ly?: number; dur: number };
const LINKS: Link[] = [
  { id: "ui-core", from: "ui", d: "M185 184 C185 214 290 206 310 236", flow: "both", label: "IPC ⇄", lx: 214, ly: 222, dur: 2.2 },
  // one-way: the player only ever reports playback time to the core
  { id: "player-core", from: "player", d: "M575 184 C575 214 470 206 450 236", flow: "out", label: "telemetry → · 3 s", lx: 528, ly: 222, dur: 2.6 },
  { id: "core-db", from: "core", d: "M300 340 C300 366 180 362 180 392", flow: "both", label: "read / write", lx: 222, ly: 372, dur: 1.8 },
  { id: "core-onnx", from: "core", d: "M403 340 L403 392", flow: "both", dur: 1.4 },
  { id: "core-lan", from: "core", d: "M480 340 C480 368 612 362 612 392", flow: "both", dur: 2.4 },
];

/**
 * The only hosts Omnia ever talks to. Two-way: a query goes out, data comes back. One-way (in):
 * nothing about you is sent, the request is an anonymous GET and only the payload moves.
 */
const ALLOWED: Array<{ label: string; sub: string; y: number; from: ModId; d: string; flow: Flow }> = [
  { label: "TMDB", sub: "search ⇄ metadata", y: 96, from: "core", d: "M510 262 C620 262 650 110 740 110 L800 110", flow: "both" },
  { label: "JustWatch", sub: "title ⇄ links", y: 156, from: "core", d: "M510 276 C630 276 660 170 740 170 L800 170", flow: "both" },
  { label: "Your OTT", sub: "sealed ⇄ stream", y: 216, from: "player", d: "M700 150 C730 150 720 230 740 230 L800 230", flow: "both" },
  { label: "GitHub", sub: "← signed update", y: 276, from: "core", d: "M510 292 C620 292 660 290 740 290 L800 290", flow: "in" },
  { label: "ipwho.is", sub: "← region, once", y: 336, from: "core", d: "M510 308 C620 308 660 350 740 350 L800 350", flow: "in" },
];
const BLOCKED = [
  { label: "Analytics", y: 412, d: "M510 320 C600 320 660 420 736 420" },
  { label: "Ad networks", y: 452, d: "M510 328 C590 328 650 460 736 460" },
  { label: "Crash reporters", y: 492, d: "M510 334 C580 334 640 500 736 500" },
];

const PROMISES = [
  { t: "Local-first, always", d: "History, embeddings, profiles and settings live in SQLite on your PC. Sync is opt-in and never carries telemetry or taste data." },
  { t: "Zero telemetry", d: "No analytics SDKs. No crash reporters phoning home. Nothing to opt out of." },
  { t: "Sessions stay sealed", d: "OTT sign-ins live in an isolated WebView2 profile per person. Cookies are never read into Omnia's backend." },
  { t: "Family-proof", d: "Each Omnia profile maps to its own Netflix or Prime profile, so one person's binge never shapes another's picks." },
];

const GREEN = "#30d158";
const RED = "#ff453a";

const OUT = GREEN; // requests leaving the PC
const IN = "#64d2ff"; // data arriving

function Packet({ d, dur, color, delay = 0, reverse = false, r = 2.6 }: { d: string; dur: number; color: string; delay?: number; reverse?: boolean; r?: number }) {
  return (
    <circle r={r} fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }}>
      <animateMotion dur={`${dur}s`} begin={`${delay}s`} repeatCount="indefinite" path={d} keyPoints={reverse ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear" />
    </circle>
  );
}

/** A blueprint of everything Omnia runs on your PC, and the only doors out of it. */
function Blueprint({ focus, setFocus }: { focus: ModId | null; setFocus: (m: ModId | null) => void }) {
  const lit = (m: ModId) => !focus || focus === m || LINKS.some((l) => l.id.includes(focus) && l.id.includes(m));
  const linkLit = (l: Link) => !focus || l.id.includes(focus);
  return (
    <svg viewBox="0 0 1000 560" className="h-auto w-full" role="img" aria-label="Omnia's local architecture: UI, player, Rust core, SQLite, ONNX and LAN server inside your PC; outbound calls only to TMDB, JustWatch, your OTT, GitHub and ipwho.is">
      <defs>
        <pattern id="bp-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="rgba(255,255,255,0.035)" strokeWidth="1" />
        </pattern>
        <linearGradient id="bp-edge" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="rgba(48,209,88,0.0)" />
          <stop offset="0.5" stopColor="rgba(48,209,88,0.5)" />
          <stop offset="1" stopColor="rgba(48,209,88,0.0)" />
        </linearGradient>
        <radialGradient id="bp-core" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="rgba(48,209,88,0.16)" />
          <stop offset="1" stopColor="rgba(48,209,88,0)" />
        </radialGradient>
      </defs>
      <rect width="1000" height="560" fill="url(#bp-grid)" />

      {/* the machine boundary */}
      <rect x="24" y="44" width="716" height="500" rx="26" fill="rgba(255,255,255,0.012)" stroke="rgba(255,255,255,0.16)" strokeWidth="1.2" />
      <rect x="30" y="50" width="704" height="488" rx="21" fill="none" stroke="rgba(255,255,255,0.05)" strokeDasharray="2 5" />
      {[
        [24, 44],
        [740, 44],
        [24, 544],
        [740, 544],
      ].map(([x, y], i) => (
        <path key={i} d={`M${x + (x < 400 ? 0 : -14)} ${y}h14M${x} ${y + (y < 300 ? 0 : -14)}v14`} stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" />
      ))}
      <text x="48" y="34" className="fill-white/60 font-mono" fontSize="11" letterSpacing="2.5">
        YOUR PC · WINDOWS 10 / 11 · EVERYTHING INSIDE THIS LINE STAYS HERE
      </text>
      {/* the network edge: a glowing seam on the right wall */}
      <rect x="738" y="70" width="4" height="450" fill="url(#bp-edge)" />
      <text x="760" y="34" className="fill-white/40 font-mono" fontSize="11" letterSpacing="2.5">
        THE INTERNET
      </text>
      <g transform="translate(790 540)" className="font-mono" fontSize="9.5">
        <circle cx="4" cy="-3" r="2.4" fill={OUT} />
        <text x="12" y="0" className="fill-white/45">out</text>
        <circle cx="48" cy="-3" r="3" fill={IN} />
        <text x="56" y="0" className="fill-white/45">in</text>
        <text x="82" y="0" className="fill-white/45">⇄ two-way ← one-way</text>
      </g>
      <ellipse cx="380" cy="288" rx="230" ry="110" fill="url(#bp-core)" />

      {/* internal links */}
      {LINKS.map((l) => (
        <g key={l.id} opacity={linkLit(l) ? 1 : 0.18} style={{ transition: "opacity .3s" }}>
          <path d={l.d} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="1.2" strokeDasharray="3 4">
            <animate attributeName="stroke-dashoffset" from="14" to="0" dur="1s" repeatCount="indefinite" />
          </path>
          {l.flow !== "in" && <Packet d={l.d} dur={l.dur} color="#c7ecff" />}
          {l.flow !== "out" && <Packet d={l.d} dur={l.dur} color="#64d2ff" delay={l.dur / 2} reverse />}
          {l.label && (
            <text x={l.lx} y={l.ly} textAnchor="middle" className="fill-white/45 font-mono" fontSize="10">
              {l.label}
            </text>
          )}
        </g>
      ))}

      {/* outbound: allowed */}
      {ALLOWED.map((a, i) => {
        const on = !focus || focus === a.from;
        return (
          <g key={a.label} opacity={on ? 1 : 0.2} style={{ transition: "opacity .3s" }}>
            <path d={a.d} fill="none" stroke={GREEN} strokeOpacity="0.45" strokeWidth="1.2" strokeDasharray={a.flow === "both" ? undefined : "5 3"} />
            {/* a small request out, a bigger payload back; one-way routes only carry the payload in */}
            {a.flow === "both" && <Packet d={a.d} dur={2.2 + i * 0.25} color={OUT} delay={i * 0.4} r={2} />}
            <Packet d={a.d} dur={2.2 + i * 0.25} color={IN} delay={i * 0.4 + 1.1} reverse r={3.2} />
            <text x="770" y={a.y + 2} textAnchor="middle" className="font-mono" fontSize="11" fill={a.flow === "both" ? GREEN : IN}>
              {a.flow === "both" ? "⇄" : "←"}
            </text>
            <rect x="740" y={a.y + 4} width="6" height="20" rx="2" fill={GREEN} opacity="0.8" />
            <g transform={`translate(800 ${a.y})`}>
              <rect width="186" height="28" rx="14" fill="rgba(48,209,88,0.1)" stroke="rgba(48,209,88,0.45)" />
              <text x="14" y="18" className="font-grotesk" fontSize="12.5" fontWeight="600" fill={GREEN}>
                ✓ {a.label}
              </text>
              <text x="176" y="18" textAnchor="end" className="fill-white/45 font-mono" fontSize="9.5">
                {a.sub}
              </text>
            </g>
          </g>
        );
      })}

      {/* outbound: blocked at the wall */}
      {BLOCKED.map((b) => (
        <g key={b.label} opacity={!focus || focus === "core" ? 1 : 0.2} style={{ transition: "opacity .3s" }}>
          <path d={b.d} fill="none" stroke={RED} strokeOpacity="0.35" strokeWidth="1.1" strokeDasharray="2 4" />
          <g transform={`translate(740 ${b.y + 8})`}>
            <circle r="9" fill="#120404" stroke={RED} strokeOpacity="0.8" />
            <path d="M-3.5 -3.5L3.5 3.5M3.5 -3.5L-3.5 3.5" stroke={RED} strokeWidth="1.6" strokeLinecap="round" />
          </g>
          <g transform={`translate(800 ${b.y - 6})`} opacity="0.75">
            <rect width="186" height="28" rx="14" fill="rgba(255,69,58,0.06)" stroke="rgba(255,69,58,0.3)" strokeDasharray="3 3" />
            <text x="14" y="18" className="font-grotesk" fontSize="12.5" fontWeight="600" fill={RED} textDecoration="line-through">
              {b.label}
            </text>
            <text x="176" y="18" textAnchor="end" className="fill-white/35 font-mono" fontSize="9.5">
              never
            </text>
          </g>
        </g>
      ))}

      {/* modules */}
      {MODS.map((m) => {
        const on = lit(m.id);
        const active = focus === m.id;
        return (
          <g
            key={m.id}
            transform={`translate(${m.x} ${m.y})`}
            opacity={on ? 1 : 0.3}
            style={{ transition: "opacity .3s", cursor: "pointer" }}
            onPointerEnter={() => setFocus(m.id)}
            onPointerLeave={() => setFocus(null)}
            onClick={() => setFocus(focus === m.id ? null : m.id)}
            tabIndex={0}
            onFocus={() => setFocus(m.id)}
            onBlur={() => setFocus(null)}
            role="button"
            aria-label={`${m.title}: ${m.detail}`}
          >
            <rect width={m.w} height={m.h} rx="14" fill={active ? "rgba(255,255,255,0.08)" : "rgba(14,14,18,0.92)"} stroke={active ? "rgba(255,255,255,0.55)" : m.id === "core" ? "rgba(48,209,88,0.5)" : "rgba(255,255,255,0.16)"} strokeWidth="1.2" />
            <line x1="14" x2={m.w - 14} y1="1" y2="1" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
            <circle cx={m.w - 18} cy="20" r="3.5" fill={m.id === "lan" ? "#ffd60a" : GREEN}>
              <animate attributeName="opacity" values="1;0.35;1" dur={m.id === "core" ? "1.2s" : "2.4s"} repeatCount="indefinite" />
            </circle>
            <text x="16" y="28" className="fill-white font-grotesk" fontSize="16" fontWeight="600">
              {m.title}
            </text>
            <text x="16" y="47" className="fill-white/45 font-mono" fontSize="10.5">
              {m.sub}
            </text>
            {m.rows?.map((r, i) => (
              <g key={r} transform={`translate(16 ${62 + i * 12.5})`}>
                <rect width="5" height="5" y="-5" rx="1" fill="rgba(100,210,255,0.6)" />
                <text x="11" y="0" className="fill-white/55 font-mono" fontSize="9.5">
                  {r}
                </text>
              </g>
            ))}
            {m.id === "player" && (
              <g transform={`translate(16 ${m.h - 22})`}>
                <rect width="136" height="16" rx="8" fill="rgba(255,214,10,0.12)" />
                <text x="9" y="11.5" className="font-mono" fontSize="9.5" fill="#ffd60a">
                  🔒 cookies sealed in
                </text>
              </g>
            )}
            {m.id === "core" && (
              <g transform={`translate(16 ${m.h - 26})`}>
                {["resolver", "telemetry", "recommender", "updater"].map((t, i) => (
                  <g key={t} transform={`translate(${i * 58} 0)`}>
                    <rect width="55" height="16" rx="5" fill="rgba(255,255,255,0.06)" />
                    <text x="27.5" y="11.5" textAnchor="middle" className="fill-white/60 font-mono" fontSize="7.8">
                      {t}
                    </text>
                  </g>
                ))}
              </g>
            )}
            {m.id === "onnx" && (
              <g transform={`translate(16 ${m.h - 30})`}>
                {Array.from({ length: 24 }).map((_, i) => (
                  <rect key={i} x={i * 6} y={0} width="4" height="18" rx="1" fill="#bf5af2" opacity={0.15 + ((i * 37) % 10) / 14}>
                    <animate attributeName="opacity" values={`${0.15 + ((i * 37) % 10) / 14};0.15;${0.15 + ((i * 37) % 10) / 14}`} dur={`${1.4 + (i % 5) * 0.3}s`} repeatCount="indefinite" />
                  </rect>
                ))}
              </g>
            )}
            {m.id === "lan" && (
              <>
                <g transform="translate(16 56)">
                  <rect width="10" height="17" rx="2.5" fill="none" stroke="rgba(255,255,255,0.5)" />
                  <rect x="17" y="2" width="23" height="14" rx="2" fill="none" stroke="rgba(255,255,255,0.5)" />
                  <text x="50" y="12.5" className="fill-white/50 font-mono" fontSize="9.5">
                    phone · TV · same Wi-Fi
                  </text>
                </g>
                <g transform={`translate(16 ${m.h - 26})`}>
                  <rect width="104" height="16" rx="8" fill="rgba(255,214,10,0.12)" />
                  <text x="52" y="11.5" textAnchor="middle" className="font-mono" fontSize="9" fill="#ffd60a">
                    off by default
                  </text>
                </g>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** "What happens on your PC stays on your PC": an interactive architecture drawing. */
export function Privacy() {
  const [focus, setFocus] = useState<ModId | null>(null);
  const mod = MODS.find((m) => m.id === focus);
  return (
    <section id="privacy" className="relative overflow-hidden bg-black px-4 py-32 sm:px-8">
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[700px] w-[1100px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(48,209,88,0.07),transparent_65%)]" />
      <div className="relative mx-auto max-w-[1180px]">
        <Reel n={7} label="The fine print, in large print" />
        <div className="mt-5 grid gap-6 lg:grid-cols-[1.25fr_1fr] lg:items-end">
          <Heading>
            What happens on your PC <span className="italic text-white/55">stays on your PC.</span>
          </Heading>
          <Lede>Your viewing habits say a lot about you. Omnia is built so that none of it needs to leave the room: no account, no analytics, and cloud sync only if you ask for it. Here is the whole machine, and every door out of it.</Lede>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.9 }}
          className="mt-14 overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#060608]"
        >
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.22em] text-white/40">
            <span>fig. 07 · omnia, local architecture</span>
            <span className="hidden sm:inline">hover a block to trace its data</span>
            <span className="sm:hidden">swipe →</span>
          </div>
          <div className="no-scrollbar overflow-x-auto">
            <div className="min-w-[760px] px-3 py-4 sm:px-6">
              <Blueprint focus={focus} setFocus={setFocus} />
            </div>
          </div>
          <div className="min-h-[76px] border-t border-white/[0.06] px-5 py-4">
            <AnimatePresence mode="wait">
              <motion.p key={focus ?? "none"} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="text-[14px] leading-relaxed text-white/60">
                {mod ? (
                  <>
                    <span className="font-semibold text-white">{mod.title}.</span> {mod.detail}
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-white">Five hosts, all named.</span> Three are two-way (⇄): a search goes to TMDB, a title to JustWatch, and your own OTT streams into its sealed window. Two are one-way (←): a signed update from GitHub and your region, once, from ipwho.is; nothing about you goes with them. Analytics, ads and crash reporters don&apos;t have a door, so nothing ever travels that way. Beyond these: a one-time, checksum-verified download of the recommendation model (Hugging Face, GitHub), and trailers from youtube-nocookie.com when one plays (autoplay can be turned off). Cloud sync is opt-in: it stays off until you sign in, and then carries only your watchlist, what you&apos;ve watched, your Home layout and a profile name and picture (<a href="/privacy" className="underline decoration-white/30 underline-offset-2 hover:text-white">Privacy Policy</a>).
                  </>
                )}
              </motion.p>
            </AnimatePresence>
          </div>
        </motion.div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PROMISES.map((p, i) => (
            <motion.div key={p.t} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.08 }} className="rounded-[20px] p-5 lg-glass-soft">
              <h3 className="text-[15px] font-semibold text-white">{p.t}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-white/55">{p.d}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
