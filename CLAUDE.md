# Omnia — Universal OTT Aggregator, Discovery Engine & Smart Playback Hub

## 1. Project Vision & Core Objective
Build a native, ultra-lightweight desktop application (with a local LAN companion web server for mobile/iOS access) that unifies all streaming services (Netflix, Prime Video, JioHotstar, Zee5, SonyLIV, Apple TV+, Max, Hulu, Disney+, Peacock, etc.) into a single, cohesive experience. 

The application solves three core problems of modern streaming:
1. **Fragmented Discovery:** Eliminates searching Google or jumping between apps to see where a movie or series is streaming.
2. **Broken Cross-App Watch History:** Tracks exact down-to-the-second playback progress, pauses, episode skips, and historical viewing activity across all OTT platforms without relying on unavailable public APIs.
3. **App-Switching Friction:** Launches streams inside a dedicated, low-RAM native WebView2 player window controlled by the main hub, complete with global OS hotkeys and an overlay pill to return instantly to the exact scroll position in the catalog.

---

## 2. Strict Privacy & Zero Data Leakage Architecture (NON-NEGOTIABLE)
This application handles user streaming sessions, viewing habits, and authentication cookies. **Privacy is an absolute architectural constraint:**
- **100% Local-First Execution:** All user watch history, behavioral telemetry, vector embeddings, session tokens, and preferences MUST reside strictly on the user's local machine inside an encrypted/local SQLite database.
- **Zero External Telemetry:** The application must NEVER transmit user viewing history, cookies, credentials, or behavioral weights to any external server, cloud database, or third-party analytics service.
- **Direct Client-to-OTT Communication:** Session cookie extraction and hidden API history syncing happen strictly between the user's local Rust backend and the official OTT provider servers (e.g., `netflix.com`, `primevideo.com`, `hotstar.com`).
- **Cookie Isolation:** Any authentication cookies read from the embedded WebView2 player are used solely in-memory by the local Rust HTTP client to fetch the user's own viewing activity JSON and are never logged in plaintext or exposed to external network interfaces.

---

## 3. Technology Stack
- **Desktop Core & Systems Backend:** Tauri 2.0 (Rust)
- **Frontend Framework:** React 19 + TypeScript + Vite (SPA architecture for instant native rendering)
- **Styling & Motion:** Tailwind CSS + Framer Motion (configured for 2026 Apple TV "Liquid Glass" aesthetics)
- **State Management:** Zustand (UI state, active filters, player state, region settings)
- **Local Database:** SQLite via `rusqlite` + `tokio-rusqlite` (managed in Rust backend for maximum concurrency and speed)
- **Machine Learning / Recommendation Engine:** Local Rust inference via `ort` (ONNX Runtime) using a lightweight sentence-transformer model (`all-MiniLM-L6-v2` quantized) + custom vector cosine similarity engine in Rust
- **HTTP & Scraping (Rust):** `reqwest` (with cookie store & rustls), `scraper`, `serde`, `serde_json`
- **Mobile / iOS Companion Server:** `axum` (embedded in the Rust backend, toggleable on local LAN Wi-Fi so mobile devices on the same network can browse the UI in Safari and trigger iOS Universal Links without installing an app)

---

## 4. UI/UX Design System: 2026 Apple TV "Liquid Glass" (tvOS 26 / macOS 26)
The UI must strictly emulate Apple's 2026 **Liquid Glass** design language introduced in tvOS 26 and macOS 26:

### 4.1 Visual Material & Tokens ("Liquid Glass")
- **Refractive Translucent Surfaces:** Navigation sidebars, floating pills, filter bars, and modal overlays must use multi-layered frosted glass (`backdrop-filter: blur(24px) saturate(180%)`), subtle semi-opaque dark backing layers (`rgba(18, 18, 22, 0.65)`) for guaranteed WCAG 4.5:1 text contrast, and 1px specular top/inner borders (`inset 0 1px 0 rgba(255, 255, 255, 0.22)`).
- **Dynamic Ambient Bleed:** The background of the app dynamically samples the dominant color palette of the currently focused hero artwork or movie backdrop, casting a soft, slow-moving ambient radial glow behind the glass layers.
- **Concentric Geometry:** Consistent Apple-grade border radii (`24px` for large panels/modals, `16px` for poster cards and sidebars, `12px` for buttons and pills).
- **Collapsible Floating Sidebar:** A sleek left-hand Liquid Glass navigation sidebar (Search, Home, WatchNow / Continue Watching, My Library, My OTTs, Franchises & Hubs, Collections, Settings) that refracts scrolling content beneath it and dynamically collapses when scrolling deep into content grids.

### 4.2 Component & Interaction Patterns
- **Full-Bleed Hero Showcase:** Auto-playing muted 4K trailer preview (after a 2-second hover/focus delay) with crisp typography, provider badge ("Included with your JioHotstar subscription"), IMDb/RT/TMDB ratings, maturity badge, and primary "Play Now" + "+ Up Next" Liquid Glass buttons.
- **3D Specular Card Hover:** Movie and series cards (both 16:9 landscape for "Continue Watching" and 2:3 cinematic vertical posters for catalog rows) smoothly scale (`scale(1.06)`) with spring physics, elevate shadow depth, and display a subtle diagonal specular sheen on cursor movement.
- **Rich Detail View:** Full-screen blurred backdrop view with cast carousels (clickable to view actor filmography), season/episode selector with individual episode progress bars, audio/subtitle availability, similar titles, and one-click switching between available OTT providers if a title streams on multiple services.

---

## 5. Comprehensive Feature Specification

### 5.1 Global Multi-Region & Subscription Engine
- **Automatic IP Geolocation + VPN Override:**
  - On first launch, query an IP geolocation endpoint (`ip-api.com/json` or `ipwho.is`) to detect the user's ISO 3166-1 alpha-2 country code (e.g., `IN`, `US`, `GB`, `CA`, `JP`, `DE`).
  - Provide an instant **Region Switcher** in the sidebar/settings so users on a VPN or traveling can manually switch regions (e.g., flipping from India `IN` to United States `US`).
  - Switching regions dynamically updates the available OTT provider list (e.g., surfacing JioHotstar, Zee5, SonyLIV in `IN`; surfacing Max, Hulu, Peacock in `US`) and recalculates catalog availability via TMDB `watch_region`.
- **"My Subscriptions" Filter Toggle:**
  - Users select which OTT platforms they actively pay for.
  - Global toggle between **"My Subscriptions Only"** (strictly hides rent/buy or unsubscribed platforms) and **"All Platforms"** (shows everything available in the region with clear badges).

### 5.2 Brand Hubs, Franchises, Studios & Smart Filters
Dedicated visual "Brand & Franchise Pills" (styled like Apple TV Channels / Disney+ Hubs with custom video/animated hover backgrounds) and combinable multi-facet filters:
- **Franchise & Universe Hubs:**
  - **Marvel Cinematic Universe (MCU) & Marvel Legacy** (mapped via TMDB Company IDs `420`, `7505`, `19551` & Keyword IDs `180547`)
  - **DC Universe (DCU / DC Elseworlds)** (mapped via TMDB Company IDs `9993`, `128064`, `429` & Keyword `dc extended universe` / `dc comics`)
  - **Star Wars, Wizarding World (Harry Potter), Fast & Furious, MonsterVerse, Middle-earth, James Bond, Mission: Impossible (Collection `87359`), The Conjuring Universe (Collections `313086`, `402074`, `968052`), Pokémon (Company `12654` + its movie collections), Anime Hub, Studio Ghibli**
  - Franchise hubs (`order: "release"`) list every title oldest release first; the MCU hub also has a hard-coded `timeline` for a "Timeline Order" toggle.
- **Studio & Network Exclusives / Originals Hubs:**
  - **Apple Originals** (Network `2552` / Provider `350`)
  - **Netflix Exclusives & Originals** (Network `213`)
  - **Prime Video Originals** (Network `1024`)
  - **HBO / Max Originals** (Network `49` / `3186`)
  - **Disney & Pixar** (Company `2`, `3`)
  - **Hotstar Specials / Indian Originals** (Network `3919` / regional original networks)
- **Demographic & Mood Filters:**
  - **Kids & Family Safe Mode** (strictly filters certifications `U`, `G`, `PG`, `TV-Y`, `TV-G`, genres Animation/Family, and excludes adult/horror keywords)
  - **4K HDR / Dolby Atmos Filter**, **Runtime Filter** (e.g., "Under 90 mins", "Epic 2.5h+"), **Release Era**, **Language / Audio Track**, and **Leaving Soon**.
- **Extensible Hub Registry:** Store hub definitions in a clean JSON/SQLite configuration so new hubs (e.g., A24, Blumhouse, K-Drama, Christopher Nolan Collection) can be added dynamically without touching core query logic.

### 5.3 Deep-Link Resolution Engine (Hybrid TMDB + JustWatch GraphQL)
1. **Catalog & Metadata Layer:** Use TMDB API (`/discover`, `/trending`, `/search`, `/movie/{id}/watch/providers`, `/tv/{id}/watch/providers`) for high-speed browsing, posters, logos, trailers, cast, and regional provider availability.
2. **Direct Stream URL Resolver (Rust):**
   - Because TMDB only links to a generic intermediate page, the Rust backend implements a `DeepLinkResolver` module.
   - When a user views or plays a title, Rust queries JustWatch's public GraphQL API (`https://apis.justwatch.com/graphql`) with the title, release year, media type, and active `watch_region`.
   - Extracts the exact `standardWebURL` / deep-link URI for every regional provider (e.g., `https://www.netflix.com/watch/...`, `https://www.hotstar.com/in/movies/...`, `https://www.primevideo.com/detail/...`, `https://www.zee5.com/...`).
   - Caches resolved deep links in the local SQLite `deep_links` table with a 7-day TTL so subsequent clicks are instantaneous (0ms latency).

### 5.4 Native WebView2 Smart Player & Controller Overlay
Instead of opening external bloated Chrome windows or locked UWP Microsoft Store apps, Tauri spawns a dedicated, managed **Player Window**:
1. **Chromeless Native WebView2 Instance:**
   - When the user clicks "Play on [Provider]", Rust spawns a secondary Tauri `WebviewWindow` pointed directly at the resolved deep link.
   - Uses Windows 11's native WebView2 engine (consuming minimal RAM while supporting Widevine/PlayReady DRM playback in Edge WebView2).
2. **Injected DOM Telemetry Script (`initialization_script`):**
   - Tauri automatically injects a lightweight, invisible JavaScript observer into the player WebView2 window upon creation.
   - The script attaches a `MutationObserver` and `timeupdate` / `pause` / `playing` / `ended` listeners directly to the active HTML5 `<video>` element on Netflix, Prime Video, JioHotstar, Zee5, SonyLIV, Apple TV+, etc.
   - Tracks:
     - Exact `currentTime` and `duration` (synced every 3 seconds via `window.__TAURI__.core.invoke('sync_playback_telemetry', payload)`).
     - **Pause State Detection:** Stops incrementing active watch duration the millisecond `video.paused === true`.
     - **Seek / Scrub Detection:** Captures forward/backward jumps (`seeking` / `seeked` events).
     - **In-App Episode / Title Hopping:** Monitors URL changes (`popstate`, `hashchange`, and DOM title node mutations). If the user skips to the next episode or selects a different movie inside Netflix while the player window is open, the injected script extracts the new title/season/episode metadata from the DOM/URL, marks the previous episode complete if applicable, and begins tracking the new item automatically.
3. **Seamless "Back to Hub" Overlay & Global Hotkey:**
   - Registers global OS shortcuts (`Alt + Space` and `Ctrl + Shift + H`) and renders a sleek, auto-hiding Liquid Glass floating pill in the top-left corner of the player window on mouse movement.
   - Clicking "Back to Hub" or pressing the hotkey cleanly closes/pauses the player WebView2, flushes final playback state to SQLite, and restores focus to the main catalog window at the exact scroll position with the "Continue Watching" row already updated.

### 5.5 Zero-Friction Past Watch History Auto-Importer
When a user logs into an OTT platform (Netflix, Prime Video, JioHotstar, etc.) inside the app's WebView2 player or via the "Connect Accounts" settings panel:
1. **Authenticated Session Stays in WebView2:** The profile's isolated WebView2 session is already signed in; provider cookies are never read into Rust. (Netflix rejects non-browser clients, so a Rust `reqwest` client must not be used for OTT history.)
2. **Silent Background History Sync:**
   - A hidden background WebView2 window (in the profile's own data directory) loads the provider, and the injected script fetches the user's past viewing activity from the platform's internal endpoints with genuine in-page `fetch()` calls (e.g., Netflix's `viewingactivity` / Shakti API), falling back to the provider's own history page (captured app requests, embedded React state, hydrated DOM) for Prime Video's watch history, Hotstar's continue-watching state, etc. Results return to Rust over IPC.
3. **Entity Resolution & Matching:**
   - Matches imported title strings and episode numbers against TMDB's search/find endpoints in parallel batches, populates the local `watch_history` table, and immediately seeds the user's taste profile and "Continue Watching" shelf.
   - Also supports manual drag-and-drop CSV/JSON import/export as an offline backup option.
4. **Multi-Profile Mapping & Isolation (The Profile Handshake):**
   - The Tauri app implements its own local profiles (e.g., Aryan, Mom, Dad).
   - When a user connects an OTT account, the WebView2 window stays visible until the OTT's "Who is Watching?" screen is resolved.
   - The injected telemetry script captures the clicked profile's native ID/cookie (e.g., Netflix's `guid` or Prime's `profileId`) and saves an ott_profile_mappings record tying that specific OTT profile to the active Tauri app profile.
   - All background history scraping and playback telemetry strictly filter by this mapped ID to ensure family members' watch histories never contaminate each other's vector embeddings or "Continue Watching" rows.

### 5.6 Next-Gen Local ML Recommendation Engine (Vector + Behavioral)
Move beyond basic genre matching by implementing a multi-layered local recommendation engine in Rust:
1. **Composite "Vibe" Vectors (Local ONNX Embeddings):**
   - Every movie/series is a composite of four separately normalised blocks concatenated with √weight scaling, so the dot product of two titles is exactly `0.40·cos(keywords) + 0.25·cos(director + top 3 cast) + 0.20·cos(genres) + 0.15·cos(plot)` (a block a title lacks contributes 0).
   - Keywords: hashed exact keywords + their words, plus (with the model) a sentence embedding of the keyword list. Auteur: hashed director / creators + top 3 billed cast. Genres: one-hot over the TMDB taxonomy (TV combo genres split onto the movie axes). Plot: local quantized ONNX `all-MiniLM-L6-v2` (via Rust `ort`) embedding of the overview, or hashed term frequency as the fallback.
   - Vectors are stored per profile in `media_embeddings` and, content-only, in `title_vectors` (migration v8) keyed by model and a content hash.
2. **Implicit Behavioral Signal Scoring:**
   - Every user interaction updates an implicit affinity weight $W_i$ for that title:
     - **Binge Velocity Bonus:** Watching 3+ episodes of a series in a single session applies a $+1.8\times$ multiplier.
     - **Completion Rate:** Completing $>85\%$ of runtime (excluding credits) scores $+1.0$.
     - **Early Abandonment Penalty:** Starting a movie/show, watching between 10 and 25 minutes, and abandoning it for $>7$ days applies a $-0.8$ negative weight (teaching the engine what the user dislikes).
     - **Rewatch Signal:** Watching a title more than once (like an annual *Twilight* rewatch) flags it as a "Comfort Favorite" ($+2.0$ weight).
     - **Time-of-Day Contextual Bucketing:** Logs the hour of day (`Morning`, `Afternoon`, `PrimeTime 20:00-23:00`, `LateNight 23:00-04:00`) to compute separate user taste centroids per time window (e.g., lighter sitcoms at night vs. dense sci-fi thrillers on weekends).
3. **Taste Clusters, Nearest Neighbours & MMR Ranking:**
   - "We Think You'll Love These" runs weighted spherical **K-Means** over the profile's liked / watched composite vectors (K = 1 up to 10 titles, 2 up to 30, 3 beyond), searches nearest neighbours around each centroid against candidate pools fetched from TMDB's discovery/trending/recommendation pipelines (filtered by the user's active region and OTT subscriptions), and interleaves the results in proportion to cluster mass (e.g. 7 / 7 / 6). A weighted global centroid and per-time-of-day centroids still drive the contextual rows.
   - The info page's "More Like This" (`get_similar_titles`, sub-second fast path) is a single-title nearest-neighbour search over titles already embedded in `title_vectors` (only the title itself is embedded if needed), followed by TMDB's recommendations / similar titles in their raw order.
   - Applies **Maximal Marginal Relevance (MMR)** to ensure row diversity so recommendations feel fresh, surprising, and hyper-personalized rather than repetitive.
   - Generates dynamic rows with explainable micro-copy: *"Because you binged Stranger Things late at night"*, *"Atmospheric Sci-Fi matching your taste profile"*, *"Rediscover your Comfort Favorites"*.

---

## 6. Complete Local SQLite Database Schema (`schema.sql`)
Initialize and migrate the following tables automatically on app startup:

```sql
-- 1. App-Level User Profiles
CREATE TABLE IF NOT EXISTS app_profiles (
    profile_id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_name TEXT NOT NULL,
    avatar_asset TEXT,
    is_kids_profile BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. OTT Profile Mappings (Ties Tauri Profile to Netflix/Prime Profile IDs)
CREATE TABLE IF NOT EXISTS ott_profile_mappings (
    app_profile_id INTEGER NOT NULL,
    provider_id INTEGER NOT NULL,
    ott_native_profile_id TEXT NOT NULL,
    ott_native_profile_name TEXT,
    PRIMARY KEY (app_profile_id, provider_id),
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);

-- 3. User Settings & Regional Preferences
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Subscribed OTT Providers per Region
CREATE TABLE IF NOT EXISTS subscribed_providers (
    provider_id INTEGER NOT NULL,
    provider_name TEXT NOT NULL,
    logo_path TEXT,
    region_code TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 1,
    PRIMARY KEY (provider_id, region_code)
);

-- 5. Cached Media Metadata (TMDB)
CREATE TABLE IF NOT EXISTS media_catalog (
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
    title TEXT NOT NULL,
    original_title TEXT,
    overview TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    release_year INTEGER,
    runtime_mins INTEGER,
    genres_json TEXT,        
    keywords_json TEXT,      
    credits_json TEXT,       
    vote_average REAL,
    certification TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tmdb_id, media_type)
);

-- 6. Resolved Direct Streaming Deep Links
CREATE TABLE IF NOT EXISTS deep_links (
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    region_code TEXT NOT NULL,
    provider_id INTEGER NOT NULL,
    provider_name TEXT NOT NULL,
    monetization_type TEXT NOT NULL, 
    direct_url TEXT NOT NULL,
    quality TEXT,                    
    expires_at DATETIME,
    resolved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tmdb_id, media_type, region_code, provider_id, monetization_type)
);

-- 7. Granular Watch History & Live Playback Telemetry (Isolated by Profile)
CREATE TABLE IF NOT EXISTS watch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_profile_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    season_number INTEGER DEFAULT 0,
    episode_number INTEGER DEFAULT 0,
    episode_title TEXT,
    provider_name TEXT,
    direct_url TEXT,
    progress_seconds REAL NOT NULL DEFAULT 0,
    duration_seconds REAL NOT NULL DEFAULT 1,
    completion_ratio REAL GENERATED ALWAYS AS (MIN(1.0, progress_seconds / MAX(1.0, duration_seconds))) STORED,
    is_completed BOOLEAN DEFAULT 0,
    watch_count INTEGER DEFAULT 1,
    abandoned BOOLEAN DEFAULT 0,
    last_watched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    time_of_day_bucket TEXT, 
    is_imported BOOLEAN NOT NULL DEFAULT 0, -- migration v4: bulk-imported ("silent") rows feed the recommender and history but not Continue Watching until played in Omnia
    is_manual BOOLEAN NOT NULL DEFAULT 0, -- migration v5: recorded with "Mark as Watched" (cinema, local file, another device)
    UNIQUE(app_profile_id, tmdb_id, media_type, season_number, episode_number),
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);

-- 8. Behavioral Telemetry Events (Isolated by Profile)
CREATE TABLE IF NOT EXISTS playback_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_profile_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    event_type TEXT NOT NULL, 
    session_watch_duration_sec REAL DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);

-- 9. ML Vector Embeddings & Affinity Scores (Isolated by Profile)
CREATE TABLE IF NOT EXISTS media_embeddings (
    app_profile_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    embedding_blob BLOB NOT NULL, 
    computed_affinity_score REAL DEFAULT 0.0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (app_profile_id, tmdb_id, media_type),
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);

-- 10. Custom Franchise & Brand Hubs Configuration
CREATE TABLE IF NOT EXISTS custom_hubs (
    hub_slug TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    category_type TEXT NOT NULL, 
    logo_asset TEXT,
    hero_video_asset TEXT,
    tmdb_filter_Rule_json TEXT NOT NULL, 
    sort_order INTEGER DEFAULT 0
);

-- 11. User Watchlist (Isolated by Profile)
CREATE TABLE IF NOT EXISTS watchlist (
    app_profile_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (app_profile_id, tmdb_id, media_type),
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);

-- 12. Preferred OTT Provider per Title (Isolated by Profile; migration v2)
-- Remembered answer to "Where do you want to watch this?"; provider_id is canonical.
CREATE TABLE IF NOT EXISTS preferred_providers (
    app_profile_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
    provider_id INTEGER NOT NULL,
    provider_name TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (app_profile_id, tmdb_id, media_type),
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);

-- 13. Titles hidden from Continue Watching (Isolated by Profile; migration v3)
-- "Remove from Continue Watching": hidden until watched again after hidden_at; history is kept.
CREATE TABLE IF NOT EXISTS continue_watching_hidden (
    app_profile_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
    hidden_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (app_profile_id, tmdb_id, media_type),
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);
```

Migration v5 also adds (all isolated by profile, `ON DELETE CASCADE`): `favorites (app_profile_id, tmdb_id, media_type, added_at)` — "Love", a +3.0 recommender weight; `collections (collection_id, app_profile_id, name UNIQUE per profile NOCASE, created_at, updated_at)` and `collection_items (collection_id, tmdb_id, media_type, added_at)` — custom lists; `airing_checks (app_profile_id, tmdb_id, checked_at, new_season, new_episode, new_air_date)` — a caught-up airing series with a newly aired episode returns to Continue Watching (re-checked at most every 12 h).

Migration v6 adds `ott_sync_state (app_profile_id, provider_id, last_attempt_at, last_success_at, last_error, last_new_rows)` (isolated by profile): the headless background delta sync (on startup and tray wake) reads only provider activity newer than `last_success_at` (48 h overlap); fresh activity is stored live (`is_imported = 0`) so viewing on other devices reaches Continue Watching.

Migration v7 adds `lan_devices (device_id, device_name, token_hash UNIQUE, paired_at, last_seen_at)`: phones / TVs paired with the LAN companion server. Only the SHA-256 of each device's random 256-bit token is stored.

Migration v8 adds `title_vectors (tmdb_id, media_type, model_id, doc_hash, vector_blob, updated_at)`: content-only composite vectors (never user data), re-embedded when a title's metadata hash changes; vectors from other models are pruned.

**LAN companion & Android TV (Settings → Linked Devices, off by default):** `lan/mobile_server.rs` (axum, `0.0.0.0:8765`) serves the built React app plus `POST /api/invoke/{command}`, an **allow-list** bridge to desktop commands (no profile deletion, history wipes, OTT linking, player, importer or `lan_*` controls; `lan_*` settings are hidden from devices). Unpaired devices only get the pairing page; pairing takes a 6-digit PIN (10-min TTL, rotated after each pairing and after 5 wrong guesses) and returns an `HttpOnly; SameSite=Lax` cookie (browsers; Strict cookies are dropped by Safari on restored tabs) or bearer token (TV). Hosts other than IP literals / `localhost` / `.local` are refused (DNS rebinding); cross-site requests are refused except from the TV app's origin (`http://tauri.localhost`, CORS). UDP `8766` answers `OMNIA_DISCOVER` with the PC's name and port only. On Android, `lib.rs` compiles only `tv_client.rs` (no SQLite / ONNX / axum): the frontend is built with `VITE_OMNIA_THIN_CLIENT=1` (`npm run build:tv`, `tauri.android.conf.json`), talks to the PC over HTTP, and hands "Play" to the installed OTT app via Android intents (`open_in_app`). On iPhone, Play shows a tap-to-open link (Universal Links). `src/services/platform.ts` picks the transport (Tauri IPC / same-origin HTTP / HTTP + bearer); phones and TVs keep their own active profile. See `docs/PHONE_AND_TV.md`.

**Developer Options:** tapping the version in Settings 7 times sets `dev_options_unlocked`; `dev_direct_stream` adds a "Stream (Dev)" button that opens a plain HLS / MP4 test player (hls.js, lazy-loaded). Test streams are never recorded.

**`web-export/`** is the public website, a separate Next.js project deployed to Vercel: the landing page at `/` (static, hourly ISR; reads the latest GitHub release server-side) and a manual tracker at `/app`: the desktop frontend ported into `web-export/omnia/` (same layout as `src/`; keep the two in sync when changing shared UI), TMDB through a server-side proxy, region auto-detected per visitor (`x-vercel-ip-country`, else IP lookup / time zone), guest mode in `localStorage`, optional Supabase sign-in to sync (RLS on every table); desktop-only features show an "Available on Omnia Desktop" badge. It is not part of the desktop build, and the desktop app's privacy rules (Section 2) don't apply to `/app` by design.

**Optional cloud sync (Settings → Sign in to Sync, off by default; see `docs/CLOUD_SYNC.md`):** the one exception to "nothing leaves the PC", and only after the user signs in (Email/Password or Google PKCE via a `127.0.0.1:54365` loopback). `sync/cloud.rs` syncs the linked profile's watchlist and completed movies / episodes (incl. OTT-recorded completions) plus its name and 256×256 WebP picture two-way with Supabase (`supabase/schema.sql`: `profiles`, `watchlist`, `tracked_movies`, `tracked_episodes`, RLS on all, `avatars` bucket). Migration v9 adds `cloud_outbox` + triggers (they fire only for `cloud_sync_profile_id`); pushes carry each change's time as `updated_at`, removals are tombstones (`deleted_at`), the server keeps the newest write and pulls follow server `synced_at`. OTT cookies, telemetry, embeddings and caches never sync. `cloud_*` settings and `tmdb_api_key` are hidden from the UI and LAN devices; the UI reaches TMDB only through the Rust `tmdb_get` command (no key in the JS bundle). `SUPABASE_URL` / `SUPABASE_ANON_KEY` are compiled in by `build.rs`, which rejects secret keys. `.github/workflows/supabase-keep-alive.yml` pings `keep_alive()` every 3 days.

**My Library (desktop & web, same layout):** a Watch Summary bar (Total Days Watched / Movies / Episodes from the runtime recorded with each watch, else TMDB's) above Watchlist · Upcoming · Ongoing Series · Completed Series · Tracked Movies rows (newest first, "Show more" opens a section grid). Desktop: `components/views/LibraryView.tsx` + `components/library/useLibrary.ts` read the profile's SQLite history (`export_watch_history`, OTT-synced and hand-marked alike) and watchlist, joined with TMDB summaries (`services/librarySummary.ts`, 12 h localStorage cache of public metadata). Progress bars: `#0a84ff` while 1–99 %, `#30d158` at 100 %. `lib/releaseStatus.ts` (shared verbatim with `web-export/omnia/lib/`) drives the detail sheet's release card when a title isn't streaming yet. Legal pages: `web-export/app/privacy`, `web-export/app/terms` (keep them in step with any data-handling change).

**Home Page Layout (Settings, desktop & web):** rows after "Browse by service" follow the order in `config/homeLayout.ts` (identical in `src/` and `web-export/omnia/`; never rename an id, append new ones). Stored per profile as setting `home_row_order_p<id>` on the desktop, `localStorage` on the web, and synced as `profiles.home_row_order` (own LWW signature in `sync/cloud.rs`); unknown ids are skipped and kept, new rows append. "In Theatres Now" drops `now_playing` titles that already stream (regional flatrate) or whose regional digital release has passed.

**Browser session isolation:** every OTT webview (player and hidden importer windows) is created with its own WebView2 `data_directory` at `<local app data>/Profiles/<app_profile_id>` (a per-profile `data_store_identifier` on macOS). OTT cookies, cache and storage are never shared between app profiles; a deleted profile's folder is wiped.

---

## 7. Modular Directory Structure

Maintain this exact repository structure:

```text
/
├── CLAUDE.md
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── src/                                  # React + TypeScript Frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── styles/
│   │   └── liquid-glass.css              # Design tokens, refractive blurs, specular borders
│   ├── store/
│   │   ├── useAppStore.ts                # Region, active OTT filters, theme, active hub
│   │   └── usePlayerStore.ts             # Active playback state, overlay visibility
│   ├── services/
│   │   ├── tmdbClient.ts                 # Regional catalog, search, metadata, hub queries
│   │   └── tauriBridge.ts                # Typed wrappers for all Rust #[tauri::command] calls
│   ├── config/
│   │   └── hubsRegistry.ts               # Marvel, DC, Disney, Kids, Apple/Netflix/Prime Originals rules
│   ├── components/
│   │   ├── layout/
│   │   │   ├── LiquidSidebar.tsx         # Collapsible tvOS 26 / macOS 26 glass navigation
│   │   │   ├── TopFilterBar.tsx          # Quick OTT toggles, region badge, search input
│   │   │   └── AmbientBackground.tsx     # Dynamic color extraction & radial canvas bleed
│   │   ├── home/
│   │   │   ├── HeroBillboard.tsx         # 4K trailer preview, provider badge, Play CTA
│   │   │   ├── ContinueWatchingRow.tsx   # Cross-OTT resume cards with exact progress bars
│   │   │   ├── BrandHubsRow.tsx          # Marvel, DC, Disney, Apple/Netflix/Prime cards
│   │   │   └── MediaCarouselRow.tsx      # 3D hover poster carousels (Trending, ML Recommended)
│   │   ├── modals/
│   │   │   ├── MediaDetailModal.tsx      # Episodes, cast, multi-OTT deep-link selector
│   │   │   └── AccountSyncModal.tsx      # One-click OTT login & cookie-based history importer
│   │   └── settings/
│   │       └── SettingsView.tsx          # Region/VPN switcher, OTT subscriptions, LAN server toggle
├── src-tauri/                            # Rust Native Backend
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs                        # Desktop backend or Android thin client (cfg)
│       ├── desktop.rs                    # Command registration & global shortcut initialization
│       ├── tv_client.rs                  # Android TV: LAN discovery + OTT app intents
│       ├── db/
│       │   ├── mod.rs                    # SQLite connection pool & schema migrations
│       │   └── queries.rs                # CRUD for watch_history, deep_links, settings
│       ├── resolver/
│       │   └── justwatch.rs              # GraphQL deep-link resolver for direct OTT stream URLs
│       ├── player/
│       │   ├── window_manager.rs         # Spawns chromeless WebView2 player & overlay pill
│       │   └── telemetry_injector.js     # Injected DOM observer for <video> pause/seek/skip tracking
│       ├── sync/
│       │   ├── history_importer.rs       # Hidden-WebView2 OTT watch history importer & TMDB matcher
│       │   └── cloud.rs                  # Optional opt-in two-way Supabase sync (LWW, tombstones)
│       ├── ml/
│       │   ├── embeddings.rs             # Text feature extraction & ONNX / TF-IDF vectorization
│       │   └── recommender.rs            # Behavioral affinity weights, time-of-day centroids, Cosine + MMR
│       └── lan/
│           └── mobile_server.rs          # Optional local Axum server for zero-install iPhone Safari access
├── docs/PHONE_AND_TV.md                  # LAN pairing, iPhone, Android TV APK build
├── docs/CLOUD_SYNC.md                    # Optional Desktop ⇄ Web sync: setup, privacy boundary
├── docs/RELEASING.md                     # Release checklist: version bumps, parity, checks, tag & publish
├── supabase/schema.sql                   # Idempotent Supabase schema (RLS, avatars bucket, keep-alive)
└── web-export/                           # Website: landing page at /, optional Supabase cloud edition at /app
```

---

## 8. Implementation Standards & Execution Rules

1. **No Placeholders or Mock Stubs:** Every module—including the JustWatch GraphQL query, the injected `<video>` telemetry script, the SQLite schema, the Hub filter mappings, and the cosine similarity recommendation engine—must be written with complete, working logic.
2. **Performance & Low Memory Footprint:** Keep frontend bundle sizes minimal, debounce scroll/search listeners, virtualize long carousels, and properly destroy secondary WebView2 player windows when closed to preserve memory on 8GB RAM systems.
3. **Graceful Fallbacks:** If JustWatch GraphQL does not return a direct deep link for an obscure title, automatically construct a deterministic provider search/watch URL fallback (e.g., `https://www.netflix.com/search?q=...`) so playback never fails.

---

## 9. Release Workflow

Whenever the user asks to prepare a release, cut a release, or bump the version, follow **[`docs/RELEASING.md`](docs/RELEASING.md) step by step**. Don't skip a section, even for a patch release.

- **Version bumps must cover every file in its step 1:** `package.json`, `package-lock.json` (both entries), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and the `FALLBACK` release in `web-export/lib/release.ts`. `release.yml` fails when the tag and the versions disagree.
- **Audit docs and copy parity** (README, `web-export/README.md`, `setup_instructions.txt`, `docs/CLOUD_SYNC.md`, the landing page, `/privacy`, `/terms`) against what actually changed since the last tag. Never advertise a feature, filter or data flow the code doesn't have.
- **Flag schema changes:** if `supabase/schema.sql` changed, tell the user to re-run it in the Supabase SQL Editor before publishing.
- **Run every build check** in its step 4 and report the results honestly.
- **Draft the release notes** with absolute `https://omnia-tv.vercel.app` links and hand them to the user.
- **Never commit, push, tag or delete tags/releases without the user's explicit confirmation for that release.** Approval for one release doesn't carry over to the next. Prepare everything, then stop and ask.