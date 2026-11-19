"use client";

import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { ArrowUpRight, Download as DownloadIcon, FileText, Package, ShieldCheck } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Heading, Reel, WindowsIcon } from "./ui";

export interface DownloadProps {
  version: string;
  tag: string;
  publishedAt: string | null;
  pageUrl: string;
  releasesUrl: string;
  exe: { url: string; name: string; sizeBytes: number | null } | null;
  msi: { url: string; name: string; sizeBytes: number | null } | null;
  setup: { url: string } | null;
  notes: string;
  live: boolean;
}

const mb = (b: number | null) => (b ? `${(b / 1024 / 1024).toFixed(1)} MB` : null);

/** Inline markdown: **bold**, *italic*, `code`, [links](url). Everything else stays text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    if (s.startsWith("**")) out.push(<strong key={k++} className="font-semibold text-white">{s.slice(2, -2)}</strong>);
    else if (s.startsWith("`")) out.push(<code key={k++} className="rounded bg-white/10 px-1 py-0.5 font-mono text-[12px] text-white/85">{s.slice(1, -1)}</code>);
    else if (s.startsWith("[")) {
      const label = s.slice(1, s.indexOf("]"));
      const href = s.slice(s.indexOf("(") + 1, -1);
      out.push(<a key={k++} href={href} target="_blank" rel="noreferrer" className="text-[#64d2ff] underline-offset-2 hover:underline">{label}</a>);
    } else out.push(<em key={k++}>{s.slice(1, -1)}</em>);
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A tiny, safe markdown renderer for GitHub release notes (headings, lists, paragraphs). */
function ReleaseNotes({ md }: { md: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    blocks.push(
      <ul key={blocks.length} className="space-y-1.5">
        {list.map((li, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-gold-400" />
            <span>{inline(li)}</span>
          </li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      list.push(li[1]);
      continue;
    }
    if (/^\s{2,}\S/.test(raw) && list.length) {
      list[list.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flush();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) blocks.push(<h4 key={blocks.length} className="pt-2 text-[13px] font-semibold uppercase tracking-[0.14em] text-white/50">{inline(h[2])}</h4>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="space-y-3 text-[14px] leading-relaxed text-white/65">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}

/** The download section, styled as an admit-one cinema ticket that tilts toward the cursor. */
export function Download(p: DownloadProps) {
  const ref = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(0.5);
  const my = useMotionValue(0.5);
  const rx = useSpring(useTransform(my, [0, 1], [6, -6]), { stiffness: 150, damping: 18 });
  const ry = useSpring(useTransform(mx, [0, 1], [-8, 8]), { stiffness: 150, damping: 18 });
  const shine = useTransform(mx, [0, 1], ["-30%", "130%"]);
  const date = p.publishedAt ? new Date(p.publishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;
  const exeHref = p.exe?.url ?? p.pageUrl;
  const msiHref = p.msi?.url ?? p.pageUrl;
  const setupHref = p.setup?.url ?? p.pageUrl;

  // Download = tear the stub. The file itself comes from /download/* (a redirect to the release
  // asset, which GitHub serves as an attachment), or the release page opens if there's no asset.
  const [torn, setTorn] = useState<null | "file" | "page">(null);
  const [wiggle, setWiggle] = useState(false);
  const [sent, setSent] = useState(false);
  const [stubKey, setStubKey] = useState(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  const admit = (e: MouseEvent<HTMLAnchorElement>, href: string, external: boolean) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // modified clicks behave like links
    e.preventDefault();
    if (torn || wiggle) return;
    // 1. the stub strains at the perforation, 2. it tears and falls, 3. only then the download
    setWiggle(true);
    timers.current.push(
      window.setTimeout(() => setTorn(external ? "page" : "file"), 260),
      window.setTimeout(() => {
        setSent(true);
        if (external) window.open(href, "_blank", "noopener,noreferrer");
        else window.location.assign(href);
      }, 260 + 720),
      window.setTimeout(() => {
        setTorn(null);
        setSent(false);
        setWiggle(false);
        setStubKey((k) => k + 1);
      }, 4800),
    );
  };

  return (
    <section id="download" className="relative overflow-hidden bg-black px-4 py-32 sm:px-8">
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[800px] w-[1200px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(233,196,92,0.13),transparent_60%)]" />
      <div className="relative mx-auto max-w-[1180px]">
        <Reel n={10} label="Box office" />
        <Heading className="mt-5 max-w-[900px]">
          Your seat is <span className="italic text-foil">saved.</span>
        </Heading>

        <div className="mt-14 grid gap-6 xl:grid-cols-[1.25fr_1fr]">
          {/* ticket */}
          <div className="[perspective:1400px]">
            <motion.div
              ref={ref}
              onPointerMove={(e) => {
                const r = ref.current!.getBoundingClientRect();
                mx.set((e.clientX - r.left) / r.width);
                my.set((e.clientY - r.top) / r.height);
              }}
              onPointerLeave={() => {
                mx.set(0.5);
                my.set(0.5);
              }}
              style={{ rotateX: rx, rotateY: ry }}
              className="relative flex flex-col drop-shadow-[0_40px_50px_rgba(233,196,92,0.16)] sm:flex-row"
            >
              {/* main body */}
              <div className="ticket-body relative flex-1 overflow-hidden rounded-t-[28px] bg-gradient-to-br from-[#1c1608] via-[#0f0c06] to-[#0c0b08] shadow-[inset_0_1px_0_rgba(255,236,180,0.25),inset_0_0_0_1px_rgba(232,193,95,0.25)] sm:rounded-l-[28px] sm:rounded-tr-none">
                <motion.div aria-hidden style={{ left: shine }} className="pointer-events-none absolute inset-y-0 w-[30%] -skew-x-12 bg-gradient-to-r from-transparent via-[#fff1b8]/10 to-transparent" />
                <div className="relative p-7 sm:p-9">
                  <div className="flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.3em] text-gold-300/70">
                    <span>Admit one</span>
                    <span className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${p.live ? "animate-pulse bg-[#30d158]" : "bg-gold-400"}`} />
                      {p.live ? "Live from GitHub" : "Latest stable"}
                    </span>
                  </div>
                  <p className="mt-6 font-display text-[clamp(52px,8vw,100px)] leading-[0.88] tracking-[-0.03em] text-white">
                    Omnia <span className="italic text-foil">{p.tag}</span>
                  </p>
                  <div className="mt-5 grid grid-cols-2 gap-4 border-y border-dashed border-gold-400/25 py-4 font-mono text-[10px] uppercase tracking-[0.12em] sm:grid-cols-3 sm:text-[11px] sm:tracking-[0.15em]">
                    <div>
                      <p className="text-white/35">Screen</p>
                      <p className="mt-1 text-white/85">Windows 10 / 11</p>
                    </div>
                    <div>
                      <p className="text-white/35">Seat</p>
                      <p className="mt-1 text-white/85">x64 · per-user</p>
                    </div>
                    <div>
                      <p className="text-white/35">Premiere</p>
                      <p className="mt-1 text-white/85">{date ?? "Now showing"}</p>
                    </div>
                  </div>
                  <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                    <a
                      href={exeHref}
                      onClick={(e) => admit(e, exeHref, !p.exe)}
                      className="group flex flex-1 items-center justify-center gap-2.5 whitespace-nowrap rounded-[14px] bg-gradient-to-b from-[#fff1b8] to-[#e9c45c] px-5 py-3.5 text-[15px] font-semibold text-[#2a1d02] shadow-[0_10px_30px_-10px_rgba(233,196,92,0.8)] transition-transform hover:scale-[1.02] active:scale-[0.98]"
                    >
                      <WindowsIcon /> Download .exe
                      {mb(p.exe?.sizeBytes ?? null) && <span className="font-mono text-[11px] opacity-60">{mb(p.exe!.sizeBytes)}</span>}
                    </a>
                    <a
                      href={msiHref}
                      onClick={(e) => admit(e, msiHref, !p.msi)}
                      className="flex items-center justify-center gap-2 whitespace-nowrap rounded-[14px] px-5 py-3.5 text-[15px] font-semibold text-white lg-glass-soft transition-colors hover:bg-white/10"
                    >
                      <Package size={16} /> .msi installer
                    </a>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-white/50">
                    <a href={setupHref} className="flex items-center gap-1.5 hover:text-white">
                      <FileText size={14} /> setup_instructions.txt
                    </a>
                    <a href={p.releasesUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-white">
                      All releases <ArrowUpRight size={14} />
                    </a>
                    <span className="flex items-center gap-1.5">
                      <ShieldCheck size={14} /> Signed updates after install
                    </span>
                  </div>
                  <AnimatePresence mode="wait">
                    {torn && sent ? (
                      <motion.p key="torn" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 text-[12px] text-gold-300/80">
                        {torn === "page" ? "The installers are on the release page on GitHub: it just opened in a new tab." : "Ticket torn. Your download has started: enjoy the show."}
                      </motion.p>
                    ) : (
                      !p.exe && (
                        <motion.p key="note" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-3 text-[12px] text-white/35">
                          Installers are attached to the release on GitHub: the buttons open it.
                        </motion.p>
                      )
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* stub: tears off when you download */}
              <div className="relative h-[86px] sm:h-auto sm:w-[112px]">
                <AnimatePresence>
                  {!torn && (
                    <motion.div
                      key={stubKey}
                      initial={{ opacity: 0, y: -14 }}
                      animate={wiggle ? { opacity: 1, y: 0, rotate: [0, -3, 2.5, 0], x: [0, -3, 4, 0], transition: { duration: 0.3 } } : { opacity: 1, y: 0, rotate: 0, x: 0 }}
                      exit={{ x: 34, y: 300, rotate: 22, opacity: 0, transition: { duration: 0.75, ease: [0.55, 0, 0.8, 0.4] } }}
                      style={{ transformOrigin: "0% 0%" }}
                      className="ticket-stub absolute inset-0 flex items-center justify-between gap-4 rounded-b-[28px] border-t-2 border-dashed border-gold-400/30 bg-gradient-to-br from-[#191307] to-[#0b0a08] px-7 shadow-[inset_0_0_0_1px_rgba(232,193,95,0.22)] sm:flex-col sm:rounded-r-[28px] sm:rounded-bl-none sm:border-l-2 sm:border-t-0 sm:px-0 sm:py-7"
                    >
                      <DownloadIcon size={20} className="text-gold-300/70" />
                      <span className="font-mono text-[11px] uppercase tracking-[0.35em] text-gold-300/60 sm:[writing-mode:vertical-rl]">No. {p.version.replace(/\./g, "")}-0001</span>
                      <div className="flex gap-[3px] sm:flex-col" aria-hidden>
                        {Array.from({ length: 14 }).map((_, i) => (
                          <span key={i} className="h-[22px] w-[2px] bg-gold-300/50 sm:h-[2px] sm:w-[var(--bw)]" style={{ ["--bw" as string]: `${18 + ((i * 7) % 22)}px` }} />
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                {/* paper fibres from the tear */}
                <AnimatePresence>
                  {torn &&
                    Array.from({ length: 10 }).map((_, i) => (
                      <motion.span
                        key={`${stubKey}-f${i}`}
                        initial={{ opacity: 1, x: 0, y: 0, rotate: 0 }}
                        animate={{ opacity: 0, x: ((i * 37) % 60) - 20, y: 40 + ((i * 53) % 90), rotate: (i * 83) % 360 }}
                        transition={{ duration: 0.9 + (i % 3) * 0.2, ease: "easeOut" }}
                        className="absolute left-0 top-[10%] h-[3px] w-[5px] rounded-[1px] bg-gold-300/70 sm:top-auto"
                        style={{ top: `${8 + i * 9}%` }}
                      />
                    ))}
                </AnimatePresence>
                <AnimatePresence>
                  {torn && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.5 } }} exit={{ opacity: 0 }} className="absolute inset-0 flex items-center justify-center">
                      <span className="font-display text-[22px] italic text-gold-300/80 sm:[writing-mode:vertical-rl]">Enjoy the show</span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
            <p className="mt-4 text-center text-[13px] text-white/40">
              Windows may say “Windows protected your PC” for new apps: choose <b className="text-white/60">More info → Run anyway</b>.
            </p>
          </div>

          {/* release notes */}
          <div className="flex flex-col rounded-[28px] p-7 lg-glass">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-white/45">Release notes · {p.tag}</p>
              <a href={p.pageUrl} target="_blank" rel="noreferrer" className="text-white/45 hover:text-white" aria-label="Open release on GitHub">
                <ArrowUpRight size={16} />
              </a>
            </div>
            <div className="no-scrollbar mt-4 max-h-[420px] flex-1 overflow-y-auto pr-1 [mask-image:linear-gradient(to_bottom,black_85%,transparent)]">
              <ReleaseNotes md={p.notes} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
