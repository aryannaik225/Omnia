/**
 * Full-bleed hero showcase: crisp typography, provider badge ("Included with your … subscription"),
 * TMDB rating + maturity badge, Play Now / + Up Next, and a muted trailer preview that starts after
 * a 2-second hover/focus. The artwork's dominant colours drive the ambient background bleed.
 */
import { AnimatePresence, m } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { extractPalette } from "../../lib/color";
import { formatRuntime, ratingLabel } from "../../lib/format";
import { providerFamily } from "../../lib/providers";
import { useAsync } from "../../lib/hooks";
import { details as tmdbDetails, img, type MediaDetails, type MediaSummary } from "../../services/tmdbClient";
import type { SubscribedProvider } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { usePlayerStore } from "../../store/usePlayerStore";
import { CheckIcon, PlayIcon, PlusIcon } from "../common/Icons";

const ROTATE_MS = 11_000;
const TRAILER_DELAY_MS = 2_000;

export function providerBadge(d: MediaDetails | undefined, region: string, subs: SubscribedProvider[]): string | null {
  const r = d?.providersByRegion[region];
  if (!r) return null;
  const fam = (p: { providerId: number; providerName: string }) => providerFamily(p.providerId, p.providerName);
  const subFamilies = new Set(subs.filter((s) => s.isActive).map((s) => fam(s).key));
  const streaming = [...r.flatrate, ...r.free, ...r.ads];
  const included = streaming.find((p) => subFamilies.has(fam(p).key));
  if (included) return `Included with your ${fam(included).name} subscription`;
  if (r.flatrate[0]) return `Streaming on ${fam(r.flatrate[0]).name}`;
  const free = r.free[0] ?? r.ads[0];
  if (free) return `Free on ${fam(free).name}`;
  const store = r.rent[0] ?? r.buy[0];
  return store ? `Rent or buy on ${fam(store).name}` : null;
}

export function HeroBillboard({ items }: { items: MediaSummary[] }) {
  const region = useAppStore((s) => s.region);
  const subs = useAppStore((s) => s.subscriptions);
  const trailerAutoplay = useAppStore((s) => s.trailerAutoplay);
  const setAmbient = useAppStore((s) => s.setAmbient);
  const openTitle = useAppStore((s) => s.openTitle);
  const toggleWatchlist = useAppStore((s) => s.toggleWatchlist);
  const inWatchlist = useAppStore((s) => s.isInWatchlist);
  useAppStore((s) => s.watchlistKeys); // re-render on watchlist changes
  const playTitle = usePlayerStore((s) => s.playTitle);
  const launching = usePlayerStore((s) => s.launching);

  const slides = useMemo(() => items.filter((i) => i.backdropPath).slice(0, 6), [items]);
  const [index, setIndex] = useState(0);
  const [engaged, setEngaged] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = slides[index % Math.max(1, slides.length)];

  const { data: d } = useAsync(
    () => (current ? tmdbDetails(current.mediaType, current.id, region) : Promise.resolve(undefined)),
    [current?.id, current?.mediaType, region],
  );

  // Ambient bleed from the active artwork.
  useEffect(() => {
    const url = img(current?.backdropPath, "w300");
    if (!url) return;
    let alive = true;
    void extractPalette(url).then((p) => alive && setAmbient(p));
    return () => {
      alive = false;
    };
  }, [current?.backdropPath, setAmbient]);

  // Auto-advance while the user isn't engaging with the hero.
  useEffect(() => {
    if (engaged || slides.length < 2) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % slides.length), ROTATE_MS);
    return () => clearInterval(t);
  }, [engaged, slides.length]);

  // Muted trailer preview after a 2s hover/focus.
  const trailerKey = d?.videos[0]?.key;
  useEffect(() => {
    setShowTrailer(false);
    if (timer.current) clearTimeout(timer.current);
    if (!engaged || !trailerAutoplay || !trailerKey) return;
    timer.current = setTimeout(() => setShowTrailer(true), TRAILER_DELAY_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [engaged, trailerAutoplay, trailerKey, index]);

  if (!current) {
    return <div className="skeleton h-[68vh] min-h-[520px] w-full" />;
  }

  const badge = providerBadge(d, region, subs);
  const meta = [
    current.year,
    d?.mediaType === "tv" ? (d.numberOfSeasons ? `${d.numberOfSeasons} Season${d.numberOfSeasons > 1 ? "s" : ""}` : null) : formatRuntime(d?.runtimeMins),
    d?.genres.slice(0, 3).map((g) => g.name).join(" · "),
  ].filter(Boolean);
  const listed = inWatchlist(current.id, current.mediaType);
  const isLaunching = launching === `${current.mediaType}:${current.id}`;

  return (
    <section
      className="relative h-[68vh] min-h-[520px] w-full overflow-hidden"
      onPointerEnter={() => setEngaged(true)}
      onPointerLeave={() => setEngaged(false)}
      onFocusCapture={() => setEngaged(true)}
      onBlurCapture={() => setEngaged(false)}
      aria-roledescription="carousel"
      aria-label="Featured"
    >
      <AnimatePresence mode="sync">
        <m.img
          key={current.backdropPath}
          src={img(current.backdropPath, "w1280") ?? undefined}
          alt=""
          className="hero-mask absolute inset-0 h-full w-full object-cover"
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.1, ease: [0.32, 0.72, 0, 1] }}
        />
      </AnimatePresence>

      <AnimatePresence>
        {showTrailer && trailerKey && (
          <m.div
            key={trailerKey}
            className="hero-mask pointer-events-none absolute inset-0 overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8 }}
          >
            <iframe
              title={`${current.title} trailer`}
              src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&loop=1&playlist=${trailerKey}&modestbranding=1&playsinline=1&rel=0&iv_load_policy=3&disablekb=1`}
              allow="autoplay; encrypted-media"
              className="absolute left-1/2 top-1/2 h-[140%] w-[140%] -translate-x-1/2 -translate-y-1/2 scale-[1.02]"
            />
          </m.div>
        )}
      </AnimatePresence>

      <div className="hero-scrim absolute inset-0" />

      <div className="absolute bottom-[19%] left-[calc(var(--sidebar-expanded)+56px)] max-w-[620px] pr-8">
        <AnimatePresence mode="wait">
          <m.div
            key={current.id}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
          >
            {badge && <p className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-white/80">{badge}</p>}
            <h1 className="text-balance text-[56px] font-bold leading-[1.02] tracking-tight drop-shadow-lg">{current.title}</h1>
            <div className="mt-4 flex flex-wrap items-center gap-2.5 text-[14px] text-white/85">
              {d?.certification && <span className="badge">{d.certification}</span>}
              {ratingLabel(current.voteAverage) && <span className="badge !bg-[#01b4e4]/25">TMDB {ratingLabel(current.voteAverage)}</span>}
              {meta.map((x, i) => (
                <span key={i}>{x}</span>
              ))}
            </div>
            <p className="mt-4 line-clamp-3 text-[16px] leading-relaxed text-white/80">{d?.tagline || current.overview}</p>
            <div className="mt-7 flex items-center gap-3">
              <button className="glass-button-primary !px-7 !py-3 !text-[15px]" disabled={!d || isLaunching} onClick={() => d && void playTitle(d)}>
                <PlayIcon size={18} /> {isLaunching ? "Opening…" : "Play Now"}
              </button>
              <button className="glass-button !py-3" onClick={() => void toggleWatchlist(current)}>
                {listed ? <CheckIcon size={18} /> : <PlusIcon size={18} />} Up Next
              </button>
              <button className="glass-button !py-3" onClick={() => openTitle({ id: current.id, mediaType: current.mediaType, seed: current })}>
                More Info
              </button>
            </div>
          </m.div>
        </AnimatePresence>
      </div>

      {slides.length > 1 && (
        <div className="absolute bottom-[19%] right-10 flex gap-2" role="tablist" aria-label="Featured titles">
          {slides.map((s, i) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={i === index}
              aria-label={s.title}
              onClick={() => setIndex(i)}
              className={`h-1.5 rounded-full transition-all duration-500 ${i === index ? "w-8 bg-white" : "w-1.5 bg-white/40 hover:bg-white/70"}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
