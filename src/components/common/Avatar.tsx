/**
 * Profile avatars. `avatar_asset` stores an avatar id:
 *   - `char:<name>`: a bundled character (assets/avatars/<name>.svg), like Netflix's avatars;
 *   - a palette id ("aurora"…): the original glossy gradient orb with the profile's initial.
 */
import astronaut from "../../../assets/avatars/astronaut.svg";
import cat from "../../../assets/avatars/cat.svg";
import dino from "../../../assets/avatars/dino.svg";
import fox from "../../../assets/avatars/fox.svg";
import ghost from "../../../assets/avatars/ghost.svg";
import owl from "../../../assets/avatars/owl.svg";
import panda from "../../../assets/avatars/panda.svg";
import robot from "../../../assets/avatars/robot.svg";

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

/** Bundled character avatars, keyed by the id stored in `avatar_asset`. */
export const AVATAR_CHARACTERS: Record<string, { src: string; label: string }> = {
  "char:fox": { src: fox, label: "Fox" },
  "char:panda": { src: panda, label: "Panda" },
  "char:robot": { src: robot, label: "Robot" },
  "char:astronaut": { src: astronaut, label: "Astronaut" },
  "char:cat": { src: cat, label: "Cat" },
  "char:owl": { src: owl, label: "Owl" },
  "char:ghost": { src: ghost, label: "Ghost" },
  "char:dino": { src: dino, label: "Dino" },
};

export const avatarKeys = Object.keys(AVATAR_PALETTES);
export const characterKeys = Object.keys(AVATAR_CHARACTERS);

/** New profiles get a character, rotating so a family's profiles start out distinct. */
export const defaultAvatarFor = (id: number) => characterKeys[id % characterKeys.length]!;

export function Avatar({ name, avatar, size = 96, kids = false }: { name: string; avatar: string | null; size?: number; kids?: boolean }) {
  const character = avatar ? AVATAR_CHARACTERS[avatar] : undefined;
  const [a, b] = AVATAR_PALETTES[avatar ?? ""] ?? AVATAR_PALETTES.aurora!;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: character ? undefined : `radial-gradient(120% 120% at 30% 20%, ${a} 0%, ${b} 70%)`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -10px 24px rgba(0,0,0,0.25), 0 12px 32px rgba(0,0,0,0.45)",
      }}
    >
      {character ? (
        <img src={character.src} alt="" draggable={false} className="absolute inset-0 h-full w-full" />
      ) : (
        <span className="drop-shadow">{name.trim().charAt(0).toUpperCase() || "?"}</span>
      )}
      <span className="pointer-events-none absolute inset-x-[12%] top-[6%] h-[38%] rounded-full bg-white/20 blur-[2px]" />
      {kids && (
        <span className="absolute bottom-[6%] rounded-full bg-black/45 px-1.5 text-[10px] font-bold uppercase tracking-wide" style={{ fontSize: Math.max(9, size * 0.11) }}>
          Kids
        </span>
      )}
    </span>
  );
}

/** Characters first, then the colour orbs; used by the profile editor and Settings. */
export function AvatarPicker({ value, onChange, centered = false }: { value: string; onChange: (id: string) => void; centered?: boolean }) {
  const ring = (selected: boolean) =>
    `rounded-full transition-transform hover:scale-110 focus-visible:scale-110 ${selected ? "ring-2 ring-white ring-offset-2 ring-offset-[#121216]" : ""}`;
  return (
    <div className={`flex flex-col gap-3 ${centered ? "items-center" : ""}`}>
      <div className={`flex flex-wrap gap-2.5 ${centered ? "justify-center" : ""}`} role="radiogroup" aria-label="Character avatars">
        {characterKeys.map((k) => (
          <button
            type="button"
            key={k}
            role="radio"
            aria-checked={value === k}
            aria-label={AVATAR_CHARACTERS[k]!.label}
            title={AVATAR_CHARACTERS[k]!.label}
            onClick={() => onChange(k)}
            className={`h-11 w-11 overflow-hidden ${ring(value === k)}`}
          >
            <img src={AVATAR_CHARACTERS[k]!.src} alt="" draggable={false} className="h-full w-full" />
          </button>
        ))}
      </div>
      <div className={`flex flex-wrap gap-2 ${centered ? "justify-center" : ""}`} role="radiogroup" aria-label="Colour avatars">
        {avatarKeys.map((k) => {
          const [a, b] = AVATAR_PALETTES[k]!;
          return (
            <button
              type="button"
              key={k}
              role="radio"
              aria-checked={value === k}
              aria-label={`Colour ${k}`}
              title={`Colour ${k}`}
              onClick={() => onChange(k)}
              className={`h-7 w-7 ${ring(value === k)}`}
              style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}
            />
          );
        })}
      </div>
    </div>
  );
}
