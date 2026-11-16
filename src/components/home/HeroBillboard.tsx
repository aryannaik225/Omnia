/**
 * Full-bleed hero showcase: crisp typography, provider badge ("Included with your … subscription"),
 * TMDB rating + maturity badge, Play Now / + Up Next, and a muted trailer preview that starts after
 * a 2-second hover/focus. The artwork's dominant colours drive the ambient background bleed.
 */
import { AnimatePresence, m } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { extractPalette } from "../../lib/color";
import { formatRuntime, ratingLabel } from "../../lib/format";
import { providerFamily } from "../../lib/providers";
import { useAsync } from "../../lib/hooks";
import { details as tmdbDetails, img, type MediaDetails, type MediaSummary } from "../../services/tmdbClient";
import type { SubscribedProvider } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { usePlayerStore } from "../../store/usePlayerStore";
import { CheckIcon, PlayIcon, PlusIcon, SpeakerIcon, SpeakerMutedIcon } from "../common/Icons";

const ROTATE_MS = 11_000;
const TRAILER_DELAY_MS = 2_000;
const YT_ORIGINS = new Set(["https://www.youtube-nocookie.com", "https://www.youtube.com"]);

/** Commands for the YouTube IFrame player over postMessage (`enablejsapi=1`). */
function ytCommand(frame: HTMLIFrameElement | null, func: string, args: unknown[] = []) {
  frame?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
}

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
  /** Bumped on manual navigation so the auto-advance timer restarts from zero. */
  const [cycle, setCycle] = useState(0);
  const [engaged, setEngaged] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false);
  /** Muted by default; the choice sticks across slides for this session. */
  const [muted, setMuted] = useState(true);
  /** Trailers play once: a finished trailer isn't restarted until the slide changes. */
  const [endedKey, setEndedKey] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safeIndex = slides.length ? index % slides.length : 0;
  const current = slides[safeIndex];

  // Keep the selection on the same title when the slide list changes (recs / filter updates).
  const currentKey = current ? `${current.mediaType}:${current.id}` : null;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const at = lastKey.current ? slides.findIndex((s) => `${s.mediaType}:${s.id}` === lastKey.current) : -1;
    if (at >= 0 && at !== safeIndex) setIndex(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides]);
  useEffect(() => {
    lastKey.current = currentKey;
  }, [currentKey]);

  const goTo = useCallback(
    (i: number) => {
      if (!slides.length) return;
      setIndex(((i % slides.length) + slides.length) % slides.length);
      setCycle((c) => c + 1);
    },
    [slides.length],
  );

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
  }, [engaged, slides.length, cycle]);

  // Muted trailer preview after a 2s hover/focus; plays once, then the artwork returns.
  const trailerKey = d?.videos[0]?.key;
  useEffect(() => {
    setShowTrailer(false);
    if (timer.current) clearTimeout(timer.current);
    if (!engaged || !trailerAutoplay || !trailerKey || endedKey === trailerKey) return;
    timer.current = setTimeout(() => setShowTrailer(true), TRAILER_DELAY_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [engaged, trailerAutoplay, trailerKey, safeIndex, endedKey]);
  // A new slide may play its trailer again.
  useEffect(() => setEndedKey(null), [safeIndex]);

  /** The trailer only becomes visible once YouTube reports it playing (never its error screen). */
  const [trailerPlaying, setTrailerPlaying] = useState(false);
  useEffect(() => setTrailerPlaying(false), [showTrailer, trailerKey]);
  const giveUpOnTrailer = useCallback(() => {
    if (trailerKey) setEndedKey(trailerKey);
    setShowTrailer(false);
  }, [trailerKey]);
  // No playback within 8 s (blocked embed, offline, configuration error): back to the artwork.
  useEffect(() => {
    if (!showTrailer || trailerPlaying) return;
    const t = setTimeout(giveUpOnTrailer, 8000);
    return () => clearTimeout(t);
  }, [showTrailer, trailerPlaying, giveUpOnTrailer]);

  // Player events: "playing" (1) reveals it, "ended" (0) or any error falls back to the artwork.
  useEffect(() => {
    if (!showTrailer || !trailerKey) return;
    const onMessage = (e: MessageEvent) => {
      if (!YT_ORIGINS.has(e.origin) || e.source !== frame.current?.contentWindow || typeof e.data !== "string") return;
      let msg: { event?: string; info?: unknown };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.event === "onError") {
        giveUpOnTrailer();
        return;
      }
      const info = msg.info as { playerState?: number } | number | undefined;
      const state = msg.event === "onStateChange" ? info : typeof info === "object" ? info?.playerState : undefined;
      if (state === 1) setTrailerPlaying(true);
      if (state === 0) giveUpOnTrailer();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [showTrailer, trailerKey, giveUpOnTrailer]);

  const onTrailerLoad = () => {
    // Subscribe to player events, then apply the current mute choice.
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: "omnia-hero" }), "*");
    ytCommand(frame.current, "addEventListener", ["onStateChange"]);
    ytCommand(frame.current, "addEventListener", ["onError"]);
    if (!muted) ytCommand(frame.current, "unMute");
  };
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    ytCommand(frame.current, next ? "mute" : "unMute");
    if (!next) ytCommand(frame.current, "setVolume", [80]);
  };

  if (!current) {
    return <div className="skeleton h-[68vh] min-h-[520px] w-full max-md:h-[60vh] max-md:min-h-[420px]" />;
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
      className={`relative h-[68vh] min-h-[520px] w-full overflow-hidden max-md:h-[60vh] max-md:min-h-[420px] ${showTrailer && trailerKey && trailerPlaying ? "hero-trailer-on" : ""}`}
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
          className="hero-mask hero-art absolute inset-0 h-full w-full"
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
            // Fully opaque: no mask, no inherited fade (only the bottom edge blends into the rows).
            className="hero-trailer-mask pointer-events-none absolute inset-0 overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: trailerPlaying ? 1 : 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8 }}
          >
            <iframe
              ref={frame}
              title={`${current.title} trailer`}
              src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}&modestbranding=1&playsinline=1&rel=0&iv_load_policy=3&disablekb=1`}
              allow="autoplay; encrypted-media"
              // YouTube refuses embeds that arrive without a referrer ("player configuration
              // error"), e.g. under the LAN companion's strict policy: always send the origin.
              referrerPolicy="strict-origin-when-cross-origin"
              tabIndex={-1}
              onLoad={onTrailerLoad}
              className="absolute left-1/2 top-1/2 h-[140%] w-[140%] -translate-x-1/2 -translate-y-1/2 scale-[1.02]"
            />
          </m.div>
        )}
      </AnimatePresence>

      <div className="hero-scrim absolute inset-0" />

      <div className="hero-copy absolute bottom-[19%] left-[calc(var(--content-left)+8px)] z-20 max-w-[620px] pr-8 max-md:bottom-[13%] max-md:left-4 max-md:pr-4 transition-[left,opacity] duration-500">
        <AnimatePresence mode="wait">
          <m.div
            key={current.id}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
          >
            {badge && <p className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-white/80">{badge}</p>}
            <h1 className="text-balance text-[56px] max-md:text-[32px] font-bold leading-[1.02] tracking-tight drop-shadow-lg">{current.title}</h1>
            <div className="mt-4 flex flex-wrap items-center gap-2.5 text-[14px] text-white/85">
              {d?.certification && <span className="badge">{d.certification}</span>}
              {ratingLabel(current.voteAverage) && <span className="badge !bg-[#01b4e4]/25">TMDB {ratingLabel(current.voteAverage)}</span>}
              {meta.map((x, i) => (
                <span key={i}>{x}</span>
              ))}
            </div>
            <p className="mt-4 line-clamp-3 text-[16px] max-md:line-clamp-2 max-md:text-[14px] leading-relaxed text-white/80">{d?.tagline || current.overview}</p>
            <div className="mt-7 flex flex-wrap items-center gap-3 max-md:mt-4 max-md:gap-2">
              <button className="glass-button-primary !px-7 !py-3 !text-[15px] max-md:!px-5 max-md:!py-2.5" disabled={!d || isLaunching} onClick={() => d && void playTitle(d)}>
                <PlayIcon size={18} /> {isLaunching ? "Opening…" : "Play Now"}
              </button>
              <button className="glass-button !py-3 max-md:!px-4 max-md:!py-2.5" onClick={() => void toggleWatchlist(current)}>
                {listed ? <CheckIcon size={18} /> : <PlusIcon size={18} />} Up Next
              </button>
              <button className="glass-button !py-3 max-md:!px-4 max-md:!py-2.5" onClick={() => openTitle({ id: current.id, mediaType: current.mediaType, seed: current })}>
                More Info
              </button>
            </div>
          </m.div>
        </AnimatePresence>
      </div>

      <div className="absolute bottom-[19%] right-8 z-20 flex items-center gap-3 max-md:bottom-[4%] max-md:right-4">
      <AnimatePresence>
        {showTrailer && trailerKey && (
          <m.button
            key="mute"
            type="button"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            onClick={toggleMute}
            aria-label={muted ? "Unmute trailer" : "Mute trailer"}
            aria-pressed={!muted}
            title={muted ? "Unmute" : "Mute"}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] backdrop-blur-md transition-colors hover:bg-black/55"
          >
            {muted ? <SpeakerMutedIcon size={18} /> : <SpeakerIcon size={18} />}
          </m.button>
        )}
      </AnimatePresence>
      {slides.length > 1 && (
        <div
          className="flex items-center rounded-full bg-black/25 px-1.5 backdrop-blur-md"
          role="tablist"
          aria-label="Featured titles"
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const next = safeIndex + (e.key === "ArrowRight" ? 1 : -1);
            goTo(next);
            const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>("button");
            buttons[((next % slides.length) + slides.length) % slides.length]?.focus();
          }}
        >
          {slides.map((s, i) => {
            const active = i === safeIndex;
            return (
              // The visible dot is tiny; the button around it is a comfortable 24px hit target.
              <button
                key={`${s.mediaType}-${s.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={`Show ${s.title}`}
                title={s.title}
                tabIndex={active ? 0 : -1}
                onClick={() => goTo(i)}
                className="group/dot flex h-6 cursor-pointer items-center px-1 outline-none"
              >
                <span
                  className={`block h-1.5 rounded-full transition-all duration-500 group-focus-visible/dot:ring-2 group-focus-visible/dot:ring-white/70 ${
                    active ? "w-8 bg-white" : "w-1.5 bg-white/45 group-hover/dot:w-3 group-hover/dot:bg-white/80"
                  }`}
                />
              </button>
            );
          })}
        </div>
      )}
      </div>
    </section>
  );
}
