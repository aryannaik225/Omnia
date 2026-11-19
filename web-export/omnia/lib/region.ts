/**
 * Catalog region for the web app, persisted in localStorage:
 *   1. a manual choice (Region switcher / Settings) always wins;
 *   2. otherwise the server's detection (/app/api/region: Vercel's edge geolocation header, or an
 *      IP-country lookup off Vercel, e.g. on localhost);
 *   3. otherwise the browser's time zone, then its language's region;
 *   4. US only if everything fails.
 * Auto-detected regions are re-checked once per session (VPN on / off, travel).
 */
export type RegionSource = "auto" | "manual";
export interface StoredRegion {
  code: string;
  source: RegionSource;
}

const KEY = "omnia.region.v1";
const CODE = /^[A-Z]{2}$/;
export const FALLBACK_REGION = "US";

export function readStoredRegion(): StoredRegion | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredRegion>;
    if (typeof v.code === "string" && CODE.test(v.code) && (v.source === "auto" || v.source === "manual")) return { code: v.code, source: v.source };
  } catch {
    // Private mode / blocked storage: detect every visit.
  }
  return null;
}

export function storeRegion(r: StoredRegion) {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // ignore
  }
}

/** IANA time zone → country, for the zones most visitors are in (exact match, then city prefix). */
const TZ: Record<string, string> = {
  "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Karachi": "PK", "Asia/Dhaka": "BD", "Asia/Kathmandu": "NP", "Asia/Colombo": "LK",
  "Asia/Dubai": "AE", "Asia/Riyadh": "SA", "Asia/Qatar": "QA", "Asia/Kuwait": "KW", "Asia/Bahrain": "BH", "Asia/Muscat": "OM",
  "Asia/Jerusalem": "IL", "Asia/Tel_Aviv": "IL", "Asia/Tehran": "IR", "Asia/Baghdad": "IQ", "Asia/Amman": "JO", "Asia/Beirut": "LB",
  "Asia/Singapore": "SG", "Asia/Kuala_Lumpur": "MY", "Asia/Jakarta": "ID", "Asia/Makassar": "ID", "Asia/Manila": "PH", "Asia/Bangkok": "TH",
  "Asia/Ho_Chi_Minh": "VN", "Asia/Saigon": "VN", "Asia/Hong_Kong": "HK", "Asia/Taipei": "TW", "Asia/Shanghai": "CN", "Asia/Seoul": "KR",
  "Asia/Tokyo": "JP", "Asia/Almaty": "KZ", "Asia/Tashkent": "UZ", "Asia/Yangon": "MM", "Asia/Phnom_Penh": "KH",
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Lisbon": "PT", "Europe/Madrid": "ES", "Europe/Paris": "FR", "Europe/Brussels": "BE",
  "Europe/Amsterdam": "NL", "Europe/Luxembourg": "LU", "Europe/Berlin": "DE", "Europe/Zurich": "CH", "Europe/Vienna": "AT", "Europe/Rome": "IT",
  "Europe/Copenhagen": "DK", "Europe/Oslo": "NO", "Europe/Stockholm": "SE", "Europe/Helsinki": "FI", "Europe/Warsaw": "PL", "Europe/Prague": "CZ",
  "Europe/Budapest": "HU", "Europe/Bucharest": "RO", "Europe/Sofia": "BG", "Europe/Athens": "GR", "Europe/Istanbul": "TR", "Europe/Kiev": "UA",
  "Europe/Kyiv": "UA", "Europe/Moscow": "RU", "Europe/Belgrade": "RS", "Europe/Zagreb": "HR", "Europe/Bratislava": "SK", "Europe/Ljubljana": "SI",
  "Europe/Vilnius": "LT", "Europe/Riga": "LV", "Europe/Tallinn": "EE", "Atlantic/Reykjavik": "IS", "Europe/Malta": "MT", "Asia/Nicosia": "CY",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Phoenix": "US", "America/Los_Angeles": "US",
  "America/Anchorage": "US", "Pacific/Honolulu": "US", "America/Detroit": "US", "America/Indiana/Indianapolis": "US", "America/Boise": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA", "America/Winnipeg": "CA", "America/Halifax": "CA",
  "America/St_Johns": "CA", "America/Regina": "CA", "America/Montreal": "CA", "America/Mexico_City": "MX", "America/Monterrey": "MX",
  "America/Tijuana": "MX", "America/Cancun": "MX", "America/Bogota": "CO", "America/Lima": "PE", "America/Santiago": "CL",
  "America/Argentina/Buenos_Aires": "AR", "America/Buenos_Aires": "AR", "America/Sao_Paulo": "BR", "America/Manaus": "BR",
  "America/Fortaleza": "BR", "America/Caracas": "VE", "America/Montevideo": "UY", "America/Asuncion": "PY", "America/La_Paz": "BO",
  "America/Guayaquil": "EC", "America/Panama": "PA", "America/Costa_Rica": "CR", "America/Guatemala": "GT", "America/Puerto_Rico": "PR",
  "America/Santo_Domingo": "DO", "America/Jamaica": "JM",
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Brisbane": "AU", "Australia/Perth": "AU", "Australia/Adelaide": "AU",
  "Australia/Hobart": "AU", "Australia/Darwin": "AU", "Pacific/Auckland": "NZ", "Pacific/Fiji": "FJ",
  "Africa/Johannesburg": "ZA", "Africa/Lagos": "NG", "Africa/Cairo": "EG", "Africa/Nairobi": "KE", "Africa/Casablanca": "MA",
  "Africa/Accra": "GH", "Africa/Algiers": "DZ", "Africa/Tunis": "TN", "Africa/Addis_Ababa": "ET", "Africa/Kampala": "UG", "Africa/Dar_es_Salaam": "TZ",
};

/** Country from the browser's time zone (no network). */
export function regionFromTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && TZ[tz] ? TZ[tz] : null;
  } catch {
    return null;
  }
}

/** Country from the browser's languages ("en-IN" → IN), the last offline signal. */
export function regionFromLanguage(): string | null {
  try {
    for (const lang of navigator.languages ?? [navigator.language]) {
      const m = /[-_]([A-Za-z]{2})\b/.exec(lang ?? "");
      if (m) return m[1]!.toUpperCase();
    }
  } catch {
    // ignore
  }
  return null;
}

/** Server-side detection (edge header / IP lookup); null when it can't tell. */
async function regionFromServer(): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("/app/api/region", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = (await res.json()) as { country?: unknown };
    return typeof j.country === "string" && CODE.test(j.country) ? j.country : null;
  } catch {
    return null;
  }
}

/** Best guess of the visitor's country, never failing (US last). */
export async function detectRegion(): Promise<string> {
  return (await regionFromServer()) ?? regionFromTimeZone() ?? regionFromLanguage() ?? FALLBACK_REGION;
}
