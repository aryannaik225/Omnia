/**
 * Brand, franchise, studio & originals hubs.
 *
 * Each hub is a declarative TMDB rule. On startup the registry is upserted into the SQLite
 * `custom_hubs` table and the UI always reads hubs back from there, so new hubs (A24, K-Drama,
 * a director collection...) can be added as data — here or straight into the table — without
 * touching query logic.
 *
 * Rule semantics (all optional, per media type):
 *   movie / tv       raw TMDB /discover params (`with_companies`, `with_networks`, `with_keywords`,
 *                    `with_genres`, `with_original_language`, `with_people`, `with_watch_providers`…).
 *                    `|` = OR inside a param; separate params are AND-ed by TMDB.
 *   keywordQueries   keyword names resolved to ids at runtime and OR-ed into `with_keywords`
 *                    (robust against id drift for long-lived franchise keywords).
 *   collections      TMDB movie collection ids whose parts are pinned in release order.
 *   kidsSafe         forces the kids-safe catalog filter for this hub.
 */
import type { CustomHub } from "../services/tauriBridge";

export type HubCategory = "franchise" | "studio" | "originals" | "mood";

export interface HubTheme {
  /** Two gradient stops + accent, used for the pill artwork. */
  from: string;
  to: string;
  accent: string;
}

export interface HubRule {
  movie?: Record<string, string> | null;
  tv?: Record<string, string> | null;
  keywordQueries?: string[];
  collections?: number[];
  kidsSafe?: boolean;
  tagline: string;
  theme: HubTheme;
}

export interface HubDefinition {
  slug: string;
  displayName: string;
  category: HubCategory;
  rule: HubRule;
}

const hub = (slug: string, displayName: string, category: HubCategory, rule: HubRule): HubDefinition => ({
  slug,
  displayName,
  category,
  rule,
});

export const HUB_REGISTRY: HubDefinition[] = [
  // --- Franchises & universes ---------------------------------------------------------------
  hub("marvel", "Marvel", "franchise", {
    movie: { with_companies: "420|7505|19551" },
    tv: { with_companies: "420|7505|19551" },
    tagline: "The MCU and the Marvel legacy",
    theme: { from: "#7a0b0b", to: "#e62429", accent: "#ff6b6b" },
  }),
  hub("mcu", "Marvel Cinematic Universe", "franchise", {
    movie: { with_keywords: "180547" },
    tv: { with_keywords: "180547" },
    tagline: "Every phase, in one place",
    theme: { from: "#3a0a0a", to: "#b3121c", accent: "#ffcc4d" },
  }),
  hub("dc", "DC Universe", "franchise", {
    movie: { with_companies: "9993|128064|429" },
    tv: { with_companies: "9993|128064|429" },
    keywordQueries: [],
    tagline: "DCU, Elseworlds & the Justice League",
    theme: { from: "#04163d", to: "#0476f2", accent: "#7cc4ff" },
  }),
  hub("star-wars", "Star Wars", "franchise", {
    movie: {},
    tv: {},
    keywordQueries: ["star wars"],
    collections: [10],
    tagline: "A galaxy far, far away",
    theme: { from: "#000000", to: "#1c1c1c", accent: "#ffe81f" },
  }),
  hub("wizarding-world", "Wizarding World", "franchise", {
    movie: null,
    tv: {},
    keywordQueries: ["wizarding world"],
    collections: [1241, 435259],
    tagline: "Harry Potter & Fantastic Beasts",
    theme: { from: "#1a1030", to: "#5b3a8c", accent: "#d4af37" },
  }),
  hub("fast-furious", "Fast & Furious", "franchise", {
    collections: [9485],
    tagline: "It's all about family",
    theme: { from: "#1b1b1b", to: "#c2410c", accent: "#fb923c" },
  }),
  hub("monsterverse", "MonsterVerse", "franchise", {
    movie: {},
    tv: {},
    keywordQueries: ["monsterverse"],
    tagline: "Godzilla, Kong & the Titans",
    theme: { from: "#04201b", to: "#0f766e", accent: "#5eead4" },
  }),
  hub("middle-earth", "Middle-earth", "franchise", {
    tv: {},
    keywordQueries: ["middle-earth"],
    collections: [119, 121938],
    tagline: "The Lord of the Rings & The Hobbit",
    theme: { from: "#1f1405", to: "#7c5a1a", accent: "#e9c46a" },
  }),
  hub("james-bond", "James Bond", "franchise", {
    collections: [645],
    tagline: "Licensed to thrill",
    theme: { from: "#0b0b0b", to: "#3f3f46", accent: "#e5e7eb" },
  }),
  hub("anime", "Anime Hub", "franchise", {
    movie: { with_genres: "16", with_original_language: "ja" },
    tv: { with_genres: "16", with_original_language: "ja" },
    tagline: "From shōnen to slice-of-life",
    theme: { from: "#3b0764", to: "#db2777", accent: "#f9a8d4" },
  }),
  hub("studio-ghibli", "Studio Ghibli", "studio", {
    movie: { with_companies: "10342" },
    tagline: "Hand-drawn wonder",
    theme: { from: "#0c4a6e", to: "#38bdf8", accent: "#bbf7d0" },
  }),

  // --- Studio & network originals -------------------------------------------------------------
  hub("apple-originals", "Apple Originals", "originals", {
    movie: { with_watch_providers: "350" },
    tv: { with_networks: "2552" },
    tagline: "Only on Apple TV+",
    theme: { from: "#0a0a0a", to: "#3a3a3c", accent: "#f5f5f7" },
  }),
  hub("netflix-originals", "Netflix Exclusives", "originals", {
    movie: { with_watch_providers: "8" },
    tv: { with_networks: "213" },
    tagline: "Netflix originals & exclusives",
    theme: { from: "#0a0a0a", to: "#7f0d12", accent: "#e50914" },
  }),
  hub("prime-originals", "Prime Video Originals", "originals", {
    movie: { with_watch_providers: "9|119" },
    tv: { with_networks: "1024" },
    tagline: "Amazon Originals",
    theme: { from: "#00111f", to: "#00527a", accent: "#1aa7ec" },
  }),
  hub("hbo-max", "HBO & Max Originals", "originals", {
    movie: { with_watch_providers: "1899|384" },
    tv: { with_networks: "49|3186" },
    tagline: "Prestige television",
    theme: { from: "#090021", to: "#2a1b8a", accent: "#a5b4fc" },
  }),
  hub("disney-pixar", "Disney & Pixar", "studio", {
    movie: { with_companies: "2|3" },
    tv: { with_networks: "2739" },
    tagline: "Timeless animation & adventures",
    theme: { from: "#020b3a", to: "#1e40af", accent: "#93c5fd" },
  }),
  hub("hotstar-specials", "Hotstar Specials", "originals", {
    movie: { with_watch_providers: "122|2336" },
    tv: { with_networks: "3919" },
    tagline: "Indian originals & specials",
    theme: { from: "#04102e", to: "#1f3fbf", accent: "#f9d342" },
  }),
  hub("a24", "A24", "studio", {
    movie: { with_companies: "41077" },
    tv: { with_companies: "41077" },
    tagline: "Bold, singular cinema",
    theme: { from: "#111111", to: "#2d2d2d", accent: "#ffffff" },
  }),
  hub("blumhouse", "Blumhouse", "studio", {
    movie: { with_companies: "3172" },
    tagline: "Modern horror, masterfully made",
    theme: { from: "#0a0000", to: "#450a0a", accent: "#f87171" },
  }),

  // --- Moods, demographics & collections -----------------------------------------------------
  hub("kids-family", "Kids & Family", "mood", {
    movie: { with_genres: "10751|16" },
    tv: { with_genres: "10762|10751" },
    kidsSafe: true,
    tagline: "Safe picks for the whole family",
    theme: { from: "#064e3b", to: "#16a34a", accent: "#fde047" },
  }),
  hub("k-drama", "K-Drama", "mood", {
    tv: { with_original_language: "ko", with_genres: "18" },
    tagline: "Swoon-worthy Korean drama",
    theme: { from: "#3f0d2b", to: "#be185d", accent: "#fbcfe8" },
  }),
  hub("nolan", "Christopher Nolan Collection", "mood", {
    movie: { with_people: "525", sort_by: "primary_release_date.desc" },
    tagline: "Time, memory & spectacle",
    theme: { from: "#0b1220", to: "#334155", accent: "#cbd5e1" },
  }),
];

export const HUB_CATEGORY_LABELS: Record<HubCategory, string> = {
  franchise: "Franchises & Universes",
  studio: "Studios",
  originals: "Originals & Exclusives",
  mood: "Collections & Moods",
};

/** Registry entries in the `custom_hubs` table shape. */
export const registryAsCustomHubs = (): CustomHub[] =>
  HUB_REGISTRY.map((h, i) => ({
    hubSlug: h.slug,
    displayName: h.displayName,
    categoryType: h.category,
    logoAsset: null,
    heroVideoAsset: null,
    tmdbFilterRule: h.rule as unknown as Record<string, unknown>,
    sortOrder: i,
  }));

const DEFAULT_THEME: HubTheme = { from: "#111827", to: "#374151", accent: "#e5e7eb" };

/** Reads a hub row (possibly user-added in SQLite) back into a typed rule with safe defaults. */
export function hubRule(h: CustomHub): HubRule {
  const raw = (h.tmdbFilterRule ?? {}) as Partial<HubRule>;
  return {
    movie: raw.movie,
    tv: raw.tv,
    keywordQueries: raw.keywordQueries ?? [],
    collections: raw.collections ?? [],
    kidsSafe: raw.kidsSafe ?? false,
    tagline: raw.tagline ?? "",
    theme: { ...DEFAULT_THEME, ...(raw.theme ?? {}) },
  };
}
