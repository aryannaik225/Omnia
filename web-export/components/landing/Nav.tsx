"use client";

import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "framer-motion";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { GithubIcon } from "./ui";

const LINKS = [
  { href: "#features", label: "Features" },
  { href: "#player", label: "Player" },
  { href: "#taste", label: "Taste engine" },
  { href: "#devices", label: "Phone & TV" },
  { href: "#open-source", label: "Open source" },
];

export function Nav({ repoUrl }: { repoUrl: string }) {
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useMotionValueEvent(scrollY, "change", (y) => setScrolled(y > 40));

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3">
      <motion.nav
        initial={{ y: -40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3, duration: 0.8, ease: [0.2, 0.7, 0.2, 1] }}
        className={`flex w-full max-w-[1180px] items-center gap-2 rounded-[18px] px-3 py-2 transition-all duration-500 ${scrolled ? "lg-glass" : "bg-transparent"}`}
      >
        <Link href="/" className="flex items-center gap-2 rounded-[12px] px-2 py-1">
          <Image src="/icon.png" alt="" width={28} height={28} className="rounded-[8px]" priority />
          <span className="text-[17px] font-semibold tracking-tight text-white">Omnia</span>
        </Link>
        <ul className="ml-4 hidden flex-1 items-center gap-1 lg:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a href={l.href} className="rounded-[10px] px-3 py-2 text-[14px] text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="ml-auto flex items-center gap-2">
          <a href={repoUrl} target="_blank" rel="noreferrer" aria-label="Omnia on GitHub" className="hidden rounded-[10px] p-2 text-white/70 transition-colors hover:bg-white/[0.07] hover:text-white sm:block">
            <GithubIcon />
          </a>
          <Link href="/app" className="hidden rounded-[12px] px-3.5 py-2 text-[14px] font-medium text-white/85 lg-glass-soft transition-colors hover:text-white sm:block">
            Open web app
          </Link>
          <a href="#download" className="rounded-[12px] bg-white px-3.5 py-2 text-[14px] font-semibold text-black transition-transform hover:scale-[1.03]">
            Download
          </a>
          <button onClick={() => setOpen((v) => !v)} aria-label="Menu" aria-expanded={open} className="rounded-[10px] p-2 text-white lg:hidden">
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </motion.nav>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            className="absolute inset-x-3 top-[68px] rounded-[20px] p-2 lg-glass lg:hidden"
          >
            {[...LINKS, { href: "/app", label: "Open web app" }, { href: repoUrl, label: "GitHub" }].map((l) => (
              <a key={l.href} href={l.href} onClick={() => setOpen(false)} className="block rounded-[12px] px-4 py-3 text-[16px] text-white/80 hover:bg-white/[0.07]">
                {l.label}
              </a>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
