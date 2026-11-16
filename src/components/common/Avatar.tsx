/**
 * Profile avatars. `avatar_asset` stores one of:
 *   - a TMDB image URL (`https://image.tmdb.org/t/p/w185/…`): any actor or character, picked
 *     with the TMDB search in the avatar picker;
 *   - an uploaded image (`data:image/webp;base64,…`): any picture the user picks from disk,
 *     center-cropped to 256×256 and stored locally in the profile row (never uploaded anywhere);
 *   - `char:<name>`: a bundled character (assets/avatars/<name>.svg), the offline defaults;
 *   - a palette id ("aurora"…): the original glossy gradient orb with the profile's initial.
 */
import { useRef, useState } from "react";
import { useAsync, useDebounced } from "../../lib/hooks";
import { fetchAvatarImage } from "../../services/tauriBridge";
import { searchAvatarFaces } from "../../services/tmdbClient";
import { useAppStore } from "../../store/useAppStore";
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

/** Only TMDB's own image host is accepted for photo avatars. */
const TMDB_AVATAR = /^https:\/\/image\.tmdb\.org\/t\/p\/w\d+\/[\w-]+\.(?:jpe?g|png|webp)$/i;
/** Uploaded images: a small inline raster (see `readAvatarFile`). Mirrors the Rust check. */
const UPLOADED_AVATAR = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export const MAX_AVATAR_CHARS = 400_000;
export const isPhotoAvatar = (avatar: string | null | undefined): avatar is string =>
  !!avatar && (TMDB_AVATAR.test(avatar) || (avatar.length <= MAX_AVATAR_CHARS && UPLOADED_AVATAR.test(avatar)));

/** Reads an image file, center-crops it to a 256×256 square and returns a compact data URL. */
export async function readAvatarFile(file: File): Promise<string> {
  if (!/^image\//.test(file.type)) throw new Error("Pick an image file (PNG, JPEG, WebP or GIF).");
  if (file.size > 20 * 1024 * 1024) throw new Error("That image is larger than 20 MB.");
  const url = URL.createObjectURL(file);
  try {
    return await cropAvatar(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Pasted image URL: downloaded once by Rust, then cropped like an upload (stored locally). */
export async function readAvatarUrl(link: string): Promise<string> {
  const trimmed = link.trim();
  if (isPhotoAvatar(trimmed) && trimmed.startsWith("https://image.tmdb.org/")) return trimmed;
  return cropAvatar(await fetchAvatarImage(trimmed));
}

async function cropAvatar(url: string): Promise<string> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("That image couldn't be read."));
    el.src = url;
  });
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  if (!side) throw new Error("That image is empty.");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
  let data = canvas.toDataURL("image/webp", 0.86);
  if (!data.startsWith("data:image/webp")) data = canvas.toDataURL("image/jpeg", 0.86);
  if (data.length > MAX_AVATAR_CHARS) data = canvas.toDataURL("image/jpeg", 0.7);
  return data;
}
export const tmdbAvatarUrl = (profilePath: string) => `https://image.tmdb.org/t/p/w185${profilePath}`;

/** New profiles get a character, rotating so a family's profiles start out distinct. */
export const defaultAvatarFor = (id: number) => characterKeys[id % characterKeys.length]!;

export function Avatar({ name, avatar, size = 96, kids = false }: { name: string; avatar: string | null; size?: number; kids?: boolean }) {
  const photo = isPhotoAvatar(avatar) ? avatar : null;
  const character = photo ? { src: photo, label: "" } : avatar ? AVATAR_CHARACTERS[avatar] : undefined;
  const [a, b] = AVATAR_PALETTES[avatar ?? ""] ?? AVATAR_PALETTES.aurora!;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full align-middle font-semibold leading-none text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: character ? undefined : `radial-gradient(120% 120% at 30% 20%, ${a} 0%, ${b} 70%)`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -10px 24px rgba(0,0,0,0.25), 0 12px 32px rgba(0,0,0,0.45)",
      }}
    >
      {character ? (
        <img src={character.src} alt="" draggable={false} className={`absolute inset-0 block h-full w-full rounded-full object-cover ${photo && !photo.startsWith("data:") ? "object-[center_20%]" : ""}`} />
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

/** "Upload image": any picture from disk (an icon you saved, a photo), stored locally. */
function UploadAvatar({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const toast = useAppStore((s) => s.toast);
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const [fetching, setFetching] = useState(false);
  const uploaded = value.startsWith("data:image/");

  const applyLink = async (raw: string) => {
    const url = raw.trim();
    if (!/^https?:\/\/\S+$/i.test(url) || fetching) return;
    setFetching(true);
    try {
      onChange(await readAvatarUrl(url));
      setLink("");
    } catch (err) {
      toast({ kind: "error", title: "Couldn't use that image link", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="flex w-full max-w-[460px] flex-wrap items-center justify-center gap-3">
      <form
        className="flex min-w-[220px] flex-1 items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void applyLink(link);
        }}
      >
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          // Pasting a link applies it straight away.
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/^\s*https?:\/\//i.test(pasted)) {
              e.preventDefault();
              setLink(pasted.trim());
              void applyLink(pasted);
            }
          }}
          inputMode="url"
          placeholder="…or paste an image URL"
          aria-label="Profile image URL"
          disabled={fetching}
          className="min-w-0 flex-1 rounded-pill bg-white/10 px-4 py-2 text-[13px] outline-none placeholder:text-label-tertiary focus-visible:ring-2 focus-visible:ring-white/70"
        />
        <button type="submit" className="glass-button !px-3 !py-2 text-[13px]" disabled={fetching || !/^https?:\/\/\S+$/i.test(link.trim())}>
          {fetching ? "Loading…" : "Use"}
        </button>
      </form>
      {uploaded && (
        <span className="block h-11 w-11 shrink-0 overflow-hidden rounded-full ring-2 ring-white ring-offset-2 ring-offset-[#121216]">
          <img src={value} alt="" className="block h-full w-full object-cover" />
        </span>
      )}
      <button type="button" className="glass-button !px-4 !py-2 text-[13px]" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Reading…" : uploaded ? "Upload another" : "Upload image"}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          try {
            onChange(await readAvatarFile(file));
          } catch (err) {
            toast({ kind: "error", title: "Couldn't use that image", body: err instanceof Error ? err.message : String(err) });
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

/** TMDB search: any actor, or a character from a movie / series' cast. */
function TmdbAvatarSearch({ value, onChange, ring, centered }: { value: string; onChange: (id: string) => void; ring: (selected: boolean) => string; centered: boolean }) {
  const region = useAppStore((s) => s.region);
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 350);
  const faces = useAsync(() => searchAvatarFaces(q, region), [q, region], tmdbReady && q.length >= 2);
  if (!tmdbReady) return null;
  return (
    <div className={`flex w-full max-w-[460px] flex-col gap-2.5 ${centered ? "items-center" : ""}`}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search an actor, or a show for its characters"
        aria-label="Search TMDB for an avatar"
        className="w-full rounded-pill bg-white/10 px-4 py-2.5 text-[14px] outline-none placeholder:text-label-tertiary focus-visible:ring-2 focus-visible:ring-white/70"
      />
      {q.length >= 2 && (
        <div
          // 3 full rows (3 × 56px + 2 × 10px gaps) plus 8px padding around for rings and hover scale.
          className={`flex max-h-[204px] w-full flex-wrap content-start gap-2.5 overflow-y-auto p-2 ${centered ? "justify-center" : ""}`}
          role="radiogroup"
          aria-label="TMDB avatars"
        >
          {faces.loading && Array.from({ length: 8 }, (_, i) => <span key={i} className="skeleton block aspect-square h-14 w-14 shrink-0 rounded-full" />)}
          {(faces.data ?? []).map((f) => {
            const url = tmdbAvatarUrl(f.profilePath);
            const label = f.character ? `${f.character} (${f.name}${f.from ? `, ${f.from}` : ""})` : f.name;
            return (
              <button
                type="button"
                key={f.key}
                role="radio"
                aria-checked={value === url}
                aria-label={label}
                title={label}
                onClick={() => onChange(url)}
                className={`block aspect-square h-14 w-14 shrink-0 p-0 ${ring(value === url)}`}
              >
                {/* Clip in an inner circle: Chromium leaks corners when overflow + radius + transform share an element. */}
                <span className="block h-full w-full overflow-hidden rounded-full [isolation:isolate]">
                  <img src={url} alt="" loading="lazy" draggable={false} className="block h-full w-full object-cover object-[center_20%]" />
                </span>
              </button>
            );
          })}
          {faces.data && !faces.data.length && !faces.loading && <p className="text-[13px] text-label-secondary">No faces found. Try an actor's name or a show title.</p>}
        </div>
      )}
    </div>
  );
}

/** TMDB photo search, then the bundled characters and colour orbs; used by the profile editor and Settings. */
export function AvatarPicker({ value, onChange, centered = false }: { value: string; onChange: (id: string) => void; centered?: boolean }) {
  const ring = (selected: boolean) =>
    `rounded-full transition-transform hover:scale-110 focus-visible:scale-110 ${selected ? "ring-2 ring-white ring-offset-2 ring-offset-[#121216]" : ""}`;
  return (
    <div className={`flex flex-col gap-3 ${centered ? "items-center" : ""}`}>
      <TmdbAvatarSearch value={value} onChange={onChange} ring={ring} centered={centered} />
      <UploadAvatar value={value} onChange={onChange} />
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
