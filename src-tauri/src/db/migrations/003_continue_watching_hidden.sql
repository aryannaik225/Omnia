-- v3: "Remove from Continue Watching". Hides a title from the row without touching its history
-- (which still feeds recommendations). A hide only covers activity up to `hidden_at`: watching
-- the title again later brings it back automatically.

-- 13. Titles hidden from Continue Watching (Isolated by Profile)
CREATE TABLE IF NOT EXISTS continue_watching_hidden (
    app_profile_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
    hidden_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (app_profile_id, tmdb_id, media_type),
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);
