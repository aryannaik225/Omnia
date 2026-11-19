"use client";

import Image from "next/image";
import { motion, useScroll, useTransform, type MotionValue } from "framer-motion";
import { useRef } from "react";
import { PROVIDERS, Reel, type ProviderKey } from "./ui";

// Where each app starts, scattered around the frame (vw / vh offsets from centre, rotation).
const SCATTER: Array<[ProviderKey, number, number, number]> = [
  ["netflix", -36, 16, -12],
  ["prime", 34, 20, 9],
  ["paramount", -22, 31, 7],
  ["max", 20, 34, -8],
  ["disney", -44, -4, 11],
  ["apple", 44, -2, -5],
  ["crunchyroll", -4, 25, 4],
  ["hotstar", 6, 40, -10],
  ["hulu", -42, 38, -4],
  ["peacock", 42, 37, 6],
];

const QUESTIONS = ["“Wait, which app was that on?”", "“Did we finish season two?”", "“It left Netflix… where did it go?”", "“Search it on Google, I guess.”"];

function Chip({ k, x, y, r, progress, i }: { k: ProviderKey; x: number; y: number; r: number; progress: MotionValue<number>; i: number }) {
  const start = 0.3 + i * 0.01;
  const end = 0.56 + i * 0.008;
  const tx = useTransform(progress, [start, end], [`${x}vw`, "0vw"]);
  const ty = useTransform(progress, [start, end], [`${y}vh`, "0vh"]);
  const rot = useTransform(progress, [start, end], [r, 0]);
  const scale = useTransform(progress, [start, end, end + 0.06], [1, 0.7, 0.2]);
  const opacity = useTransform(progress, [0, 0.05, end, end + 0.06], [0, 1, 1, 0]);
  const p = PROVIDERS[k];
  return (
    <motion.div style={{ x: tx, y: ty, rotate: rot, scale, opacity }} className="absolute left-1/2 top-1/2 -ml-[70px] -mt-[24px]">
      <div className="flex h-[48px] w-[140px] items-center justify-center gap-2 rounded-[14px] text-[15px] font-semibold text-white lg-glass" style={{ boxShadow: `0 0 40px -12px ${p.color}, inset 0 1px 0 rgba(255,255,255,0.2)` }}>
        <span className="h-2 w-2 rounded-full" style={{ background: p.color, boxShadow: `0 0 12px ${p.color}` }} />
        {p.name}
      </div>
    </motion.div>
  );
}

export function Fragmentation() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const hub = useTransform(scrollYProgress, [0.55, 0.7], [0.4, 1]);
  const hubOpacity = useTransform(scrollYProgress, [0.52, 0.62], [0, 1]);
  const glow = useTransform(scrollYProgress, [0.55, 0.8], [0, 1]);
  const before = useTransform(scrollYProgress, [0.3, 0.45], [1, 0]);
  const after = useTransform(scrollYProgress, [0.64, 0.76], [0, 1]);
  const afterY = useTransform(scrollYProgress, [0.64, 0.76], [30, 0]);

  return (
    <section ref={ref} id="problem" className="relative h-[260vh] bg-black">
      <div className="sticky top-0 flex h-[100svh] items-center justify-center overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_50%,rgba(90,70,180,0.14),transparent_70%)]" />
        {SCATTER.map(([k, x, y, r], i) => (
          <Chip key={k} k={k} x={x} y={y} r={r} progress={scrollYProgress} i={i} />
        ))}

        <motion.div style={{ scale: hub, opacity: hubOpacity }} className="relative z-10 flex flex-col items-center">
          <motion.div style={{ opacity: glow }} className="absolute -inset-24 rounded-full bg-[radial-gradient(circle,rgba(150,130,255,0.45),transparent_65%)] blur-2xl" />
          <Image src="/icon.png" alt="Omnia" width={128} height={128} className="relative rounded-[30px] shadow-[0_30px_80px_-20px_rgba(120,100,255,0.8)]" />
        </motion.div>

        <motion.div style={{ opacity: before }} className="absolute inset-x-0 top-[12vh] z-20 mx-auto max-w-[900px] px-6 text-center">
          <Reel n={1} label="The problem" tone="text-white/45 justify-center" />
          <h2 className="mt-5 font-display text-[clamp(38px,6vw,84px)] leading-[0.98] text-white">
            Ten apps. Ten search bars.
            <br />
            <span className="italic text-white/50">Ten “Continue Watching” rows that never talk.</span>
          </h2>
          <div className="mt-6 flex flex-wrap justify-center gap-2 font-mono text-[12px] text-white/45">
            {QUESTIONS.map((q) => (
              <span key={q} className="rounded-full px-3 py-1.5 lg-glass-soft">
                {q}
              </span>
            ))}
          </div>
        </motion.div>

        <motion.div style={{ opacity: after, y: afterY }} className="absolute inset-x-0 bottom-[10vh] z-20 mx-auto max-w-[760px] px-6 text-center">
          <h2 className="font-display text-[clamp(40px,6vw,84px)] leading-[0.98] text-white">
            One library. <span className="italic text-foil">One remote.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-[560px] text-[17px] leading-relaxed text-white/60">
            Omnia pulls every service you pay for into a single catalog for your region, and hands you straight to the play button, wherever the title actually lives.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
