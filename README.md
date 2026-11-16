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
- **Exact episodes.** Playing an episode from a series page opens that episode itself (on Netflix, `netflix.com/watch/<episode>`), not the show's landing page.
- **Watching Now** shows everything in progress across every service, with exact progress bars, and your full history, one card per title, with a **platform filter** (each service, or *Offline / Manual*).
- **Airing shows come back.** If you were caught up on a series and a new episode has aired since, it returns to **Continue Watching** with a *New Episode* card that plays that episode.

### Family profiles that stay separate
- A "Who's watching?" screen with per-profile history, watchlist, collections, recommendations and kids mode.
- **Profile pictures:** 8 built-in characters and colours, any actor or character from TMDB (search a show to pick from its cast by character name), an image from your computer, or a pasted image link. Uploaded and linked images are cropped and stored locally.
- Each Omnia profile has its **own browser data** for the services (cookies, sign-ins), so family members never share a session.
- Each Omnia profile is **linked to its own profile on each service** (e.g. Clara ↔ Clara's Netflix profile).
- Omnia records viewing **only when the linked profile is active**. If someone watches on another person's Netflix profile, nothing is saved anywhere. When it can, Omnia switches the service to the right profile automatically before playing.

### Import your past history
- **Connect Accounts** links your service profile and imports your past viewing:
  - **Netflix:** your profile's whole lifetime viewing activity, with real watch dates.
  - **Prime Video:** its watch-history page.
  - **JioHotstar, Apple TV and others:** their "Continue Watching" data, read from the page's own app state and API responses, with the rendered page as a fallback.
- Sign-in is detected automatically on every service. Once you've signed in (and picked your profile, where the service has profiles), the account is linked and the import starts.
- Titles are matched to TMDB strictly. When several titles share a name (*The Traitors* US vs India), Omnia picks the one that service actually carries in your region.
- **Imported history is silent.** It shapes your recommendations and Watch History, but stays off *Continue Watching* until you play the title in Omnia.
- **Background sync for your other devices.** On startup and whenever Omnia comes back from the tray, every linked account is quietly checked in a hidden window. Only activity since the last sync is read (Netflix stops at the first older entry). New viewing, like an episode you watched on your phone, lands in Watch History and Continue Watching. Connect Accounts shows when each account last synced; turn it off in **Settings → Privacy & Playback**.
- **Real watch dates** where the service shows them: Netflix's activity dates, Prime Video's day headings, and dates in other services' app data ("Watched on 14 Nov", "Yesterday", "3 days ago"…). Entries without a date keep the service's own order.
- **Clear by provider.** Delete only one service's history (say, someone else's Prime Video imported by mistake) and keep everything else.
- Or drop in Netflix's **"Download viewing activity" CSV**, or an Omnia JSON backup.

### Your own library
- **Mark as Watched** for movies, single episodes or a whole season: for things you saw in a cinema, from a local file or on another device. Marked titles appear in Watch History and Continue Watching, and count towards recommendations.
- **Love** a title to make it count the most towards your recommendations.
- **Collections**: make your own lists ("Date night", "Best of 2025") and add any movie or series from its page. Everything you've loved is listed there too.

### On-device recommendations
- A small sentence-embedding model (**all-MiniLM-L6-v2**, run locally via ONNX Runtime) turns each title's plot, genres, keywords, cast, director, studio and mood into a vector.
- Your viewing behaviour shapes your taste profile: finishing titles, **binge sessions** (3+ episodes in one sitting), **rewatching** favourites, titles you **love**, **abandoning** titles early, skipping through, and **time of day** (lighter picks late at night, for example).
- Rows come with explanations: *"Because you binged Stranger Things late at night"*, *"Atmospheric Science Fiction matching your taste profile"*, *"Rediscover your Comfort Favorites"*.
- **Settings → Recommendations** shows exactly which titles shape your taste profile, and why.

### Franchise and brand hubs
- Marvel, MCU, DC, Star Wars, Wizarding World, Fast & Furious, MonsterVerse, Middle-earth, James Bond, Anime, Studio Ghibli, Apple Originals, Netflix Exclusives, Prime Video Originals, HBO & Max, Disney & Pixar, Hotstar Specials, A24, Blumhouse, Kids & Family, K-Drama and the Christopher Nolan Collection.
- Filters can be combined: Movies/Series, *Under 90 mins* / *Epic 2.5h+*, era, original language, and Kids & Family safe.
- Hubs are stored as data, so you can add new ones (see [Adding a hub](#adding-a-hub)).

### A proper desktop app
- A system-tray icon, close-to-tray, a single running instance, and the window's size and position remembered between launches.

### On your iPhone and Android TV, still without a cloud
- **Settings → Linked Devices** turns on a small server inside the desktop app, reachable only on your home Wi-Fi. Pair a device once with a **6-digit PIN** or a **QR code**; unpaired devices only ever see the pairing screen, and you can **revoke** any device.
- **iPhone:** open it in Safari (no App Store). The layout adapts to the phone, and **Play** opens the title in the Netflix / Prime / Hotstar app.
- **Android TV / Fire TV:** a thin-client APK finds the PC by itself, is driven entirely with the **D-pad** (with an on-screen keyboard), and hands **Play** to the installed OTT app with an Android intent.
- **Phone as a remote:** the phone's **Remote** tab (D-pad, OK, Back, Home, Play/Pause) drives Omnia on the TV, or on the PC. On the PC it also pauses, plays and skips in Omnia's player.
- What you watch in those apps syncs back to the PC through the background delta sync. See **[docs/PHONE_AND_TV.md](docs/PHONE_AND_TV.md)** for setup and the APK build.

### Hidden developer tools
- Tap the version number at the bottom of Settings **7 times** to unlock **Developer Options**. **Direct Stream Testing** adds a **Stream (Dev)** button to title pages, which opens a plain HLS (`.m3u8`) / MP4 test player.

---

## Privacy model

| Data | Where it lives | Leaves your machine? |
|---|---|---|
| Profiles, watch history, playback events, watchlist | Local SQLite (`omnia.db`) | **Never** |
| Taste vectors and recommendation scores | Local SQLite, computed on-device | **Never** |
| Streaming-service cookies and sign-ins | WebView2's own store, one folder per Omnia profile; Rust never reads them | Only to that service's own website, never logged |
| Profile pictures | Local SQLite (uploaded / linked images are stored as a small local copy) | Never |
| Title names, for catalog/metadata lookups | — | Sent to TMDB and JustWatch as **anonymous public title strings** |
| Your library, read by a paired phone / TV (Linked Devices, off by default) | Stays in the PC's SQLite | Only to devices you paired, over your local network (plain HTTP) |

The only network calls Omnia makes:

- **TMDB**: public catalog metadata, using your API key.
- **JustWatch GraphQL**: public title → deep-link lookups (title, year, region only).
- **ipwho.is / ip-api.com**: one-time region detection; can be overridden manually.
- **Hugging Face and GitHub (Microsoft)**: one-time download of the recommendation model and ONNX Runtime, both pinned to an exact version and verified with SHA-256.
- **youtube-nocookie.com**: trailer previews; can be turned off in Settings.
- **An image link you paste** as a profile picture: downloaded once, from public websites only, without cookies; the picture never loads from that site again.
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
3. **Settings → Connect accounts & import**: for each service, click **Connect**, sign in inside Omnia's player and choose *your* profile. Omnia links it as soon as it sees you're signed in (if you were already signed in, confirm with **Link this profile**), then imports your past history. You can also drop in a CSV/JSON file, or clear one service's history.
4. **Play something.** Open any title and click a service under *Where to watch*, or press Play.
5. **Watch the pill** in the player's top-left corner:
   - 🟢 **green**: viewing is being recorded for your profile.
   - 🟠 **orange**: wrong or unlinked profile on the service; nothing is recorded. If unlinked, click **Link to *you*** in the pill.
   - ⚪ **grey**: verifying the profile or identifying the episode.
6. Press **Ctrl+Shift+O** (or **Ctrl+Shift+H**), or click **← Omnia**, to save your position and return. Your progress appears under **Continue Watching** and **Watching Now**.
7. **Build your library.** On any title page: **Love**, **Mark as Watched** (or the ✓ on each episode), and **Add to Collection**. Your lists live under **Collections** in the sidebar.

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
│             │ typed IPC (76 commands)            │ 5 token-gated │
│  ┌──────────▼────────────────────────────────────▼────────────┐  │
│  │ Rust backend                                               │  │
│  │  db/        SQLite (rusqlite, WAL)                         │  │
│  │  resolver/  JustWatch deep links + 7-day cache             │  │
│  │  player/    window manager, profile attribution, hotkeys   │  │
│  │  sync/      importer, background delta sync, airing shows  │  │
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
- Player and importer windows can reach **only five commands**, and only from a list of known streaming domains (`src-tauri/capabilities/player.json`).
- Every call from the injected script must carry a random secret generated per session.
- Player windows block non-HTTPS navigation.

### Recommendations
1. **Signals.** Per profile: completion, partial progress, binge sessions, abandonment, rewatches, forward-seeking, hours watched, watchlist, and time of day.
2. **Affinity weight per title.** Completed **+1.0**, rewatched (Comfort Favorite) **+2.0**, loved **+3.0**, binge **×1.8**, abandoned **−0.8**, plus smaller terms. Weights fade with a 120-day half-life, so your taste profile keeps up with you; loved and rewatched titles fade much less.
3. **Taste profile.** A weighted average of the vectors of titles you liked; disliked titles push it away. There is one per time of day, and "what to watch now" blends in the current one.
4. **Candidates.** TMDB titles filtered by region, subscriptions and kids safety, plus genre-targeted, trending and "similar to your favourites" results. Anything you've already watched or saved is excluded.
5. **Ranking.** Cosine similarity, then **MMR** (maximal marginal relevance) to keep each row varied, assembled into the explained rows shown on Home.

The embedding model is `all-MiniLM-L6-v2` (uint8-quantised), with a built-in tokenizer that matches the model's own exactly. ONNX Runtime is **loaded at runtime rather than linked** into the app, so a missing or broken runtime can never stop Omnia from starting. If the model isn't available, a fixed hashing-based fallback is used.

### History import
- Imports run in a hidden window that uses the profile's own browser data, so the service only ever sees its normal website. The importer verifies the active service profile before reading anything, and aborts instead of mixing histories.
- **Netflix** pages through the whole viewing-activity list (it can take a few minutes for years of history). Dates are read in the page's own format (day/month in India, month/day in the US).
- Season names like *Stranger Things 4* and episode titles like *Chapter One: …* are matched to TMDB seasons and episodes. An episode that can't be placed is kept under its season rather than dropped.
- Other services: the page's embedded app state and the JSON its app downloads are searched for "Continue Watching" / history sections, falling back to the rendered page. JioHotstar also tries **My Space**.
- Diagnostics go to the local log as counts, page paths and HTTP statuses only, never titles.

### Local data

| What | Windows location |
|---|---|
| Database | `%APPDATA%\app.omnia.hub\omnia.db` |
| Models & ONNX Runtime | `%APPDATA%\app.omnia.hub\models\` |
| Logs | `%LOCALAPPDATA%\app.omnia.hub\logs\` |
| Per-profile browser data (service sign-ins) | `%LOCALAPPDATA%\app.omnia.hub\Profiles\<profile id>\` |

Schema: 18 tables (`ott_sync_state`, `app_profiles`, `ott_profile_mappings`, `app_settings`, `subscribed_providers`, `media_catalog`, `deep_links`, `watch_history`, `playback_events`, `media_embeddings`, `custom_hubs`, `watchlist`, `preferred_providers`, `continue_watching_hidden`, `favorites`, `collections`, `collection_items`, `airing_checks`). They're created by `src-tauri/src/db/schema.sql` and the numbered migrations in `src-tauri/src/db/migrations/`, which run automatically on startup.

---

## Project structure

```
├── src/                          React 19 + TypeScript frontend
│   ├── App.tsx                   shell: boot → profile gate → catalog
│   ├── components/
│   │   ├── layout/               LiquidSidebar, MobileTabBar, TopFilterBar, AmbientBackground
│   │   ├── home/                 HeroBillboard, ContinueWatchingRow, BrandHubsRow, MediaCarouselRow
│   │   ├── modals/               MediaDetailModal, AccountSyncModal, OttPickerModal, HandoffSheet, DevStreamPlayer
│   │   ├── settings/             SettingsView, LinkedDevices (PIN, QR, revoke)
│   │   ├── tv/                   TvConnect (discover / pair / reconnect), VirtualKeyboard
│   │   ├── profile/              ProfileGate ("Who's watching?")
│   │   ├── views/                Home, Search, Watching Now, My OTTs, Hubs, Watchlist, Collections
│   │   └── common/               cards (3D specular hover), grid, toasts, icons, avatars, library actions
│   ├── config/hubsRegistry.ts    franchise / studio / originals hub definitions
│   ├── lib/                      colour extraction, provider families, hooks, formatting, spatialNav (D-pad)
│   ├── services/                 tauriBridge (typed IPC), platform (desktop / LAN / TV transport),
│   │                             handoff (OTT app hand-off), devMode, tmdbClient, catalog helpers
│   ├── store/                    useAppStore, usePlayerStore (Zustand)
│   └── styles/liquid-glass.css   design tokens & glass components
│
├── src-tauri/                    Rust backend
│   ├── capabilities/             per-window permissions (catalog vs. remote player)
│   ├── permissions/omnia.toml    permission sets
│   ├── tauri.android.conf.json   Android TV build (thin-client frontend)
│   └── src/
│       ├── lib.rs                picks the desktop backend or the Android thin client
│       ├── desktop.rs            state, commands, hotkeys, startup maintenance
│       ├── tv_client.rs          Android: LAN discovery + OTT app intents (no database)
│       ├── lan/mobile_server.rs  axum LAN companion: pairing, allow-listed command bridge, static app
│       ├── db/                   connection, migrations, queries
│       ├── resolver/justwatch.rs deep-link resolver
│       ├── player/               window_manager.rs, telemetry_injector.js
│       ├── sync/                 history_importer.rs, background.rs, airing.rs
│       └── ml/                   embeddings.rs, recommender.rs
│
├── docs/PHONE_AND_TV.md          iPhone / Android TV setup and the APK build
└── web-export/                   optional Next.js + Supabase cloud edition (separate project)
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
1. Add a `#[tauri::command]` and register it in `generate_handler!` (`src-tauri/src/desktop.rs`).
2. Add its name to `COMMANDS` in `src-tauri/build.rs`.
3. Grant `allow-<command-name>` in `src-tauri/permissions/omnia.toml`.
4. Add a typed wrapper to `src/services/tauriBridge.ts`.
5. To make it usable from paired phones / TVs, add it to the allow-list in `dispatch` (`src-tauri/src/lan/mobile_server.rs`). Commands not listed there are refused over the LAN.

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| "Connect TMDB to start browsing" | `TMDB_API_KEY` is missing from `.env`. Restart `tauri dev` after adding it, or paste a key in Settings → Privacy & Playback. |
| Recommendations say *offline fallback* | Check the logs for `ONNX embeddings unavailable…`. The first-run download may have failed; it retries on next launch. |
| The pill stays orange | The service is on a different or unlinked profile. Switch profiles inside the service, or click **Link to *you*** in the pill. |
| Nothing is tracked in the player | Open the player's DevTools (right-click → Inspect) and run `window.__omniaTelemetry` (should be `true`). Then run `window.__TAURI_INTERNALS__.invoke('sync_playback_telemetry',{payload:{token:'x',kind:'progress'}}).catch(console.log)`. **"unauthorized player session"** is correct. **"not allowed by ACL"** means the site's domain is missing from `capabilities/player.json`. |
| Netflix import fails | The log line `Netflix history read: …` shows which source worked (Netflix's API, captured requests, or the rendered page). Profile errors abort the import on purpose, so histories never mix. |
| Another service imports nothing | Look for `<service> history read: N entries (page: …, trays found: …, json responses: …)` in the log. It shows where the hidden window ended up (e.g. a sign-in page) and what data it saw. |
| Old imports show "Just now" or are missing shows | They predate the date and season fixes. Clear that service's history in Connect Accounts and import again. |
| A phone / TV can't connect | Settings → Linked Devices must be on, and Windows must allow Omnia on private networks (TCP 8765, UDP 8766). The phone or TV needs to be on the same Wi-Fi, not a guest network. `The Omnia web app isn't built yet` in `tauri dev`: run `npm run build` once (dev builds serve `dist/`). |
| A hotkey doesn't work | Another app may own it (check the logs for `could not register global shortcut`). The other hotkey and the pill still work. |

**After upgrading:** Netflix links made before the `guid::name` identity format are removed on first launch (`removed a legacy Netflix link…` in the logs). Re-link Netflix once per Omnia profile.

---

## Known limitations

- **Undocumented service internals.** Netflix's player data and viewing-activity APIs, Prime Video's player and history page structure, and other services' "Continue Watching" rows are not public APIs. They can change without notice; the code isolates each one in an adapter with fallbacks.
- **Automatic profile switching is Netflix-only.** For other services, Omnia verifies the active profile and refuses to record viewing from the wrong one, but you switch profiles yourself.
- **Not available from TMDB:** 4K HDR / Dolby Atmos filters, "Leaving Soon", and IMDb / Rotten Tomatoes ratings. Only TMDB ratings are shown.
- **Windows only for now.** The player relies on WebView2, and the ONNX Runtime auto-download targets Windows x64.
- **Phones and TVs need the PC running.** They read the PC's library over Wi-Fi; they can't link OTT accounts or import history themselves. The Android TV build hasn't been compiled or tested on a device yet.

---

## License

[MIT](LICENSE) © 2026 Aryan Naik
