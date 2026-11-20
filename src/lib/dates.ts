/** Calendar-day helpers for air / release dates (shared with web-export/lib/media.ts). */

/** TMDB air dates are calendar days; treat them as local midnight. */
export const parseDay = (d: string | null | undefined) => {
  if (!d) return null;
  const [y, m, day] = d.split("-").map(Number);
  return y && m && day ? new Date(y, m - 1, day) : null;
};

export const isAired = (d: string | null | undefined, now = new Date()) => {
  const day = parseDay(d);
  return !!day && day.getTime() <= now.getTime();
};

/** Whole days from today until the date (0 = today, negative = past). */
export function daysUntil(d: string | null | undefined, now = new Date()): number | null {
  const day = parseDay(d);
  if (!day) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((day.getTime() - today.getTime()) / 86_400_000);
}

export function countdownLabel(d: string | null | undefined): string | null {
  const n = daysUntil(d);
  if (n == null) return null;
  if (n < 0) return "Out now";
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n < 7) return `In ${n} days`;
  if (n < 60) return `In ${Math.round(n / 7)} week${Math.round(n / 7) === 1 ? "" : "s"}`;
  return `In ${Math.round(n / 30)} months`;
}

export const formatDay = (d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) => {
  const day = parseDay(d);
  return day ? day.toLocaleDateString("en-GB", opts) : null;
};
