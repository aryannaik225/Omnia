/**
 * Developer Options → Direct Stream Testing: a plain test player for a `.m3u8` (HLS) or
 * `.mp4` URL. Native HLS where the engine has it (Safari, Android WebView), hls.js elsewhere
 * (WebView2), loaded only when a stream is opened. Large buttons, so a TV remote can drive it.
 * Nothing is recorded to watch history.
 */
import { AnimatePresence, m } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDevMode } from "../../services/devMode";
import { CloseIcon, PlayIcon } from "../common/Icons";

type HlsLike = { destroy: () => void };

const fmt = (s: number) => {
  if (!Number.isFinite(s)) return "--:--";
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  return `${h ? `${h}:` : ""}${String(mm).padStart(h ? 2 : 1, "0")}:${String(ss).padStart(2, "0")}`;
};

function Player({ title, initialUrl, onClose }: { title: string; initialUrl: string; onClose: () => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const hls = useRef<HlsLike | null>(null);
  const [url, setUrl] = useState(initialUrl);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(NaN);
  const [muted, setMuted] = useState(false);

  const teardown = useCallback(() => {
    hls.current?.destroy();
    hls.current = null;
    const v = video.current;
    if (v) {
      v.removeAttribute("src");
      v.load();
    }
  }, []);
  useEffect(() => teardown, [teardown]);

  const load = async (src: string) => {
    const v = video.current;
    if (!v) return;
    const trimmed = src.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setError("Enter an http(s) URL to a .m3u8 or .mp4 stream.");
      return;
    }
    setError(null);
    teardown();
    const isHls = /\.m3u8(\?|#|$)/i.test(trimmed) || /mpegurl/i.test(trimmed);
    try {
      if (isHls && !v.canPlayType("application/vnd.apple.mpegurl")) {
        const { default: Hls } = await import("hls.js");
        if (!Hls.isSupported()) throw new Error("HLS isn't supported in this browser.");
        const h = new Hls({ enableWorker: true });
        h.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) setError(`Stream error: ${data.details}`);
        });
        h.loadSource(trimmed);
        h.attachMedia(v);
        hls.current = h;
      } else {
        v.src = trimmed;
      }
      setLoaded(trimmed);
      await v.play().catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (initialUrl) void load(initialUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const v = video.current;
  const seek = (delta: number) => v && (v.currentTime = Math.max(0, Math.min((v.duration || 0) - 1, v.currentTime + delta)));
  const btn = "glass-button !px-4 !py-2.5 text-[14px]";

  return (
    <m.div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 p-4 backdrop-blur-xl" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div role="dialog" aria-label="Stream (Dev) test player" className="glass-panel glass-strong flex w-full max-w-[1100px] flex-col gap-4 p-5">
        <div className="flex items-center gap-3">
          <span className="badge !bg-[#ff9f0a]/20 !text-[#ff9f0a]">DEV</span>
          <h2 className="min-w-0 flex-1 truncate text-[18px] font-semibold">{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close test player">
            <CloseIcon size={18} />
          </button>
        </div>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void load(url);
          }}
        >
          <input
            autoFocus={!initialUrl}
            className="glass-input flex-1 font-mono text-[13px]"
            placeholder="https://example.com/stream/master.m3u8  or  …/video.mp4"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Stream URL"
            spellCheck={false}
          />
          <button type="submit" className="glass-button-primary" disabled={!url.trim()}>
            <PlayIcon size={14} /> Load
          </button>
        </form>
        <div className="relative overflow-hidden rounded-card bg-black" style={{ aspectRatio: "16 / 9" }}>
          <video
            ref={video}
            className="h-full w-full"
            playsInline
            muted={muted}
            onPlay={() => setPaused(false)}
            onPause={() => setPaused(true)}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onDurationChange={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError("The stream couldn't be played (format, CORS or network).")}
          />
          {!loaded && <p className="absolute inset-0 flex items-center justify-center text-label-tertiary">Paste a test stream URL above.</p>}
        </div>
        {error && <p className="text-[13px] text-[#ff6961]">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button className={btn} disabled={!loaded} onClick={() => (paused ? void v?.play() : v?.pause())}>
            {paused ? "Play" : "Pause"}
          </button>
          <button className={btn} disabled={!loaded} onClick={() => seek(-10)}>
            −10s
          </button>
          <button className={btn} disabled={!loaded} onClick={() => seek(30)}>
            +30s
          </button>
          <button className={btn} disabled={!loaded} onClick={() => setMuted((x) => !x)}>
            {muted ? "Unmute" : "Mute"}
          </button>
          <button className={btn} disabled={!loaded} onClick={() => void video.current?.requestFullscreen?.()}>
            Fullscreen
          </button>
          <span className="ml-auto font-mono text-[13px] text-label-secondary">
            {fmt(time)} / {fmt(duration)}
          </span>
        </div>
      </div>
    </m.div>
  );
}

export function DevStreamPlayer() {
  const player = useDevMode((s) => s.player);
  const close = useDevMode((s) => s.closePlayer);
  return <AnimatePresence>{player && <Player key={player.title} title={player.title} initialUrl={player.url} onClose={close} />}</AnimatePresence>;
}
