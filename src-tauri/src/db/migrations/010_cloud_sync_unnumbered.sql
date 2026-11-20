-- Migration v10: cloud sync also carries completed episodes without an episode number
-- (episode_number = 0: the service didn't number it and TMDB couldn't match its title, e.g.
-- Netflix activity for a season TMDB lists only as "Episode 1…"). v9's triggers skipped them,
-- so such series never reached the web app.

DROP TRIGGER IF EXISTS cloud_history_insert;
DROP TRIGGER IF EXISTS cloud_history_completed;
DROP TRIGGER IF EXISTS cloud_history_delete;

CREATE TRIGGER IF NOT EXISTS cloud_history_insert AFTER INSERT ON watch_history
WHEN NEW.is_completed = 1
 AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'cloud_sync_profile_id' AND value = CAST(NEW.app_profile_id AS TEXT))
BEGIN
    INSERT OR REPLACE INTO cloud_outbox (kind, app_profile_id, tmdb_id, media_type, season_number, episode_number, changed_at)
    VALUES (CASE WHEN NEW.media_type = 'movie' THEN 'movie' ELSE 'episode' END, NEW.app_profile_id, NEW.tmdb_id, NEW.media_type,
            CASE WHEN NEW.media_type = 'movie' THEN 0 ELSE NEW.season_number END,
            CASE WHEN NEW.media_type = 'movie' THEN 0 ELSE NEW.episode_number END,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Also re-sent when an unnumbered episode's title changes (a later import refines it).
CREATE TRIGGER IF NOT EXISTS cloud_history_completed AFTER UPDATE OF is_completed, episode_title ON watch_history
WHEN (OLD.is_completed IS NOT NEW.is_completed OR (NEW.is_completed = 1 AND NEW.episode_number = 0 AND OLD.episode_title IS NOT NEW.episode_title))
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
 AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'cloud_sync_profile_id' AND value = CAST(OLD.app_profile_id AS TEXT))
BEGIN
    INSERT OR REPLACE INTO cloud_outbox (kind, app_profile_id, tmdb_id, media_type, season_number, episode_number, changed_at)
    VALUES (CASE WHEN OLD.media_type = 'movie' THEN 'movie' ELSE 'episode' END, OLD.app_profile_id, OLD.tmdb_id, OLD.media_type,
            CASE WHEN OLD.media_type = 'movie' THEN 0 ELSE OLD.season_number END,
            CASE WHEN OLD.media_type = 'movie' THEN 0 ELSE OLD.episode_number END,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Already signed in: queue the profile's existing unnumbered episodes (they were never sent).
INSERT OR IGNORE INTO cloud_outbox (kind, app_profile_id, tmdb_id, media_type, season_number, episode_number, changed_at)
SELECT 'episode', h.app_profile_id, h.tmdb_id, 'tv', h.season_number, 0,
       COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', h.last_watched_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM watch_history h
 WHERE h.media_type = 'tv' AND h.episode_number = 0 AND h.is_completed = 1
   AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'cloud_sync_profile_id' AND value = CAST(h.app_profile_id AS TEXT));
