import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

/** Shared shell for /privacy and /terms: the landing page's dark cinema look, built for reading. */
export function LegalPage({ eyebrow, title, updated, intro, children }: { eyebrow: string; title: string; updated: string; intro: ReactNode; children: ReactNode }) {
  return (
    <div className="landing min-h-screen text-white">
      <div className="film-grain" aria-hidden />
      <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-black/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[880px] items-center justify-between px-5 py-4">
          <Link href="/" className="flex items-center gap-2.5 text-[15px] font-semibold">
            <Image src="/icon.png" alt="" width={26} height={26} className="rounded-[7px]" />
            Omnia
          </Link>
          <nav className="flex gap-5 text-[13px] text-white/55">
            <Link href="/privacy" className="hover:text-white">Privacy</Link>
            <Link href="/terms" className="hover:text-white">Terms</Link>
            <Link href="/app" className="hover:text-white">Web app</Link>
          </nav>
        </div>
      </header>

      <main className="relative mx-auto max-w-[880px] px-5 pb-28 pt-16 max-sm:pt-10">
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(60%_80%_at_30%_0%,rgba(10,132,255,0.18),transparent_70%)]" />
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-white/45">{eyebrow}</p>
        <h1 className="font-display mt-4 text-[clamp(40px,7vw,68px)] leading-[1.02]">{title}</h1>
        <p className="mt-4 font-mono text-[12px] uppercase tracking-[0.18em] text-white/40">Last updated {updated}</p>
        <div className="mt-8 rounded-[24px] border border-white/[0.08] bg-white/[0.03] p-6 text-[16px] leading-relaxed text-white/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-xl max-sm:p-5">
          {intro}
        </div>
        <article className="legal-prose mt-12">{children}</article>
      </main>

      <footer className="border-t border-white/[0.06] px-5 py-8 text-[13px] text-white/40">
        <div className="mx-auto flex max-w-[880px] flex-wrap items-center justify-between gap-4">
          <span>© {new Date().getFullYear()} Omnia · Open source under the MIT License</span>
          <nav className="flex gap-5">
            <Link href="/" className="hover:text-white">Home</Link>
            <Link href="/privacy" className="hover:text-white">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-white">Terms of Service</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** A numbered section with an anchor. */
export function Section({ id, n, title, children }: { id: string; n: number; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-white/[0.07] py-9 first:border-t-0 first:pt-0">
      <h2 className="font-display flex items-baseline gap-4 text-[26px] leading-tight max-sm:text-[22px]">
        <span className="font-mono text-[13px] font-normal tracking-[0.2em] text-white/35">{String(n).padStart(2, "0")}</span>
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-[15.5px] leading-[1.75] text-white/75">{children}</div>
    </section>
  );
}

/** Two-column "stays on your device / goes to the cloud" table rows. */
export function DataTable({ rows }: { rows: [string, string][] }) {
  return (
    <div className="overflow-hidden rounded-[16px] border border-white/[0.08]">
      {rows.map(([k, v]) => (
        <div key={k} className="grid gap-1 border-t border-white/[0.06] px-5 py-3.5 first:border-t-0 sm:grid-cols-[220px_1fr] sm:gap-6">
          <p className="text-[14px] font-semibold text-white/90">{k}</p>
          <p className="text-[14px] text-white/65">{v}</p>
        </div>
      ))}
    </div>
  );
}
