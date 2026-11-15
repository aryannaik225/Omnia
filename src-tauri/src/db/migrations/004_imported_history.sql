-- Silent import: rows that came from a bulk import (OTT history sync, CSV/JSON file) feed the
-- recommender and the history view, but stay off Home's "Continue Watching" until the title is
-- actually played inside Omnia (live telemetry flips the flag back to 0 on the row it touches).
ALTER TABLE watch_history ADD COLUMN is_imported BOOLEAN NOT NULL DEFAULT 0;

-- Backfill: anything never played in Omnia (no live playback event for that title in this
-- profile; "abandoned" events are written by the sweep, not by playback) was imported.
UPDATE watch_history
   SET is_imported = 1
 WHERE NOT EXISTS (
        SELECT 1 FROM playback_events e
         WHERE e.app_profile_id = watch_history.app_profile_id
           AND e.tmdb_id = watch_history.tmdb_id
           AND e.media_type = watch_history.media_type
           AND e.event_type <> 'abandoned');
