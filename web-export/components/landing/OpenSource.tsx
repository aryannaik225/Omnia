"use client";

import { motion, useInView } from "framer-motion";
import { ArrowUpRight, Bug, GitPullRequest, Map as MapIcon, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GithubIcon, Heading, Lede, Reel } from "./ui";

const SCRIPT: Array<{ cmd?: string; out?: string; tone?: string }> = [
  { cmd: "git clone https://github.com/aryannaik225/Omnia" },
  { out: "Cloning into 'Omnia'… done.", tone: "text-white/40" },
  { cmd: "cd Omnia && npm install" },
  { out: "✓ dependencies installed", tone: "text-white/40" },
  { cmd: "npm run tauri dev" },
  { out: "   Compiling omnia v1 (src-tauri)", tone: "text-[#64d2ff]" },
  { out: "    Finished dev profile", tone: "text-[#30d158]" },
  { out: "  ➜  Omnia is running. Grab some popcorn. 🍿", tone: "text-gold-300" },
];

const STACK = ["Rust", "Tauri 2", "React 19", "TypeScript", "SQLite", "ONNX Runtime", "axum", "Tailwind", "Framer Motion", "Next.js"];

function Terminal() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-120px" });
  const [line, setLine] = useState(0);
  const [chars, setChars] = useState(0);
  useEffect(() => {
    if (!inView || line >= SCRIPT.length) return;
    const cur = SCRIPT[line];
    if (cur.cmd && chars < cur.cmd.length) {
      const t = setTimeout(() => setChars((c) => c + 1), 28);
      return () => clearTimeout(t);
    }
    const t = setTimeout(
      () => {
        setLine((l) => l + 1);
        setChars(0);
      },
      cur.cmd ? 380 : 260,
    );
    return () => clearTimeout(t);
  }, [inView, line, chars]);

  return (
    <div ref={ref} className="overflow-hidden rounded-[22px] border border-white/10 bg-[#07070a] shadow-[0_40px_100px_-30px_rgba(0,0,0,0.9)]">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 font-mono text-[11px] text-white/35">~/code — zsh</span>
      </div>
      <div className="min-h-[280px] space-y-1.5 p-5 font-mono text-[13px] leading-relaxed">
        {SCRIPT.slice(0, line + 1).map((l, i) => {
          if (i === line && line < SCRIPT.length && l.cmd)
            return (
              <p key={i} className="break-all text-white">
                <span className="text-[#30d158]">❯</span> {l.cmd.slice(0, chars)}
                <span className="ml-0.5 inline-block h-4 w-2 translate-y-[3px] animate-pulse bg-white/70" />
              </p>
            );
          if (i === line && line < SCRIPT.length) return null;
          return l.cmd ? (
            <p key={i} className="break-all text-white">
              <span className="text-[#30d158]">❯</span> {l.cmd}
            </p>
          ) : (
            <p key={i} className={l.tone}>
              {l.out}
            </p>
          );
        })}
      </div>
    </div>
  );
}

export function OpenSource({ repoUrl }: { repoUrl: string }) {
  const cards = [
    { icon: Bug, t: "Report a bug", d: "Something off with a provider or a deep link? Open an issue with the title and region.", href: `${repoUrl}/issues/new` },
    { icon: GitPullRequest, t: "Send a pull request", d: "New hub, a smarter resolver, a better embedding. Small, focused PRs land fastest.", href: `${repoUrl}/pulls` },
    { icon: MapIcon, t: "Read the blueprint", d: "CLAUDE.md maps every module: resolver, player, importer, recommender, LAN server.", href: `${repoUrl}/blob/main/CLAUDE.md` },
    { icon: Star, t: "Star the repo", d: "The cheapest way to tell us to keep the projector running.", href: repoUrl },
  ];
  return (
    <section id="open-source" className="relative overflow-hidden bg-black px-4 py-32 sm:px-8">
      <div className="pointer-events-none absolute -left-40 top-20 h-[600px] w-[600px] rounded-full bg-[radial-gradient(circle,rgba(48,209,88,0.08),transparent_65%)]" />
      <div className="relative mx-auto max-w-[1180px]">
        <Reel n={11} label="Open source" />
        <div className="mt-5 grid gap-6 lg:grid-cols-[1.25fr_1fr] lg:items-end">
          <Heading>
            The script is open. <span className="italic text-white/55">Pull up a chair in the writers&apos; room.</span>
          </Heading>
          <Lede>
            Omnia is built in the open: Rust backend, React front end, every resolver and recommender line on GitHub. Read it, fork it, file the issue you wish someone else would.
          </Lede>
        </div>

        <div className="mt-14 grid gap-4 lg:grid-cols-[1.15fr_1fr]">
          <div>
            <Terminal />
            <div className="mt-4 flex flex-wrap gap-2">
              {STACK.map((s, i) => (
                <motion.span key={s} initial={{ opacity: 0, y: 8 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.04 }} className="rounded-full px-3 py-1.5 font-mono text-[12px] text-white/70 lg-glass-soft">
                  {s}
                </motion.span>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {cards.map(({ icon: Icon, t, d, href }, i) => (
              <motion.a
                key={t}
                href={href}
                target="_blank"
                rel="noreferrer"
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.08 }}
                whileHover={{ y: -4 }}
                className="group flex flex-col rounded-[22px] p-5 lg-glass transition-colors hover:bg-white/[0.08]"
              >
                <div className="flex items-center justify-between">
                  <Icon size={18} className="text-white/70" />
                  <ArrowUpRight size={16} className="text-white/30 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-white" />
                </div>
                <h3 className="mt-4 text-[16px] font-semibold text-white">{t}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-white/50">{d}</p>
              </motion.a>
            ))}
            <a href={repoUrl} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2.5 rounded-[16px] bg-white py-3.5 text-[15px] font-semibold text-black transition-transform hover:scale-[1.02] sm:col-span-2">
              <GithubIcon /> aryannaik225/Omnia
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
