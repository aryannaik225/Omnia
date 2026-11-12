-- Omnia local SQLite schema (migration v1).
-- Every table lives strictly on the user's machine. Nothing here is ever transmitted off-device.

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

-- Secondary indexes for the hot query paths (Continue Watching, recommender scans, cache expiry).
CREATE INDEX IF NOT EXISTS idx_watch_history_profile_recent
    ON watch_history (app_profile_id, last_watched_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_history_title
    ON watch_history (app_profile_id, tmdb_id, media_type);
CREATE INDEX IF NOT EXISTS idx_playback_events_profile_time
    ON playback_events (app_profile_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_playback_events_title
    ON playback_events (app_profile_id, tmdb_id, media_type);
CREATE INDEX IF NOT EXISTS idx_deep_links_expiry
    ON deep_links (expires_at);
CREATE INDEX IF NOT EXISTS idx_ott_mappings_native
    ON ott_profile_mappings (provider_id, ott_native_profile_id);
CREATE INDEX IF NOT EXISTS idx_custom_hubs_order
    ON custom_hubs (sort_order, display_name);
