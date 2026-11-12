# Omnia

**A universal streaming hub for the desktop.** Omnia brings Netflix, Prime Video, JioHotstar, ZEE5, Sony LIV, Apple TV+, Disney+, Max, Hulu, Peacock and more into one Apple TV–style catalog. It plays titles in a built-in player that remembers exactly where you stopped on every service, and it recommends what to watch next using a model that runs entirely on your machine.

> Everything Omnia knows about you (profiles, watch history, taste vectors, linked accounts) stays in a local SQLite file on your computer. There is no Omnia server, no analytics, and no telemetry.

Built with **Tauri 2 (Rust)**, **React 19 + TypeScript**, **Tailwind CSS** and **Framer Motion**, with a "Liquid Glass" design language inspired by tvOS 26 / macOS 26.

---

## Contents

- [What it does](#what-it-does)
- [Privacy model](#privacy-model)
- [Getting started](#getting-started)
- [Using Omnia](#using-omnia)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [License](#license)

---

## What it does

### One catalog for every service
- Browse trending, popular and critically acclaimed titles for **your region**, with posters, trailers, cast, seasons and episodes from [TMDB](https://www.themoviedb.org/).
- **My Subscriptions only** hides anything you'd have to rent, buy, or get from a service you don't pay for.
- Variants of the same service ("Amazon Prime Video", "Prime Video with Ads", "Amazon Video") are grouped into one **Prime Video** entry. The same applies to the other services.
- **Region / VPN switcher.** On first launch the region is detected from your IP address; switch it manually when you're travelling or on a VPN.

### Direct "Play" buttons
- For each title, Omnia resolves the **exact page on each service** (e.g. `netflix.com/title/…`, `hotstar.com/in/movies/…`) using JustWatch's public API and caches the result locally for 7 days.
- If no direct link exists, it falls back to that service's search page, so Play never dead-ends.

### Built-in player with exact resume
- Titles open in a dedicated **WebView2 player window** (Windows' built-in Edge engine, with Widevine/PlayReady DRM support).
- A small observer script tracks the real `<video>` element: position, pauses, seeks, episode changes and switches to a different title. Progress is saved every few seconds.
- A frosted **"← Omnia" pill** (top-left, appears on mouse movement) or the hotkeys **Ctrl+Shift+O** / **Ctrl+Shift+H** save your exact position, close the player and bring you back to the catalog.
- **Watching Now** shows everything in progress across every service, with exact progress bars.

### Family profiles that stay separate
- A "Who's watching?" screen with per-profile history, watchlist, recommendations and kids mode.
- Each Omnia profile is **linked to its own profile on each service** (e.g. Clara ↔ Clara's Netflix profile).
- Omnia records viewing **only when the linked profile is active**. If someone watches on another person's Netflix profile, nothing is saved anywhere. When it can, Omnia switches the service to the right profile automatically before playing.

### Import your past history
- **Connect Accounts** links your service profile and imports your past viewing (Netflix through its viewing-activity data, Prime Video and others from their history or "Continue Watching" pages).
- Or drop in Netflix's **"Download viewing activity" CSV**, or an Omnia JSON backup.

### On-device recommendations
- A small sentence-embedding model (**all-MiniLM-L6-v2**, run locally via ONNX Runtime) turns each title's plot, genres, keywords, cast, director, studio and mood into a vector.
- Your viewing behaviour shapes your taste profile: finishing titles, **binge sessions** (3+ episodes in one sitting), **rewatching** favourites, **abandoning** titles early, skipping through, and **time of day** (lighter picks late at night, for example).
- Rows come with explanations: *"Because you binged Stranger Things late at night"*, *"Atmospheric Science Fiction matching your taste profile"*, *"Rediscover your Comfort Favorites"*.
- **Settings → Recommendations** shows exactly which titles shape your taste profile, and why.

### Franchise and brand hubs
- Marvel, MCU, DC, Star Wars, Wizarding World, Fast & Furious, MonsterVerse, Middle-earth, James Bond, Anime, Studio Ghibli, Apple Originals, Netflix Exclusives, Prime Video Originals, HBO & Max, Disney & Pixar, Hotstar Specials, A24, Blumhouse, Kids & Family, K-Drama and the Christopher Nolan Collection.
- Filters can be combined: Movies/Series, *Under 90 mins* / *Epic 2.5h+*, era, original language, and Kids & Family safe.
- Hubs are stored as data, so you can add new ones (see [Adding a hub](#adding-a-hub)).

---

## Privacy model

| Data | Where it lives | Leaves your machine? |
|---|---|---|
| Profiles, watch history, playback events, watchlist | Local SQLite (`omnia.db`) | **Never** |
| Taste vectors and recommendation scores | Local SQLite, computed on-device | **Never** |
| Streaming-service cookies (for history import) | WebView2's own cookie store; read into memory only during an import | Only to that service's own website, never logged |
| Title names, for catalog/metadata lookups | — | Sent to TMDB and JustWatch as **anonymous public title strings** |

The only network calls Omnia makes:

- **TMDB**: public catalog metadata, using your API key.
- **JustWatch GraphQL**: public title → deep-link lookups (title, year, region only).
- **ipwho.is / ip-api.com**: one-time region detection; can be overridden manually.
- **Hugging Face and GitHub (Microsoft)**: one-time download of the recommendation model and ONNX Runtime, both pinned to an exact version and verified with SHA-256.
- **youtube-nocookie.com**: trailer previews; can be turned off in Settings.
- **The streaming services themselves**: inside the player, and during history import.

ONNX Runtime's built-in telemetry is explicitly disabled.

---

## Getting started

### Prerequisites

| Tool | Version |
|---|---|
| Windows | 10/11 (the WebView2 runtime ships with Windows 11) |
| [Node.js](https://nodejs.org/) | 20 or newer |
| [Rust](https://rustup.rs/) | stable (1.82+), MSVC toolchain |
| A [TMDB API key](https://www.themoviedb.org/settings/api) | v3 API key **or** v4 read access token |

### Install & run

```sh
git clone https://github.com/aryannaik225/Omnia.git
cd Omnia
npm install

# Add your TMDB key
cp .env.example .env        # then edit .env:  TMDB_API_KEY=your_key_or_token

npm run tauri dev
```

The first `tauri dev` compiles the Rust backend, which takes a few minutes. Later starts are fast.

### First launch

On first launch Omnia:

1. Creates its local database.
2. Detects your region.
3. In the background, downloads the recommendation model (~23 MB) and ONNX Runtime (~83 MB archive; only the 17 MB DLL is kept). Both are verified with SHA-256. Until they're ready, or if they can't be downloaded, recommendations use a built-in offline fallback.

### Production build

```sh
npm run tauri build
```

The installer is written to `src-tauri/target/release/bundle/`.

---

## Using Omnia

1. **Pick or create a profile** on the "Who's watching?" screen. Kids profiles only see family-safe titles, hubs and recommendations.
2. **Settings → My Subscriptions**: tick the services you pay for, then use **My Subscriptions** in the top bar to hide everything else.
3. **Settings → Connect accounts & import**: for each service, click **Connect**, sign in inside Omnia's player and choose *your* profile, then click **Link this profile**. Your past history is imported automatically (Netflix, Prime Video and others), or you can drop in a CSV/JSON file.
4. **Play something.** Open any title and click a service under *Where to watch*, or press Play.
5. **Watch the pill** in the player's top-left corner:
   - 🟢 **green**: viewing is being recorded for your profile.
   - 🟠 **orange**: wrong or unlinked profile on the service; nothing is recorded. If unlinked, click **Link to *you*** in the pill.
   - ⚪ **grey**: verifying the profile or identifying the episode.
6. Press **Ctrl+Shift+O** (or **Ctrl+Shift+H**), or click **← Omnia**, to save your position and return. Your progress appears under **Continue Watching** and **Watching Now**.

---

## How it works

```
┌──────────────────────── Omnia (Tauri 2) ─────────────────────────┐
│                                                                  │
│  Catalog window (React 19)            Player window (WebView2)   │
│  ┌────────────────────────┐           ┌───────────────────────┐  │
│  │ Zustand stores         │  events   │ OTT site (Netflix…)   │  │
│  │ TMDB client            │◄──────────┤ + injected telemetry  │  │
│  │ Liquid Glass UI        │           │   observer + pill     │  │
│  └──────────┬─────────────┘           └──────────┬────────────┘  │
│             │ typed IPC (44 commands)            │ 4 token-gated │
│  ┌──────────▼────────────────────────────────────▼────────────┐  │
│  │ Rust backend                                               │  │
│  │  db/        SQLite (rusqlite, WAL)                         │  │
│  │  resolver/  JustWatch deep links + 7-day cache             │  │
│  │  player/    window manager, profile attribution, hotkeys   │  │
│  │  sync/      cookie-based / in-page history importer        │  │
│  │  ml/        ONNX embeddings, affinity, centroids, MMR      │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Playback tracking and profile isolation
- When you press Play, Rust opens a player window with a small observer script injected. If you've linked a Netflix profile, the window first opens Netflix's **SwitchProfile** link and only opens the title once the right profile is confirmed.
- Every ~3 seconds the script reports position, duration, actual watch time (pauses and buffering excluded), seeks, the detected title/season/episode, and the service's active profile ID.
- Rust compares that profile ID with the one linked in `ott_profile_mappings`. **Nothing is written unless it matches.** It is never attributed to another Omnia profile.
- **Episode accuracy.** For Netflix and Prime Video, series progress is only saved once the service reports the actual season and episode. Omnia never stores its own guess. On Netflix the episode is read from the player's in-memory data, with Netflix's metadata API and the on-screen title as fallbacks.
- **"Completed"** means reaching ~95% or the last two minutes. Restarting a finished title counts as a **rewatch**. Watching 10–25 minutes and not returning for 7 days counts as **abandoned**.

### Security
- Third-party pages run inside player windows, so all backend commands are **denied by default**. The catalog window is granted its commands explicitly (`src-tauri/permissions/omnia.toml`).
- Player and importer windows can reach **only four commands**, and only from a list of known streaming domains (`src-tauri/capabilities/player.json`).
- Every call from the injected script must carry a random secret generated per session.
- Player windows block non-HTTPS navigation.

### Recommendations
1. **Signals.** Per profile: completion, partial progress, binge sessions, abandonment, rewatches, forward-seeking, hours watched, watchlist, and time of day.
2. **Affinity weight per title.** Completed **+1.0**, rewatched (Comfort Favorite) **+2.0**, binge **×1.8**, abandoned **−0.8**, plus smaller terms. Weights fade with a 120-day half-life, so your taste profile keeps up with you.
3. **Taste profile.** A weighted average of the vectors of titles you liked; disliked titles push it away. There is one per time of day, and "what to watch now" blends in the current one.
4. **Candidates.** TMDB titles filtered by region, subscriptions and kids safety, plus genre-targeted, trending and "similar to your favourites" results. Anything you've already watched or saved is excluded.
5. **Ranking.** Cosine similarity, then **MMR** (maximal marginal relevance) to keep each row varied, assembled into the explained rows shown on Home.

The embedding model is `all-MiniLM-L6-v2` (uint8-quantised), with a built-in tokenizer that matches the model's own exactly. ONNX Runtime is **loaded at runtime rather than linked** into the app, so a missing or broken runtime can never stop Omnia from starting. If the model isn't available, a fixed hashing-based fallback is used.

### Local data

| What | Windows location |
|---|---|
| Database | `%APPDATA%\app.omnia.hub\omnia.db` |
| Models & ONNX Runtime | `%APPDATA%\app.omnia.hub\models\` |
| Logs | `%LOCALAPPDATA%\app.omnia.hub\logs\` |

Schema: 11 tables (`app_profiles`, `ott_profile_mappings`, `app_settings`, `subscribed_providers`, `media_catalog`, `deep_links`, `watch_history`, `playback_events`, `media_embeddings`, `custom_hubs`, `watchlist`), all applied by the versioned migrations in `src-tauri/src/db/schema.sql`.

---

## Project structure

```
├── src/                          React 19 + TypeScript frontend
│   ├── App.tsx                   shell: boot → profile gate → catalog
│   ├── components/
│   │   ├── layout/               LiquidSidebar, TopFilterBar, AmbientBackground
│   │   ├── home/                 HeroBillboard, ContinueWatchingRow, BrandHubsRow, MediaCarouselRow
│   │   ├── modals/               MediaDetailModal, AccountSyncModal
│   │   ├── settings/             SettingsView
│   │   ├── profile/              ProfileGate ("Who's watching?")
│   │   ├── views/                Home, Search, Watching Now, My OTTs, Hubs, Watchlist
│   │   └── common/               cards (3D specular hover), grid, toasts, icons, avatars
│   ├── config/hubsRegistry.ts    franchise / studio / originals hub definitions
│   ├── lib/                      colour extraction, provider families, hooks, formatting
│   ├── services/                 tauriBridge (typed IPC), tmdbClient, catalog helpers
│   ├── store/                    useAppStore, usePlayerStore (Zustand)
│   └── styles/liquid-glass.css   design tokens & glass components
│
└── src-tauri/                    Rust backend
    ├── capabilities/             per-window permissions (catalog vs. remote player)
    ├── permissions/omnia.toml    permission sets
    └── src/
        ├── lib.rs                state, commands, hotkeys, startup maintenance
        ├── db/                   connection, migrations, queries
        ├── resolver/justwatch.rs deep-link resolver
        ├── player/               window_manager.rs, telemetry_injector.js
        ├── sync/history_importer.rs
        └── ml/                   embeddings.rs, recommender.rs
```

---

## Development

```sh
npm run tauri dev       # run the desktop app with hot reload
npm run typecheck       # TypeScript
npm run build           # frontend production build

cd src-tauri
cargo test              # backend unit tests
```

**Real ONNX inference test.** This test is skipped by default. To run it, point it at a model folder and an ONNX Runtime DLL:

```sh
OMNIA_MODEL_DIR=/path/to/model OMNIA_ORT_DLL=/path/to/onnxruntime.dll cargo test onnx_model_end_to_end -- --nocapture
```

### Adding a hub
Add an entry to `HUB_REGISTRY` in `src/config/hubsRegistry.ts`. It is seeded into the `custom_hubs` table on startup, and the UI always reads hubs from the database, so rows inserted directly also appear. A rule is a set of TMDB `/discover` parameters per media type, plus optional keyword names (looked up at runtime) and pinned movie collections:

```ts
hub("a24", "A24", "studio", {
  movie: { with_companies: "41077" },
  tv: { with_companies: "41077" },
  tagline: "Bold, singular cinema",
  theme: { from: "#111111", to: "#2d2d2d", accent: "#ffffff" },
}),
```

### Adding a backend command
1. Add a `#[tauri::command]` and register it in `generate_handler!` (`src-tauri/src/lib.rs`).
2. Add its name to `COMMANDS` in `src-tauri/build.rs`.
3. Grant `allow-<command-name>` in `src-tauri/permissions/omnia.toml`.
4. Add a typed wrapper to `src/services/tauriBridge.ts`.

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| "Connect TMDB to start browsing" | `TMDB_API_KEY` is missing from `.env`. Restart `tauri dev` after adding it, or paste a key in Settings → Privacy & Playback. |
| Recommendations say *offline fallback* | Check the logs for `ONNX embeddings unavailable…`. The first-run download may have failed; it retries on next launch. |
| The pill stays orange | The service is on a different or unlinked profile. Switch profiles inside the service, or click **Link to *you*** in the pill. |
| Nothing is tracked in the player | Open the player's DevTools (right-click → Inspect) and run `window.__omniaTelemetry` (should be `true`). Then run `window.__TAURI_INTERNALS__.invoke('sync_playback_telemetry',{payload:{token:'x',kind:'progress'}}).catch(console.log)`. **"unauthorized player session"** is correct. **"not allowed by ACL"** means the site's domain is missing from `capabilities/player.json`. |
| Netflix import fails | The log says whether Netflix's API worked (`Netflix history read via …`) or the in-page fallback ran. Profile errors abort the import on purpose, so histories never mix. |
| A hotkey doesn't work | Another app may own it (check the logs for `could not register global shortcut`). The other hotkey and the pill still work. |

**After upgrading:** Netflix links made before the `guid::name` identity format are removed on first launch (`removed a legacy Netflix link…` in the logs). Re-link Netflix once per Omnia profile.

---

## Known limitations

- **Undocumented service internals.** Netflix's player data and viewing-activity APIs, Prime Video's player and history page structure, and other services' "Continue Watching" rows are not public APIs. They can change without notice; the code isolates each one in an adapter with fallbacks.
- **Automatic profile switching is Netflix-only.** For other services, Omnia verifies the active profile and refuses to record viewing from the wrong one, but you switch profiles yourself.
- **Not available from TMDB:** 4K HDR / Dolby Atmos filters, "Leaving Soon", and IMDb / Rotten Tomatoes ratings. Only TMDB ratings are shown.
- **Windows only for now.** The player relies on WebView2, and the ONNX Runtime auto-download targets Windows x64.
- **No mobile companion.** The planned local-network server for phones is not implemented.

---

## License

[MIT](LICENSE) © 2026 Aryan Naik
