export const formatRuntime = (mins: number | null | undefined) => {
  if (!mins) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m ? `${m}m` : ""}`.trim() : `${m}m`;
};

export const formatTimeLeft = (progressSeconds: number, durationSeconds: number) => {
  const left = Math.max(0, durationSeconds - progressSeconds);
  if (durationSeconds <= 1) return null;
  const mins = Math.round(left / 60);
  if (mins < 1) return "Almost done";
  if (mins < 60) return `${mins}m left`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m left`;
};

export const episodeLabel = (season: number, episode: number) =>
  season > 0 && episode > 0 ? `S${season} E${episode}` : episode > 0 ? `E${episode}` : null;

export const ratingLabel = (vote: number | null | undefined) => (vote ? vote.toFixed(1) : null);

export const MONETIZATION_LABEL: Record<string, string> = {
  flatrate: "Stream",
  free: "Free",
  ads: "Free with ads",
  rent: "Rent",
  buy: "Buy",
  search: "Find",
};

const regionNames = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
export const regionName = (code: string) => {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
};

// Windows has no flag glyphs: regional indicators would render as plain letters ("IN IN").
const supportsFlags = typeof navigator === "undefined" || !/Windows/i.test(navigator.userAgent);

/** Country code -> flag emoji ("" where the platform can't draw flags). */
export const flag = (code: string) =>
  supportsFlags && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "";

/** Epoch ms of a SQLite UTC datetime ("YYYY-MM-DD HH:MM:SS"), or NaN. */
export const parseSqliteUtc = (sqliteUtc: string) => Date.parse(sqliteUtc.replace(" ", "T") + "Z");

/** Watched within the last `days` days (unparseable timestamps count as recent). */
export const watchedWithinDays = (sqliteUtc: string, days: number) => {
  const t = parseSqliteUtc(sqliteUtc);
  return Number.isNaN(t) || Date.now() - t <= days * 86_400_000;
};

export const relativeTime = (sqliteUtc: string) => {
  const t = parseSqliteUtc(sqliteUtc);
  if (Number.isNaN(t)) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
};
