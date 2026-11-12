/** Profile avatars: glossy gradient orbs keyed by a palette id stored in `avatar_asset`. */
export const AVATAR_PALETTES: Record<string, [string, string]> = {
  aurora: ["#22d3ee", "#6366f1"],
  sunset: ["#fb923c", "#db2777"],
  meadow: ["#4ade80", "#0d9488"],
  orchid: ["#e879f9", "#7c3aed"],
  ember: ["#f87171", "#b91c1c"],
  ocean: ["#38bdf8", "#1d4ed8"],
  gold: ["#fde047", "#d97706"],
  graphite: ["#a1a1aa", "#3f3f46"],
};

export const avatarKeys = Object.keys(AVATAR_PALETTES);

export const defaultAvatarFor = (id: number) => avatarKeys[id % avatarKeys.length]!;

export function Avatar({ name, avatar, size = 96, kids = false }: { name: string; avatar: string | null; size?: number; kids?: boolean }) {
  const [a, b] = AVATAR_PALETTES[avatar ?? ""] ?? AVATAR_PALETTES.aurora!;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `radial-gradient(120% 120% at 30% 20%, ${a} 0%, ${b} 70%)`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -10px 24px rgba(0,0,0,0.25), 0 12px 32px rgba(0,0,0,0.45)",
      }}
    >
      <span className="drop-shadow">{name.trim().charAt(0).toUpperCase() || "?"}</span>
      <span className="pointer-events-none absolute inset-x-[12%] top-[6%] h-[38%] rounded-full bg-white/25 blur-[2px]" />
      {kids && (
        <span className="absolute bottom-[6%] rounded-full bg-black/45 px-1.5 text-[10px] font-bold uppercase tracking-wide" style={{ fontSize: Math.max(9, size * 0.11) }}>
          Kids
        </span>
      )}
    </span>
  );
}
