-- v1.0 personal library: manual tracking, favorites, collections, airing-show returns.

-- "Mark as Watched": rows the user recorded by hand (cinema, a local file, another device).
-- They are ordinary history (recommender, Watch History) and stay visible on Continue Watching.
ALTER TABLE watch_history ADD COLUMN is_manual BOOLEAN NOT NULL DEFAULT 0;

-- "Love": explicit favorites, a strong positive weight for the recommender (Isolated by Profile).
CREATE TABLE IF NOT EXISTS favorites (
    app_profile_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (app_profile_id, tmdb_id, media_type),
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);

-- User-made lists ("Date night", "Best of 2025") (Isolated by Profile).
CREATE TABLE IF NOT EXISTS collections (
    collection_id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_profile_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_profile_name ON collections(app_profile_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS collection_items (
    collection_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (collection_id, tmdb_id, media_type),
    FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_collection_items_title ON collection_items(tmdb_id, media_type);

-- Airing shows: when a caught-up series gets a new episode, it returns to Continue Watching.
-- One row per checked series; new_* is NULL when nothing new has aired. checked_at throttles TMDB.
CREATE TABLE IF NOT EXISTS airing_checks (
    app_profile_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    new_season INTEGER,
    new_episode INTEGER,
    new_air_date TEXT,
    PRIMARY KEY (app_profile_id, tmdb_id),
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);
