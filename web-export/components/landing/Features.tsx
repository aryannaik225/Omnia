"use client";

import { AnimatePresence, motion, useInView } from "framer-motion";
import { Baby, CalendarClock, Check, Cloud, Globe2, Library, Link2, ListOrdered, Search, Sparkles, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Catalog, ShowPoster } from "@/lib/landing";
import { Heading, Lede, PosterArt, ProviderChip, Reel, TiltCard, type ProviderKey } from "./ui";

/* ── 1. Where is it streaming? (region-aware search) ── */
type Region = "US" | "UK";
const SEARCHES: Array<{ q: string } & Record<Region, Array<[ProviderKey, string]>>> = [
  { q: "Severance", US: [["apple", "Included"]], UK: [["apple", "Included"]] },
  { q: "Dune: Part Two", US: [["max", "Included"], ["prime", "Rent"], ["apple", "Rent"]], UK: [["prime", "Rent"], ["apple", "Rent"]] },
  { q: "The Bear", US: [["hulu", "Included"], ["disney", "Included"]], UK: [["disney", "Included"]] },
  { q: "Stranger Things", US: [["netflix", "Included"]], UK: [["netflix", "Included"]] },
];

function SearchDemo() {
  const [region, setRegion] = useState<Region>("US");
  const [idx, setIdx] = useState(0);
  const [typed, setTyped] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  useEffect(() => {
    if (!inView) return;
    const word = SEARCHES[idx].q;
    if (typed.length < word.length) {
      const t = setTimeout(() => setTyped(word.slice(0, typed.length + 1)), 70);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setTyped("");
      setIdx((v) => (v + 1) % SEARCHES.length);
    }, 2600);
    return () => clearTimeout(t);
  }, [typed, idx, inView]);
  const done = typed === SEARCHES[idx].q;
  return (
    <div ref={ref} className="mt-5">
      <div className="flex items-center gap-2">
        <div className="flex h-[42px] min-w-0 flex-1 items-center gap-2 rounded-[12px] bg-white/[0.07] px-3 text-[14px]">
          <Search size={15} className="shrink-0 text-white/45" />
          <span className="truncate whitespace-pre text-white">{typed}</span>
          <span className="-ml-1.5 h-4 w-[2px] animate-pulse bg-white/70" />
        </div>
        <div className="flex rounded-[12px] bg-white/[0.07] p-1 text-[12px] font-semibold">
          {(["US", "UK"] as const).map((r) => (
            <button key={r} onClick={() => setRegion(r)} className="relative rounded-[9px] px-2.5 py-1.5">
              {region === r && <motion.span layoutId="region" className="absolute inset-0 rounded-[9px] bg-white/20" />}
              <span className="relative">{r}</span>
            </button>
          ))}
        </div>
      </div>
      {/* Fixed height (room for three providers) so the bento grid never shifts while it types. */}
      <div className="relative mt-3 h-[136px] space-y-2 overflow-hidden">
        <AnimatePresence mode="popLayout">
          {done &&
            SEARCHES[idx][region].map(([k, kind], i) => (
              <motion.div
                key={`${idx}-${region}-${k}`}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0, transition: { delay: i * 0.08 } }}
                exit={{ opacity: 0 }}
                className="flex h-[40px] items-center justify-between rounded-[12px] bg-white/[0.04] px-3"
              >
                <ProviderChip k={k} />
                <span className={`text-[12px] font-semibold ${kind === "Included" ? "text-[#30d158]" : "text-white/45"}`}>{kind === "Included" ? "Included with your plan" : kind}</span>
              </motion.div>
            ))}
        </AnimatePresence>
      </div>
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/30">Availability illustrative · live data comes from TMDB + JustWatch for your region</p>
    </div>
  );
}

/* ── 2. Franchise hubs: release vs timeline ── */
const MCU = [
  { t: "Iron Man", y: 2008, tl: 3 },
  { t: "The Incredible Hulk", y: 2008, tl: 5 },
  { t: "Iron Man 2", y: 2010, tl: 4 },
  { t: "Thor", y: 2011, tl: 6 },
  { t: "Captain America: The First Avenger", y: 2011, tl: 1 },
  { t: "Captain Marvel", y: 2019, tl: 2 },
];
function FranchiseDemo() {
  const [order, setOrder] = useState<"release" | "timeline">("release");
  const list = [...MCU].sort((a, b) => (order === "release" ? 0 : a.tl - b.tl));
  return (
    <div className="mt-5">
      <div className="flex w-fit rounded-[12px] bg-white/[0.07] p-1 text-[12px] font-semibold">
        {(["release", "timeline"] as const).map((o) => (
          <button key={o} onClick={() => setOrder(o)} className="relative rounded-[9px] px-3 py-1.5">
            {order === o && <motion.span layoutId="order" className="absolute inset-0 rounded-[9px] bg-white/20" />}
            <span className="relative">{o === "release" ? "Release order" : "Timeline order"}</span>
          </button>
        ))}
      </div>
      <ul className="mt-3 space-y-1.5">
        {list.map((m, i) => (
          <motion.li layout key={m.t} transition={{ type: "spring", stiffness: 400, damping: 34 }} className="flex items-center gap-3 rounded-[10px] bg-white/[0.04] px-3 py-1.5 text-[13px]">
            <span className="w-4 font-mono text-[11px] text-white/35">{i + 1}</span>
            <span className="flex-1 truncate text-white/85">{m.t}</span>
            <span className="font-mono text-[11px] text-white/35">{m.y}</span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

/* ── 3. Kids & family safe mode ── */
const ADULT = new Set(["R", "NC-17", "TV-MA"]);
function KidsDemo({ titles }: { titles: ShowPoster[] }) {
  const [on, setOn] = useState(false);
  return (
    <div className="mt-5">
      <button onClick={() => setOn((v) => !v)} className="flex items-center gap-3 text-[13px] font-medium" aria-pressed={on}>
        <span className={`relative h-[26px] w-[44px] rounded-full transition-colors ${on ? "bg-[#30d158]" : "bg-white/15"}`}>
          <motion.span layout className="absolute top-[3px] h-5 w-5 rounded-full bg-white shadow" style={{ left: on ? 21 : 3 }} />
        </span>
        Kids &amp; Family Safe Mode
      </button>
      <div className="mt-4 grid grid-cols-5 gap-2">
        {titles.map((p) => {
          const adult = ADULT.has(p.cert ?? "");
          const hidden = on && adult;
          return (
            <div key={p.id} className="relative">
              <motion.div animate={{ opacity: hidden ? 0.15 : 1, scale: hidden ? 0.9 : 1, filter: hidden ? "blur(6px) grayscale(1)" : "blur(0px) grayscale(0)" }}>
                <PosterArt p={p} className="aspect-[2/3] rounded-[8px]" />
              </motion.div>
              <span
                className={`absolute bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[4px] px-1 font-mono text-[8px] font-semibold leading-[13px] ${adult ? "bg-[#ff453a]/85 text-white" : "bg-white/85 text-black"}`}
              >
                {p.cert}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[12px] text-white/40">Kids profiles keep G, PG, TV-Y and TV-G. R and TV-MA titles vanish from every row, and from autoplay.</p>
    </div>
  );
}

/* ── 4. Deep link resolver ── */
const LINKS = [
  { title: "Stranger Things", url: "netflix.com/watch/80057281", k: "netflix" as ProviderKey },
  { title: "The Boys", url: "primevideo.com/detail/0KRGHGZCHKS9…", k: "prime" as ProviderKey },
  { title: "The Last of Us", url: "hbomax.com/shows/the-last-of-us/…", k: "max" as ProviderKey },
];
function DeepLinkDemo() {
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState<"resolving" | "cached">("resolving");
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  useEffect(() => {
    if (!inView) return;
    const t = setTimeout(
      () => {
        if (phase === "resolving") setPhase("cached");
        else {
          setPhase("resolving");
          setI((v) => (v + 1) % LINKS.length);
        }
      },
      phase === "resolving" ? 900 : 2400,
    );
    return () => clearTimeout(t);
  }, [phase, inView]);
  const l = LINKS[i];
  return (
    <div ref={ref} className="mt-5 space-y-2 font-mono text-[12px]">
      <div className="flex items-center justify-between rounded-[10px] bg-white/[0.05] px-3 py-2">
        <span className="text-white/80">{l.title}</span>
        <ProviderChip k={l.k} />
      </div>
      <div className="relative overflow-hidden rounded-[10px] bg-black/40 px-3 py-2 text-white/60">
        <AnimatePresence mode="wait">
          {phase === "resolving" ? (
            <motion.span key="r" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2">
              <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: "linear" }} className="inline-block h-3 w-3 rounded-full border-2 border-white/20 border-t-white/80" />
              resolving via JustWatch GraphQL…
            </motion.span>
          ) : (
            <motion.span key="c" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="block truncate text-[#64d2ff]">
              https://www.{l.url}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <div className="flex items-center justify-between text-[11px] text-white/35">
        <span>cached 7 days in SQLite</span>
        <span className={phase === "cached" ? "text-[#30d158]" : ""}>{phase === "cached" ? "next click: 0 ms" : "first click"}</span>
      </div>
    </div>
  );
}

/* ── 5. Cross-OTT continue watching ── */
function ContinueDemo({ catalog }: { catalog: Catalog }) {
  // Each one is an original of the service it's shown on.
  const items: Array<{ p: ShowPoster; k: ProviderKey; ep: string; pct: number }> = [
    { p: catalog["stranger-things"], k: "netflix", ep: "S4 · E7 · 31 min left", pct: 0.62 },
    { p: catalog["the-boys"], k: "prime", ep: "S4 · E3 · 18 min left", pct: 0.71 },
    { p: catalog.severance, k: "apple", ep: "S2 · E4 · 9 min left", pct: 0.86 },
  ];
  return (
    <div className="mt-5 grid grid-cols-3 gap-3">
      {items.map(({ p, k, ep, pct }, i) => (
        <div key={i}>
          <div className="relative aspect-video overflow-hidden rounded-[12px]">
            <PosterArt p={{ ...p, poster: p.backdrop ?? p.poster }} className="absolute inset-0" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
            <span className="absolute left-2 top-1.5 max-w-[85%] truncate text-[10px] font-semibold text-white [text-shadow:0_1px_4px_#000]">{p.title}</span>
            <div className="absolute inset-x-2 bottom-2 h-[3px] overflow-hidden rounded-full bg-white/25">
              <motion.div initial={{ width: 0 }} whileInView={{ width: `${pct * 100}%` }} viewport={{ once: true }} transition={{ duration: 1.6, delay: 0.2 + i * 0.15, ease: "easeOut" }} className="h-full bg-white" />
            </div>
          </div>
          <ProviderChip k={k} className="mt-2 !px-2 !py-0.5 !text-[10px]" />
          <p className="mt-1 truncate text-[11px] text-white/45">{ep}</p>
        </div>
      ))}
    </div>
  );
}

const SPEC = [
  { icon: Globe2, t: "Region + VPN aware", d: "Detects your country on first launch, flips UK → US in one tap." },
  { icon: Check, t: "My Subscriptions only", d: "Hide everything you'd have to rent, or show it all with clear badges." },
  { icon: Sparkles, t: "Brand & studio hubs", d: "Apple Originals, A24, Ghibli, Pixar, Netflix and Prime exclusives." },
  { icon: Zap, t: "Smart filters", d: "Under 90 minutes or epic 2.5h+, release era, original language, kids-safe. Combine them in any hub." },
  { icon: Library, t: "My Library & watch stats", d: "Total days watched, movies and episodes, plus Watchlist, Upcoming, Ongoing and Completed series in one place." },
  { icon: CalendarClock, t: "Release-aware title pages", d: "Not streaming yet? See the digital date with a countdown, In Theatres Now, or Releasing Today." },
  { icon: ListOrdered, t: "Your Home, your order", d: "Reorder the Home rows in Settings. The layout is saved per profile and follows you when you sync." },
  { icon: Cloud, t: "Optional sync", d: "Sign in with email or Google to sync your watchlist and watched list between Desktop and the web. Off by default." },
];

export function Features({ catalog }: { catalog: Catalog }) {
  const kids = [catalog["spider-verse"], catalog.oppenheimer, catalog.coco, catalog["the-last-of-us"], catalog["paddington-2"]];
  return (
    <section id="features" className="relative bg-black px-4 py-32 sm:px-8">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(50%_60%_at_50%_0%,rgba(10,132,255,0.12),transparent_70%)]" />
      <div className="relative mx-auto max-w-[1180px]">
        <Reel n={3} label="The feature reel" />
        <div className="mt-5 grid gap-6 lg:grid-cols-[1.3fr_1fr] lg:items-end">
          <Heading>
            Everything you&apos;d build <span className="italic text-white/55">if you were tired of ten apps.</span>
          </Heading>
          <Lede>Each card below is live: switch region, flip the timeline, turn on kids mode. The real app works exactly like this, across every service at once.</Lede>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-6">
          <TiltCard className="p-6 md:col-span-3">
            <Card icon={Search} title="Where is it streaming?" body="One search across every service, with what's included in your plan versus rent or buy, for the region you're actually in." />
            <SearchDemo />
          </TiltCard>
          <TiltCard className="p-6 md:col-span-3">
            <Card icon={Sparkles} title="Continue Watching, finally universal" body="A single row for every service. Netflix, Prime Video and Apple TV+ progress sit side by side, down to the second." />
            <ContinueDemo catalog={catalog} />
          </TiltCard>
          <TiltCard className="p-6 md:col-span-3 lg:col-span-2">
            <Card icon={Sparkles} title="Franchise & universe hubs" body="MCU, DC, Star Wars, Wizarding World, MonsterVerse, Bond, Ghibli. Oldest first, or in story order." />
            <FranchiseDemo />
          </TiltCard>
          <TiltCard className="p-6 md:col-span-3 lg:col-span-2">
            <Card icon={Baby} title="Kids & Family Safe Mode" body="Strict certification filtering for kids' profiles. Nothing slips through on autoplay." />
            <KidsDemo titles={kids} />
          </TiltCard>
          <TiltCard className="p-6 md:col-span-6 lg:col-span-2">
            <Card icon={Link2} title="Straight to the play button" body="A Rust resolver turns “it's on Netflix” into the exact watch URL, then caches it." />
            <DeepLinkDemo />
          </TiltCard>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SPEC.map(({ icon: Icon, t, d }, i) => (
            <motion.div
              key={t}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              className="rounded-[20px] p-5 lg-glass-soft transition-colors hover:bg-white/[0.07]"
            >
              <Icon size={18} className="text-white/70" />
              <h3 className="mt-3 text-[15px] font-semibold text-white">{t}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-white/50">{d}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Card({ icon: Icon, title, body }: { icon: typeof Search; title: string; body: string }) {
  return (
    <div className="relative z-10">
      <div className="flex items-center gap-2 text-white/55">
        <Icon size={16} />
      </div>
      <h3 className="mt-3 text-[21px] font-semibold tracking-tight text-white">{title}</h3>
      <p className="mt-1.5 text-[14px] leading-relaxed text-white/55">{body}</p>
    </div>
  );
}
