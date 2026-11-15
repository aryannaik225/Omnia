-- Background delta sync: per linked OTT account, when it was last synced and how it went.
-- A sync only reads activity newer than last_success_at (minus a small overlap).
CREATE TABLE IF NOT EXISTS ott_sync_state (
    app_profile_id INTEGER NOT NULL,
    provider_id INTEGER NOT NULL,
    last_attempt_at DATETIME,
    last_success_at DATETIME,
    last_error TEXT,
    last_new_rows INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (app_profile_id, provider_id),
    FOREIGN KEY (app_profile_id) REFERENCES app_profiles(profile_id) ON DELETE CASCADE
);
