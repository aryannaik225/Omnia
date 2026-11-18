#!/usr/bin/env node
/**
 * One-off: converts the IMDb Oscar CSV exports to TMDB ids → src/data/oscar_data.json
 *
 *   node scripts/build-oscar-data.mjs
 *
 * Needs TMDB_API_KEY (v3 key or v4 read token) in the environment or in the repo-root .env.
 * Output: { "best_picture": { "<tmdb_id>": <year> }, "general": { "<tmdb_id>": <year> } }
 * `Year` is the film's release year from the CSV (e.g. Nomadland → 2020).
 * Only public IMDb ids are sent to TMDB; no user data is involved.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = {
  best_picture: "imdb_best_picture_oscar_winners_1939-2020.csv",
  general: "imdb_oscar_winning_movies_1969-2020.csv",
};
const OUT = join(ROOT, "src", "data", "oscar_data.json");

// Best Picture winners newer than the CSV export (film year, TMDB movie id).
const RECENT_BEST_PICTURE = [
  { title: "CODA", year: 2021, tmdbId: 776503 },
  { title: "Everything Everywhere All at Once", year: 2022, tmdbId: 545611 },
  { title: "Oppenheimer", year: 2023, tmdbId: 872585 },
  { title: "Anora", year: 2024, tmdbId: 1064213 },
  { title: "One Battle After Another", year: 2025, tmdbId: 1054867 },
];

// Oscar-winning films (any category) newer than / missing from the general CSV export.
// Film year; ids checked against TMDB search by title + year. A CSV year, if present, wins.
const RECENT_GENERAL = [
  // 2025
  { title: "One Battle After Another", year: 2025, tmdbId: 1054867 },
  { title: "Sinners", year: 2025, tmdbId: 1233413 },
  { title: "Frankenstein", year: 2025, tmdbId: 1062722 },
  { title: "KPop Demon Hunters", year: 2025, tmdbId: 803796 },
  { title: "Hamnet", year: 2025, tmdbId: 858024 },
  { title: "Weapons", year: 2025, tmdbId: 1078605 },
  { title: "Sentimental Value", year: 2025, tmdbId: 1124566 },
  { title: "Mr. Nobody Against Putin", year: 2025, tmdbId: 1393151 },
  { title: "All the Empty Rooms", year: 2025, tmdbId: 1525091 },
  { title: "The Singers", year: 2025, tmdbId: 1442908 },
  { title: "Two People Exchanging Saliva", year: 2025, tmdbId: 1340625 },
  { title: "The Girl Who Cried Pearls", year: 2025, tmdbId: 1142149 },
  { title: "F1", year: 2025, tmdbId: 911430 },
  { title: "Avatar: Fire and Ash", year: 2025, tmdbId: 83533 },
  // 2024
  { title: "Anora", year: 2024, tmdbId: 1064213 },
  { title: "The Brutalist", year: 2024, tmdbId: 549509 },
  { title: "Emilia Pérez", year: 2024, tmdbId: 974950 },
  { title: "Wicked", year: 2024, tmdbId: 402431 },
  { title: "Dune: Part Two", year: 2024, tmdbId: 693134 },
  { title: "Conclave", year: 2024, tmdbId: 974576 },
  { title: "The Substance", year: 2024, tmdbId: 933260 },
  { title: "I'm Still Here", year: 2024, tmdbId: 1000837 },
  { title: "Flow", year: 2024, tmdbId: 823219 },
  { title: "A Real Pain", year: 2024, tmdbId: 1013850 },
  { title: "No Other Land", year: 2024, tmdbId: 1232493 },
  { title: "I'm Not a Robot", year: 2024, tmdbId: 1178556 },
  { title: "In the Shadow of the Cypress", year: 2024, tmdbId: 1156619 },
  { title: "The Only Girl in the Orchestra", year: 2024, tmdbId: 1195310 },
  // 2023
  { title: "Oppenheimer", year: 2023, tmdbId: 872585 },
  { title: "Poor Things", year: 2023, tmdbId: 792307 },
  { title: "The Zone of Interest", year: 2023, tmdbId: 467244 },
  { title: "American Fiction", year: 2023, tmdbId: 1056360 },
  { title: "Anatomy of a Fall", year: 2023, tmdbId: 915935 },
  { title: "Barbie", year: 2023, tmdbId: 346698 },
  { title: "The Boy and the Heron", year: 2023, tmdbId: 508883 },
  { title: "Godzilla Minus One", year: 2023, tmdbId: 940721 },
  { title: "The Holdovers", year: 2023, tmdbId: 840430 },
  { title: "The Last Repair Shop", year: 2023, tmdbId: 1171861 },
  { title: "20 Days in Mariupol", year: 2023, tmdbId: 1058616 },
  { title: "War Is Over! Inspired by the Music of John & Yoko", year: 2023, tmdbId: 1214020 },
  { title: "The Wonderful Story of Henry Sugar", year: 2023, tmdbId: 923939 },
  // 2022
  { title: "Everything Everywhere All at Once", year: 2022, tmdbId: 545611 },
  { title: "All Quiet on the Western Front", year: 2022, tmdbId: 49046 },
  { title: "The Whale", year: 2022, tmdbId: 785084 },
  { title: "Top Gun: Maverick", year: 2022, tmdbId: 361743 },
  { title: "Black Panther: Wakanda Forever", year: 2022, tmdbId: 505642 },
  { title: "Avatar: The Way of Water", year: 2022, tmdbId: 76600 },
  { title: "Women Talking", year: 2022, tmdbId: 777245 },
  { title: "Guillermo del Toro's Pinocchio", year: 2022, tmdbId: 555604 },
  { title: "Navalny", year: 2022, tmdbId: 926676 },
  { title: "The Elephant Whisperers", year: 2022, tmdbId: 1041580 },
  { title: "An Irish Goodbye", year: 2022, tmdbId: 889598 },
  { title: "The Boy, the Mole, the Fox and the Horse", year: 2022, tmdbId: 995133 },
  { title: "RRR", year: 2022, tmdbId: 579974 },
  // 2021
  { title: "CODA", year: 2021, tmdbId: 776503 },
  { title: "Dune", year: 2021, tmdbId: 438631 },
  { title: "The Eyes of Tammy Faye", year: 2021, tmdbId: 601470 },
  { title: "No Time to Die", year: 2021, tmdbId: 370172 },
  { title: "The Windshield Wiper", year: 2021, tmdbId: 601329 },
  { title: "The Long Goodbye", year: 2021, tmdbId: 681015 },
  { title: "The Queen of Basketball", year: 2021, tmdbId: 822582 },
  { title: "Summer of Soul", year: 2021, tmdbId: 776527 },
  { title: "Drive My Car", year: 2021, tmdbId: 758866 },
  { title: "Encanto", year: 2021, tmdbId: 568124 },
  { title: "West Side Story", year: 2021, tmdbId: 511809 },
  { title: "Belfast", year: 2021, tmdbId: 777270 },
  { title: "The Power of the Dog", year: 2021, tmdbId: 600583 },
  { title: "King Richard", year: 2021, tmdbId: 614917 },
  { title: "Cruella", year: 2021, tmdbId: 337404 },
  // 2020 (93rd Academy Awards, held 2021)
  { title: "Nomadland", year: 2020, tmdbId: 581734 },
  { title: "The Father", year: 2020, tmdbId: 600354 },
  { title: "Judas and the Black Messiah", year: 2020, tmdbId: 583406 },
  { title: "Minari", year: 2020, tmdbId: 615643 },
  { title: "Mank", year: 2020, tmdbId: 614560 },
  { title: "Sound of Metal", year: 2020, tmdbId: 502033 },
  { title: "Ma Rainey's Black Bottom", year: 2020, tmdbId: 615667 },
  { title: "Promising Young Woman", year: 2020, tmdbId: 582014 },
  { title: "Tenet", year: 2020, tmdbId: 577922 },
  { title: "Soul", year: 2020, tmdbId: 508442 },
  { title: "Another Round", year: 2020, tmdbId: 580175 },
  { title: "My Octopus Teacher", year: 2020, tmdbId: 682110 },
  { title: "Colette", year: 2020, tmdbId: 741845 },
  { title: "If Anything Happens I Love You", year: 2020, tmdbId: 713776 },
  { title: "Two Distant Strangers", year: 2020, tmdbId: 787428 },
];

// ---- TMDB credential ------------------------------------------------------------------------
function tmdbKey() {
  let key = process.env.TMDB_API_KEY?.trim();
  const envFile = join(ROOT, ".env");
  if (!key && existsSync(envFile)) {
    const line = readFileSync(envFile, "utf8").split(/\r?\n/).find((l) => /^\s*(export\s+)?TMDB_API_KEY=/.test(l));
    key = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  }
  if (!key) throw new Error("TMDB_API_KEY not found (environment or .env)");
  return key;
}
const KEY = tmdbKey();
const BEARER = KEY.startsWith("eyJ");

async function tmdb(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!BEARER) url.searchParams.set("api_key", KEY);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json", ...(BEARER ? { Authorization: `Bearer ${KEY}` } : {}) } });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}`);
    return res.json();
  }
  throw new Error(`TMDB rate limit for ${path}`);
}

// ---- CSV (quoted fields with commas / doubled quotes) ---------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

function readList(file) {
  const rows = parseCsv(readFileSync(join(ROOT, file), "utf8").replace(/^﻿/, ""));
  return rows
    .map((r) => ({ imdbId: r.Const, year: Number.parseInt(r.Year, 10), title: r.Title }))
    .filter((r) => /^tt\d+$/.test(r.imdbId) && Number.isFinite(r.year));
}

// ---- IMDb → TMDB ----------------------------------------------------------------------------
const cache = new Map(); // imdbId → tmdbId | null (both lists share many titles)
async function toTmdb(imdbId) {
  if (!cache.has(imdbId)) {
    cache.set(
      imdbId,
      tmdb(`/find/${imdbId}`, { external_source: "imdb_id" }).then((r) => r.movie_results?.[0]?.id ?? null),
    );
  }
  return cache.get(imdbId);
}

async function convert(list, label) {
  const out = {};
  const missing = [];
  const CONCURRENCY = 8;
  let next = 0, done = 0;
  async function worker() {
    while (next < list.length) {
      const item = list[next++];
      const id = await toTmdb(item.imdbId).catch((e) => (console.warn(`  ${item.imdbId}: ${e.message}`), null));
      if (id) out[id] = Math.min(out[id] ?? Infinity, item.year);
      else missing.push(`${item.title} (${item.year}, ${item.imdbId})`);
      if (++done % 50 === 0 || done === list.length) process.stdout.write(`\r  ${label}: ${done}/${list.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write("\n");
  if (missing.length) console.warn(`  ${label}: no TMDB movie for ${missing.length}: ${missing.join("; ")}`);
  return out;
}

const sortById = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => Number(a) - Number(b)));

const result = {};
for (const [tier, file] of Object.entries(SOURCES)) {
  const list = readList(file);
  console.log(`${file}: ${list.length} titles`);
  result[tier] = await convert(list, tier);
}

// Hard-coded recent winners: verify each id still points at the right film, then append.
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
const verified = new Map(); // tmdbId → TMDB title | null
async function checkId(w) {
  if (!verified.has(w.tmdbId)) verified.set(w.tmdbId, tmdb(`/movie/${w.tmdbId}`).then((m) => m.title ?? null, () => null));
  const tmdbTitle = await verified.get(w.tmdbId);
  if (!tmdbTitle || !norm(tmdbTitle).startsWith(norm(w.title).slice(0, 8))) {
    console.warn(`  check TMDB id ${w.tmdbId} for ${w.title}: TMDB says "${tmdbTitle ?? "not found"}"`);
  }
}
for (const w of RECENT_BEST_PICTURE) {
  await checkId(w);
  result.best_picture[w.tmdbId] = w.year;
  result.general[w.tmdbId] ??= w.year;
}
let added = 0;
for (const w of RECENT_GENERAL) {
  await checkId(w);
  if (result.general[w.tmdbId] === undefined) added++;
  result.general[w.tmdbId] ??= w.year;
}
console.log(`  recent general winners: ${RECENT_GENERAL.length} listed, ${added} not already in the data`);

result.best_picture = sortById(result.best_picture);
result.general = sortById(result.general);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result) + "\n");
console.log(`Wrote ${OUT}: ${Object.keys(result.best_picture).length} Best Picture, ${Object.keys(result.general).length} winners`);
