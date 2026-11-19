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
 *   order            "release": the whole hub is listed oldest release first (franchises).
 *   timeline         "movie:<id>" / "tv:<id>" keys in story order: adds a Timeline Order toggle.
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
  order?: "release";
  timeline?: string[];
  tagline: string;
  theme: HubTheme;
}

export interface HubDefinition {
  slug: string;
  displayName: string;
  category: HubCategory;
  rule: HubRule;
}

/**
 * MCU story (chronological) order, after Marvel's own Disney+ timeline. TMDB keys; titles the
 * hub lists that aren't here follow in release order.
 */
const MCU_TIMELINE = [
  "movie:1771", // Captain America: The First Avenger
  "movie:299537", // Captain Marvel
  "movie:1726", // Iron Man
  "movie:10138", // Iron Man 2
  "movie:1724", // The Incredible Hulk
  "movie:10195", // Thor
  "movie:24428", // The Avengers
  "movie:76338", // Thor: The Dark World
  "movie:68721", // Iron Man 3
  "movie:100402", // Captain America: The Winter Soldier
  "movie:118340", // Guardians of the Galaxy
  "movie:283995", // Guardians of the Galaxy Vol. 2
  "movie:99861", // Avengers: Age of Ultron
  "movie:102899", // Ant-Man
  "movie:271110", // Captain America: Civil War
  "movie:497698", // Black Widow
  "movie:284054", // Black Panther
  "movie:315635", // Spider-Man: Homecoming
  "movie:284052", // Doctor Strange
  "movie:284053", // Thor: Ragnarok
  "movie:363088", // Ant-Man and the Wasp
  "movie:299536", // Avengers: Infinity War
  "movie:299534", // Avengers: Endgame
  "tv:84958", // Loki
  "tv:91363", // What If...?
  "tv:85271", // WandaVision
  "tv:88396", // The Falcon and the Winter Soldier
  "movie:566525", // Shang-Chi and the Legend of the Ten Rings
  "movie:524434", // Eternals
  "movie:429617", // Spider-Man: Far From Home
  "movie:634649", // Spider-Man: No Way Home
  "movie:453395", // Doctor Strange in the Multiverse of Madness
  "tv:88329", // Hawkeye
  "tv:92749", // Moon Knight
  "movie:505642", // Black Panther: Wakanda Forever
  "tv:122226", // Echo
  "tv:92783", // She-Hulk: Attorney at Law
  "tv:92782", // Ms. Marvel
  "movie:616037", // Thor: Love and Thunder
  "movie:894205", // Werewolf by Night
  "movie:774752", // The Guardians of the Galaxy Holiday Special
  "movie:640146", // Ant-Man and the Wasp: Quantumania
  "movie:447365", // Guardians of the Galaxy Vol. 3
  "tv:114472", // Secret Invasion
  "movie:609681", // The Marvels
  "tv:138501", // Agatha All Along
  "movie:822119", // Captain America: Brave New World
  "movie:986056", // Thunderbolts*
  "tv:202555", // Daredevil: Born Again
  "tv:114471", // Ironheart
  "tv:198178", // Wonder Man
  "movie:533535", // Deadpool & Wolverine
  "movie:617126", // The Fantastic 4: First Steps
];

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
    order: "release",
    tagline: "The MCU and the Marvel legacy",
    theme: { from: "#7a0b0b", to: "#e62429", accent: "#ff6b6b" },
  }),
  hub("mcu", "Marvel Cinematic Universe", "franchise", {
    movie: { with_keywords: "180547" },
    tv: { with_keywords: "180547" },
    timeline: MCU_TIMELINE,
    order: "release",
    tagline: "Every phase, in one place",
    theme: { from: "#3a0a0a", to: "#b3121c", accent: "#ffcc4d" },
  }),
  hub("dc", "DC Universe", "franchise", {
    movie: { with_companies: "9993|128064|429" },
    tv: { with_companies: "9993|128064|429" },
    keywordQueries: [],
    order: "release",
    tagline: "DCU, Elseworlds & the Justice League",
    theme: { from: "#04163d", to: "#0476f2", accent: "#7cc4ff" },
  }),
  hub("star-wars", "Star Wars", "franchise", {
    movie: {},
    tv: {},
    keywordQueries: ["star wars"],
    collections: [10],
    order: "release",
    tagline: "A galaxy far, far away",
    theme: { from: "#000000", to: "#1c1c1c", accent: "#ffe81f" },
  }),
  hub("wizarding-world", "Wizarding World", "franchise", {
    movie: null,
    tv: {},
    keywordQueries: ["wizarding world"],
    collections: [1241, 435259],
    order: "release",
    tagline: "Harry Potter & Fantastic Beasts",
    theme: { from: "#1a1030", to: "#5b3a8c", accent: "#d4af37" },
  }),
  hub("fast-furious", "Fast & Furious", "franchise", {
    collections: [9485],
    order: "release",
    tagline: "It's all about family",
    theme: { from: "#1b1b1b", to: "#c2410c", accent: "#fb923c" },
  }),
  hub("monsterverse", "MonsterVerse", "franchise", {
    movie: {},
    tv: {},
    keywordQueries: ["monsterverse"],
    order: "release",
    tagline: "Godzilla, Kong & the Titans",
    theme: { from: "#04201b", to: "#0f766e", accent: "#5eead4" },
  }),
  hub("middle-earth", "Middle-earth", "franchise", {
    tv: {},
    keywordQueries: ["middle-earth"],
    collections: [119, 121938],
    order: "release",
    tagline: "The Lord of the Rings & The Hobbit",
    theme: { from: "#1f1405", to: "#7c5a1a", accent: "#e9c46a" },
  }),
  hub("james-bond", "James Bond", "franchise", {
    collections: [645],
    order: "release",
    tagline: "Licensed to thrill",
    theme: { from: "#0b0b0b", to: "#3f3f46", accent: "#e5e7eb" },
  }),
  hub("mission-impossible", "Mission: Impossible", "franchise", {
    collections: [87359],
    order: "release",
    tagline: "Should you choose to accept it",
    theme: { from: "#0b0f19", to: "#7f1d1d", accent: "#fca5a5" },
  }),
  hub("conjuring", "The Conjuring Universe", "franchise", {
    // The Conjuring, Annabelle and The Nun films.
    collections: [313086, 402074, 968052],
    order: "release",
    tagline: "From the case files of Ed & Lorraine Warren",
    theme: { from: "#050505", to: "#3b2f2f", accent: "#d6c7a1" },
  }),
  hub("pokemon", "Pokémon", "franchise", {
    movie: { with_companies: "12654" },
    tv: { with_companies: "12654" },
    // Pokémon movie collections: original, Advanced Generation, Best Wishes!, XY, alternate continuity.
    collections: [34055, 661025, 661028, 661029, 661031],
    order: "release",
    tagline: "Gotta catch 'em all",
    theme: { from: "#1e3a8a", to: "#dc2626", accent: "#facc15" },
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
    order: raw.order === "release" ? "release" : undefined,
    timeline: Array.isArray(raw.timeline) ? raw.timeline.filter((k): k is string => typeof k === "string") : undefined,
    tagline: raw.tagline ?? "",
    theme: { ...DEFAULT_THEME, ...(raw.theme ?? {}) },
  };
}
