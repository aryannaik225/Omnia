/**
 * Dynamic ambient bleed: three heavily blurred colour fields sampled from the focused hero
 * artwork, cross-fading slowly whenever the palette changes and drifting gently behind the glass.
 */
import { m } from "framer-motion";
import { rgbVar } from "../../lib/color";
import { useAppStore } from "../../store/useAppStore";

const BLOBS = [
  { className: "left-[-10%] top-[-15%] h-[70vh] w-[60vw]", delay: "0s" },
  { className: "right-[-15%] top-[10%] h-[65vh] w-[55vw]", delay: "-8s" },
  { className: "bottom-[-20%] left-[20%] h-[60vh] w-[60vw]", delay: "-16s" },
];

export function AmbientBackground() {
  const palette = useAppStore((s) => s.ambient);
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink-900">
      {BLOBS.map((b, i) => (
        <m.div
          key={i}
          className={`absolute rounded-full blur-[120px] animate-ambient-drift ${b.className}`}
          style={{ animationDelay: b.delay }}
          animate={{ backgroundColor: `rgba(${rgbVar(palette[i]!)}, ${i === 0 ? 0.42 : 0.32})` }}
          transition={{ duration: 1.8, ease: [0.32, 0.72, 0, 1] }}
        />
      ))}
      {/* Vignette keeps text contrast high at the edges and bottom. */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_10%,transparent_30%,rgba(8,8,12,0.75)_100%)]" />
    </div>
  );
}
