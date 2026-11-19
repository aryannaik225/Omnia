"use client";

import Image from "next/image";
import Link from "next/link";
import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";

const CREDITS: Array<[string, string]> = [
  ["Directed by", "The Omnia contributors"],
  ["Systems backend", "Rust · Tauri 2.0"],
  ["Player", "Microsoft Edge WebView2"],
  ["Catalog & artwork", "The Movie Database (TMDB)"],
  ["Deep links", "JustWatch"],
  ["Recommendations", "all-MiniLM-L6-v2 · ONNX Runtime"],
  ["Storage", "SQLite, on your machine"],
  ["Filmed on location", "Your living room"],
];

/** End credits: they roll up as you reach the bottom of the page. */
export function Credits({ repoUrl, version }: { repoUrl: string; version: string }) {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end end"] });
  const y = useTransform(scrollYProgress, [0, 1], [160, 0]);
  const opacity = useTransform(scrollYProgress, [0, 0.5], [0, 1]);
  const end = useTransform(scrollYProgress, [0.7, 1], [0, 1]);

  return (
    <footer ref={ref} className="relative overflow-hidden bg-black px-4 pb-10 pt-32 sm:px-8">
      <motion.div style={{ y, opacity }} className="mx-auto max-w-[640px] text-center">
        <dl className="space-y-5">
          {CREDITS.map(([role, who]) => (
            <div key={role} className="grid grid-cols-2 items-baseline gap-6">
              <dt className="text-right font-mono text-[11px] uppercase tracking-[0.25em] text-white/35">{role}</dt>
              <dd className="text-left font-display text-[22px] text-white/85">{who}</dd>
            </div>
          ))}
        </dl>
        <motion.p style={{ opacity: end }} className="mt-20 font-display text-[clamp(56px,10vw,120px)] italic leading-none text-white">
          Fin.
        </motion.p>
      </motion.div>

      <div className="mx-auto mt-24 flex max-w-[1180px] flex-col gap-6 border-t border-white/[0.06] pt-8 text-[13px] text-white/40 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Image src="/icon.png" alt="" width={24} height={24} className="rounded-[6px]" />
          <span>Omnia v{version} · Every streaming service. One marquee.</span>
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-2">
          <a href="#download" className="hover:text-white">Download</a>
          <Link href="/app" className="hover:text-white">Web app</Link>
          <a href={repoUrl} target="_blank" rel="noreferrer" className="hover:text-white">GitHub</a>
          <a href={`${repoUrl}/issues`} target="_blank" rel="noreferrer" className="hover:text-white">Issues</a>
          <a href="#top" className="hover:text-white">Back to the top ↑</a>
        </nav>
      </div>
      <p className="mx-auto mt-6 max-w-[1180px] text-[11px] leading-relaxed text-white/25">
        This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming service names are trademarks of their respective owners; Omnia is not affiliated with them and
        plays titles through your own subscriptions. Quotes are from their respective films.
      </p>
    </footer>
  );
}
