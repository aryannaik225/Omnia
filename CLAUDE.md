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
- **Collapsible Floating Sidebar:** A sleek left-hand Liquid Glass navigation sidebar (Search, Home, WatchNow / Continue Watching, My OTTs, Franchises & Hubs, Watchlist, Settings) that refracts scrolling content beneath it and dynamically collapses when scrolling deep into content grids.

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
  - **Star Wars, Wizarding World (Harry Potter), Fast & Furious, MonsterVerse, Middle-earth, James Bond, Anime Hub, Studio Ghibli**
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
1. **Rich Feature Vectorization (Local ONNX Embeddings):**
   - For every movie/series interacted with or candidate fetched, construct a rich semantic document combining: `Overview + TMDB Keywords + Genres + Director + Top 5 Cast + Production Studios + Mood/Tone descriptors`.
   - Pass this text through a local quantized ONNX embedding model (`all-MiniLM-L6-v2` via Rust `ort`) or TF-IDF + SVD fallback to generate a normalized 384-dimensional float vector stored as a binary BLOB in SQLite (`media_embeddings`).
2. **Implicit Behavioral Signal Scoring:**
   - Every user interaction updates an implicit affinity weight $W_i$ for that title:
     - **Binge Velocity Bonus:** Watching 3+ episodes of a series in a single session applies a $+1.8\times$ multiplier.
     - **Completion Rate:** Completing $>85\%$ of runtime (excluding credits) scores $+1.0$.
     - **Early Abandonment Penalty:** Starting a movie/show, watching between 10 and 25 minutes, and abandoning it for $>7$ days applies a $-0.8$ negative weight (teaching the engine what the user dislikes).
     - **Rewatch Signal:** Watching a title more than once (like an annual *Twilight* rewatch) flags it as a "Comfort Favorite" ($+2.0$ weight).
     - **Time-of-Day Contextual Bucketing:** Logs the hour of day (`Morning`, `Afternoon`, `PrimeTime 20:00-23:00`, `LateNight 23:00-04:00`) to compute separate user taste centroids per time window (e.g., lighter sitcoms at night vs. dense sci-fi thrillers on weekends).
3. **Dynamic User Taste Centroid & MMR Ranking:**
   - Computes the weighted average vector (User Taste Centroid) and performs fast **Cosine Similarity** against candidate pools fetched from TMDB's discovery/trending/similar pipelines filtered by the user's active region and OTT subscriptions.
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
│       ├── lib.rs                        # Command registration & global shortcut initialization
│       ├── db/
│       │   ├── mod.rs                    # SQLite connection pool & schema migrations
│       │   └── queries.rs                # CRUD for watch_history, deep_links, settings
│       ├── resolver/
│       │   └── justwatch.rs              # GraphQL deep-link resolver for direct OTT stream URLs
│       ├── player/
│       │   ├── window_manager.rs         # Spawns chromeless WebView2 player & overlay pill
│       │   └── telemetry_injector.js     # Injected DOM observer for <video> pause/seek/skip tracking
│       ├── sync/
│       │   └── history_importer.rs       # Hidden-WebView2 OTT watch history importer & TMDB matcher
│       ├── ml/
│       │   ├── embeddings.rs             # Text feature extraction & ONNX / TF-IDF vectorization
│       │   └── recommender.rs            # Behavioral affinity weights, time-of-day centroids, Cosine + MMR
│       └── lan/
│           └── mobile_server.rs          # Optional local Axum server for zero-install iPhone Safari access
```

---

## 8. Implementation Standards & Execution Rules

1. **No Placeholders or Mock Stubs:** Every module—including the JustWatch GraphQL query, the injected `<video>` telemetry script, the SQLite schema, the Hub filter mappings, and the cosine similarity recommendation engine—must be written with complete, working logic.
2. **Performance & Low Memory Footprint:** Keep frontend bundle sizes minimal, debounce scroll/search listeners, virtualize long carousels, and properly destroy secondary WebView2 player windows when closed to preserve memory on 8GB RAM systems.
3. **Graceful Fallbacks:** If JustWatch GraphQL does not return a direct deep link for an obscure title, automatically construct a deterministic provider search/watch URL fallback (e.g., `https://www.netflix.com/search?q=...`) so playback never fails.