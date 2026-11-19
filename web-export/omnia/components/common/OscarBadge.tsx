"use client";
/**
 * Academy Award badge for the movie info page. Data: src/data/oscar_data.json, generated from
 * IMDb lists by scripts/build-oscar-data.mjs (TMDB id → film year, per tier).
 */
import oscarData from "../../data/oscar_data.json";

const BEST_PICTURE = oscarData.best_picture as Record<string, number>;
const GENERAL = oscarData.general as Record<string, number>;

export type OscarHonor = { tier: "best_picture" | "general"; year: number };

export function oscarHonor(tmdbId: number): OscarHonor | null {
  const bp = BEST_PICTURE[tmdbId];
  if (bp) return { tier: "best_picture", year: bp };
  const won = GENERAL[tmdbId];
  return won ? { tier: "general", year: won } : null;
}

function Statuette({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <circle cx="12" cy="3.6" r="2.1" />
      <path d="M10.2 6.4h3.6l.5 4.2-.9 1v6.2h-2.8v-6.2l-.9-1z" />
      <rect x="8.2" y="18.4" width="7.6" height="1.6" rx=".5" />
      <rect x="7.2" y="20.4" width="9.6" height="2" rx=".6" />
    </svg>
  );
}

/** Gold, shimmering for Best Picture; a quieter gold-trimmed glass badge for other wins. */
export function OscarBadge({ tmdbId }: { tmdbId: number }) {
  const honor = oscarHonor(tmdbId);
  if (!honor) return null;
  const best = honor.tier === "best_picture";
  const label = best ? `Oscar Best Picture ${honor.year}` : `Oscar Winner ${honor.year}`;
  return (
    <span className={best ? "oscar-badge oscar-badge-gold" : "oscar-badge"} title={best ? `Academy Award for Best Picture (${honor.year} film)` : `Academy Award winner (${honor.year} film)`}>
      <Statuette />
      {label}
    </span>
  );
}
