-- Migration v9: optional two-way cloud sync (Settings → Sign in to Sync; off by default).
--
-- Only the profile linked to the cloud account (app_settings.cloud_sync_profile_id) is synced,
-- and only lightweight tracking state: watchlist entries, completed movies and completed
-- episodes. These triggers record *which* item changed and *when* into a local outbox; the sync
-- (src-tauri/src/sync/cloud.rs) reads the current local state of each item when it pushes, so a
-- removal becomes a tombstone and every change carries its real time for last-write-wins.
-- While nobody is signed in the triggers' WHEN clauses never match and the outbox stays empty.
-- OTT sessions, playback telemetry, embeddings and metadata caches are never involved.

CREATE TABLE IF NOT EXISTS cloud_outbox (
    kind TEXT NOT NULL CHECK(kind IN ('watchlist', 'movie', 'episode')),
    app_profile_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
    season_number INTEGER NOT NULL DEFAULT 0,
    episode_number INTEGER NOT NULL DEFAULT 0,
    changed_at TEXT NOT NULL,
    PRIMARY KEY (kind, app_profile_id, tmdb_id, media_type, season_number, episode_number),
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);

-- Watchlist ---------------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS cloud_watchlist_insert AFTER INSERT ON watchlist
WHEN EXISTS (SELECT 1 FROM app_settings WHERE key = 'cloud_sync_profile_id' AND value = CAST(NEW.app_profile_id AS TEXT))
BEGIN
    INSERT OR REPLACE INTO cloud_outbox (kind, app_profile_id, tmdb_id, media_type, season_number, episode_number, changed_at)
    VALUES ('watchlist', NEW.app_profile_id, NEW.tmdb_id, NEW.media_type, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER IF NOT EXISTS cloud_watchlist_delete AFTER DELETE ON watchlist
WHEN EXISTS (SELECT 1 FROM app_settings WHERE key = 'cloud_sync_profile_id' AND value = CAST(OLD.app_profile_id AS TEXT))
BEGIN
    INSERT OR REPLACE INTO cloud_outbox (kind, app_profile_id, tmdb_id, media_type, season_number, episode_number, changed_at)
    VALUES ('watchlist', OLD.app_profile_id, OLD.tmdb_id, OLD.media_type, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Watched movies / episodes (a completed watch_history row; progress ticks never fire these) --
CREATE TRIGGER IF NOT EXISTS cloud_history_insert AFTER INSERT ON watch_history
WHEN NEW.is_completed = 1
 AND (NEW.media_type = 'movie' OR NEW.episode_number > 0)
 AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'cloud_sync_profile_id' AND value = CAST(NEW.app_profile_id AS TEXT))
BEGIN
    INSERT OR REPLACE INTO cloud_outbox (kind, app_profile_id, tmdb_id, media_type, season_number, episode_number, changed_at)
    VALUES (CASE WHEN NEW.media_type = 'movie' THEN 'movie' ELSE 'episode' END, NEW.app_profile_id, NEW.tmdb_id, NEW.media_type,
            CASE WHEN NEW.media_type = 'movie' THEN 0 ELSE NEW.season_number END,
            CASE WHEN NEW.media_type = 'movie' THEN 0 ELSE NEW.episode_number END,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER IF NOT EXISTS cloud_history_completed AFTER UPDATE OF is_completed ON watch_history
WHEN OLD.is_completed IS NOT NEW.is_completed
 AND (NEW.media_type = 'movie' OR NEW.episode_number > 0)
 AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'cloud_sync_profile_id' AND value = CAST(NEW.app_profile_id AS TEXT))
BEGIN
    INSERT OR REPLACE INTO cloud_outbox (kind, app_profile_id, tmdb_id, media_type, season_number, episode_number, changed_at)
    VALUES (CASE WHEN NEW.media_type = 'movie' THEN 'movie' ELSE 'episode' END, NEW.app_profile_id, NEW.tmdb_id, NEW.media_type,
            CASE WHEN NEW.media_type = 'movie' THEN 0 ELSE NEW.season_number END,
            CASE WHEN NEW.media_type = 'movie' THEN 0 ELSE NEW.episode_number END,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER IF NOT EXISTS cloud_history_delete AFTER DELETE ON watch_history
WHEN OLD.is_completed = 1
 AND (OLD.media_type = 'movie' OR OLD.episode_number > 0)
 AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'cloud_sync_profile_id' AND value = CAST(OLD.app_profile_id AS TEXT))
BEGIN
    INSERT OR REPLACE INTO cloud_outbox (kind, app_profile_id, tmdb_id, media_type, season_number, episode_number, changed_at)
    VALUES (CASE WHEN OLD.media_type = 'movie' THEN 'movie' ELSE 'episode' END, OLD.app_profile_id, OLD.tmdb_id, OLD.media_type,
            CASE WHEN OLD.media_type = 'movie' THEN 0 ELSE OLD.season_number END,
            CASE WHEN OLD.media_type = 'movie' THEN 0 ELSE OLD.episode_number END,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
