-- v2: remembered "Where do you want to watch this?" choice, per Omnia profile and title.
-- `provider_id` is the canonical provider id (see OttProvider::canonical_id), so a choice of
-- "Prime Video" also matches its "with Ads" / store variants.

-- 12. Preferred OTT Provider per Title (Isolated by Profile)
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
