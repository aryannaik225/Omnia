"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Check, Minus, Monitor, Globe } from "lucide-react";
import { useState } from "react";
import { Heading, Lede, Reel, WindowsIcon } from "./ui";

const ROWS: Array<{ f: string; desktop: string | true; web: string | false }> = [
  { f: "Every service in one catalog", desktop: true, web: "Yes" },
  { f: "Native low-RAM player window", desktop: "Rust + Tauri, WebView2", web: false },
  { f: "Watch history", desktop: "Live telemetry + OTT auto-import", web: "Mark as watched + JSON import" },
  { f: "My Library & watch stats", desktop: true, web: "Yes" },
  { f: "Custom Home Page Layout", desktop: true, web: "Yes" },
  { f: "Where your data lives", desktop: "Your PC, SQLite", web: "This browser, or your account" },
  { f: "Account", desktop: "Optional: sign in to sync", web: "Optional: guest mode works" },
  { f: "Local AI recommendations", desktop: "ONNX vectors on-device", web: false },
  { f: "Phone & TV handoff", desktop: "LAN pairing", web: false },
  { f: "Updates", desktop: "Signed, silent, one restart", web: "Always the latest" },
  { f: "Install", desktop: "Per-user, no admin needed", web: "Nothing to install" },
];

export function DesktopVsBrowser({ version }: { version: string }) {
  const [focus, setFocus] = useState<"desktop" | "web">("desktop");
  return (
    <section id="compare" className="relative bg-black px-4 py-32 sm:px-8">
      <div className="mx-auto max-w-[1180px]">
        <Reel n={9} label="Two ways in" />
        <div className="mt-5 grid gap-6 lg:grid-cols-[1.25fr_1fr] lg:items-end">
          <Heading>
            The director&apos;s cut, <span className="italic text-white/55">or the trailer.</span>
          </Heading>
          <Lede>
            The browser edition is a manual tracker you can open right now, no account needed. The desktop app is the full feature: native player, real history, recommendations that run on your own hardware. Sign in on both and your library follows you.
          </Lede>
        </div>

        <div className="mt-14 grid gap-4 lg:grid-cols-2">
          {(["desktop", "web"] as const).map((k) => {
            const desk = k === "desktop";
            const active = focus === k;
            return (
              <motion.div
                key={k}
                onPointerEnter={() => setFocus(k)}
                animate={{ scale: active ? 1 : 0.98, opacity: active ? 1 : 0.7 }}
                transition={{ type: "spring", stiffness: 260, damping: 26 }}
                className={`relative overflow-hidden rounded-[28px] p-7 ${desk ? "lg-glass" : "lg-glass-soft"}`}
              >
                {desk && <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(233,196,92,0.25),transparent_70%)]" />}
                <div className="relative flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-white/10">{desk ? <Monitor size={20} /> : <Globe size={20} />}</span>
                    <div>
                      <h3 className="text-[20px] font-semibold tracking-tight text-white sm:text-[22px]">{desk ? "Omnia for Windows" : "Omnia on the web"}</h3>
                      <p className="text-[13px] text-white/45">{desk ? `v${version} · Windows 10 & 11 · x64` : "Any modern browser · guest mode or sign in"}</p>
                    </div>
                  </div>
                  {desk && <span className="shrink-0 rounded-full bg-gold-400/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gold-300">Recommended</span>}
                </div>
                <ul className="relative mt-6 divide-y divide-white/[0.06]">
                  {ROWS.map((r) => {
                    const v = desk ? r.desktop : r.web;
                    return (
                      <li key={r.f} className="flex items-start justify-between gap-4 py-2.5 text-[14px] sm:items-center">
                        <span className="min-w-0 text-white/60">{r.f}</span>
                        <span className={`flex max-w-[55%] items-center justify-end gap-1.5 text-right text-[13px] ${v === false ? "text-white/25" : "text-white"}`}>
                          {v === false ? <Minus size={14} className="shrink-0" /> : <Check size={14} className={`shrink-0 ${desk ? "text-gold-400" : "text-white/60"}`} />}
                          {v === true ? "Yes" : v === false ? "" : v}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className="relative mt-6">
                  {desk ? (
                    <a href="#download" className="flex w-full items-center justify-center gap-2.5 rounded-[14px] bg-white py-3.5 text-[15px] font-semibold text-black transition-transform hover:scale-[1.02]">
                      <WindowsIcon /> Get the desktop app
                    </a>
                  ) : (
                    <Link href="/app" className="group flex w-full items-center justify-center gap-2 rounded-[14px] py-3.5 text-[15px] font-semibold text-white lg-glass transition-colors hover:bg-white/10">
                      Launch in your browser <ArrowRight size={16} className="transition-transform group-hover:translate-x-1" />
                    </Link>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
