/**
 * Provider families: TMDB/JustWatch list each monetisation variant as its own provider
 * ("Amazon Prime Video", "Amazon Prime Video with Ads", "Amazon Video", "Netflix basic with Ads"…).
 * The UI shows one entry per family. `canonicalId` mirrors `OttProvider::canonical_id` in Rust,
 * which is the id every OTT profile link is stored under.
 */

export interface ProviderFamily {
  key: string;
  name: string;
  /** Id used for profile links / imports; equals the provider's own id for unknown families. */
  canonicalId: number;
}

interface FamilyRule {
  key: string;
  name: string;
  canonicalId: number;
  ids: number[];
  match: RegExp;
}

// Order matters: Hotstar before Disney ("Disney+ Hotstar"), Prime before generic "amazon".
const FAMILIES: FamilyRule[] = [
  { key: "netflix", name: "Netflix", canonicalId: 8, ids: [8, 175, 1796], match: /netflix/i },
  { key: "hotstar", name: "JioHotstar", canonicalId: 122, ids: [122, 220, 2336], match: /hotstar|jiocinema/i },
  { key: "primevideo", name: "Prime Video", canonicalId: 9, ids: [9, 10, 119, 2100, 613], match: /prime video|amazon prime|amazon video/i },
  { key: "disneyplus", name: "Disney+", canonicalId: 337, ids: [337], match: /disney/i },
  { key: "appletv", name: "Apple TV", canonicalId: 350, ids: [2, 350], match: /apple tv|itunes/i },
  { key: "zee5", name: "ZEE5", canonicalId: 232, ids: [232], match: /zee5/i },
  { key: "sonyliv", name: "Sony LIV", canonicalId: 237, ids: [237], match: /sony ?liv/i },
  { key: "hbomax", name: "HBO Max", canonicalId: 1899, ids: [1899, 384], match: /hbo|^max\b/i },
  { key: "hulu", name: "Hulu", canonicalId: 15, ids: [15], match: /hulu/i },
  { key: "peacock", name: "Peacock", canonicalId: 386, ids: [386, 387], match: /peacock/i },
  { key: "paramountplus", name: "Paramount+", canonicalId: 531, ids: [531, 582, 1853], match: /paramount/i },
  { key: "crunchyroll", name: "Crunchyroll", canonicalId: 283, ids: [283, 1968], match: /crunchyroll/i },
  { key: "youtube", name: "YouTube", canonicalId: 192, ids: [192, 188, 235], match: /youtube/i },
  { key: "googleplay", name: "Google Play Movies", canonicalId: 3, ids: [3], match: /google play/i },
  { key: "mubi", name: "MUBI", canonicalId: 11, ids: [11], match: /mubi/i },
];

/** Reseller channels ("MUBI Amazon Channel") belong to the brand, not the store. */
const CHANNEL_SUFFIX = /\s+(amazon channel|apple tv channel|roku premium channel)$/i;
/** Monetisation / tier variants of the same service. */
const VARIANT_SUFFIX = /\s+(free with ads|with ads|basic with ads|standard with ads|kids|premium|store)$/i;

const cache = new Map<string, ProviderFamily>();

export function providerFamily(providerId: number, providerName: string): ProviderFamily {
  const cacheKey = `${providerId}|${providerName}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const isChannel = CHANNEL_SUFFIX.test(providerName.trim());
  let base = providerName.trim().replace(CHANNEL_SUFFIX, "");
  // A channel resold through Amazon/Apple is matched on its own brand, never the store's id.
  const byId = isChannel ? undefined : FAMILIES.find((f) => f.ids.includes(providerId));
  const rule = byId ?? FAMILIES.find((f) => f.match.test(base));
  let family: ProviderFamily;
  if (rule) {
    family = { key: rule.key, name: rule.name, canonicalId: rule.canonicalId };
  } else {
    while (VARIANT_SUFFIX.test(base)) base = base.replace(VARIANT_SUFFIX, "");
    family = { key: `n:${base.toLowerCase().replace(/[^a-z0-9]+/g, "")}`, name: base, canonicalId: providerId };
  }
  cache.set(cacheKey, family);
  return family;
}

export interface GroupedProvider<T> {
  family: ProviderFamily;
  /** Members ordered as given (e.g. by regional prominence); the first is the representative. */
  members: T[];
}

/** Groups any provider-like list by family, keeping first-seen order. */
export function groupByFamily<T>(items: T[], idOf: (t: T) => number, nameOf: (t: T) => string): GroupedProvider<T>[] {
  const groups = new Map<string, GroupedProvider<T>>();
  for (const item of items) {
    const family = providerFamily(idOf(item), nameOf(item));
    const existing = groups.get(family.key);
    if (existing) existing.members.push(item);
    else groups.set(family.key, { family, members: [item] });
  }
  return [...groups.values()];
}
