//! Synchronous CRUD for every Omnia table. These functions take a plain `rusqlite::Connection`
//! and are executed on the SQLite thread via [`super::Database::run`].
//!
//! All datetimes are SQLite UTC text (`YYYY-MM-DD HH:MM:SS`) produced by `datetime('now')`.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Params, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------------------------
// Shared helpers & constants
// ---------------------------------------------------------------------------------------------

/// Settings keys used across the backend and frontend.
pub mod keys {
    pub const ACTIVE_PROFILE_ID: &str = "active_profile_id";
    pub const REGION_CODE: &str = "region_code";
    pub const REGION_SOURCE: &str = "region_source";
    pub const SUBSCRIPTIONS_ONLY: &str = "subscriptions_only";
    pub const LAN_SERVER_ENABLED: &str = "lan_server_enabled";
    pub const KIDS_SAFE_MODE: &str = "kids_safe_mode";
    /// TMDB v3 key or v4 read token, used locally for history entity resolution.
    pub const TMDB_API_KEY: &str = "tmdb_api_key";
    /// Model id of the vectors currently stored in media_embeddings.
    pub const EMBEDDING_MODEL_ID: &str = "embedding_model_id";
}

/// A title counts as completed when the user reaches the credits: 95% of runtime,
/// or within the final two minutes of anything longer than five minutes.
pub fn is_completion(progress_seconds: f64, duration_seconds: f64) -> bool {
    if duration_seconds <= 1.0 {
        return false;
    }
    progress_seconds >= duration_seconds * 0.95
        || (duration_seconds > 300.0 && duration_seconds - progress_seconds <= 120.0)
}

/// Time-of-day contextual bucket used by the recommender's per-window taste centroids.
pub fn time_of_day_bucket(hour: u32) -> &'static str {
    match hour {
        4..=11 => "Morning",
        12..=16 => "Afternoon",
        17..=19 => "Evening",
        20..=22 => "PrimeTime",
        _ => "LateNight",
    }
}

pub fn current_time_of_day_bucket() -> &'static str {
    use chrono::Timelike;
    time_of_day_bucket(chrono::Local::now().hour())
}

fn collect_rows<T, P, F>(c: &Connection, sql: &str, params: P, f: F) -> rusqlite::Result<Vec<T>>
where
    P: Params,
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    let mut stmt = c.prepare_cached(sql)?;
    let rows = stmt.query_map(params, f)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn json_to_text(v: &Option<Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.to_string()),
    }
}

fn text_to_json(s: Option<String>) -> Option<Value> {
    s.map(|s| serde_json::from_str(&s).unwrap_or(Value::String(s)))
}

// ---------------------------------------------------------------------------------------------
// 1. app_profiles
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppProfile {
    pub profile_id: i64,
    pub profile_name: String,
    pub avatar_asset: Option<String>,
    pub is_kids_profile: bool,
    pub created_at: String,
}

const PROFILE_COLS: &str = "profile_id, profile_name, avatar_asset, is_kids_profile, created_at";

fn map_profile(r: &Row<'_>) -> rusqlite::Result<AppProfile> {
    Ok(AppProfile {
        profile_id: r.get(0)?,
        profile_name: r.get(1)?,
        avatar_asset: r.get(2)?,
        is_kids_profile: r.get::<_, Option<bool>>(3)?.unwrap_or(false),
        created_at: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
    })
}

pub fn list_profiles(c: &Connection) -> rusqlite::Result<Vec<AppProfile>> {
    collect_rows(
        c,
        &format!("SELECT {PROFILE_COLS} FROM app_profiles ORDER BY profile_id"),
        [],
        map_profile,
    )
}

pub fn get_profile(c: &Connection, profile_id: i64) -> rusqlite::Result<Option<AppProfile>> {
    c.query_row(
        &format!("SELECT {PROFILE_COLS} FROM app_profiles WHERE profile_id = ?1"),
        [profile_id],
        map_profile,
    )
    .optional()
}

pub fn create_profile(
    c: &Connection,
    profile_name: &str,
    avatar_asset: Option<&str>,
    is_kids_profile: bool,
) -> rusqlite::Result<AppProfile> {
    c.execute(
        "INSERT INTO app_profiles (profile_name, avatar_asset, is_kids_profile) VALUES (?1, ?2, ?3)",
        params![profile_name, avatar_asset, is_kids_profile],
    )?;
    get_profile(c, c.last_insert_rowid())?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn update_profile(
    c: &Connection,
    profile_id: i64,
    profile_name: &str,
    avatar_asset: Option<&str>,
    is_kids_profile: bool,
) -> rusqlite::Result<Option<AppProfile>> {
    let changed = c.execute(
        "UPDATE app_profiles SET profile_name = ?2, avatar_asset = ?3, is_kids_profile = ?4
         WHERE profile_id = ?1",
        params![profile_id, profile_name, avatar_asset, is_kids_profile],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    get_profile(c, profile_id)
}

/// Deletes a profile (cascading to its history, events, embeddings, watchlist and OTT mappings).
/// Refuses to delete the last remaining profile. Returns whether a row was removed.
pub fn delete_profile(c: &mut Connection, profile_id: i64) -> rusqlite::Result<bool> {
    let tx = c.transaction()?;
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM app_profiles", [], |r| r.get(0))?;
    if count <= 1 {
        return Ok(false);
    }
    let removed = tx.execute("DELETE FROM app_profiles WHERE profile_id = ?1", [profile_id])? > 0;
    if removed {
        let active: Option<String> = tx
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [keys::ACTIVE_PROFILE_ID],
                |r| r.get(0),
            )
            .optional()?;
        if active.as_deref() == Some(profile_id.to_string().as_str()) {
            let fallback: i64 = tx.query_row(
                "SELECT profile_id FROM app_profiles ORDER BY profile_id LIMIT 1",
                [],
                |r| r.get(0),
            )?;
            set_setting(&tx, keys::ACTIVE_PROFILE_ID, &fallback.to_string())?;
        }
    }
    tx.commit()?;
    Ok(removed)
}

/// Guarantees at least one profile exists and that `active_profile_id` points at a real profile.
pub fn ensure_default_profile(c: &Connection) -> rusqlite::Result<i64> {
    let first: Option<i64> = c
        .query_row(
            "SELECT profile_id FROM app_profiles ORDER BY profile_id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let first = match first {
        Some(id) => id,
        None => create_profile(c, "Primary", None, false)?.profile_id,
    };
    let active = get_setting(c, keys::ACTIVE_PROFILE_ID)?
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|id| get_profile(c, *id).ok().flatten().is_some());
    match active {
        Some(id) => Ok(id),
        None => {
            set_setting(c, keys::ACTIVE_PROFILE_ID, &first.to_string())?;
            Ok(first)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// 2. ott_profile_mappings
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OttProfileMapping {
    pub app_profile_id: i64,
    pub provider_id: i64,
    pub ott_native_profile_id: String,
    pub ott_native_profile_name: Option<String>,
}

fn map_ott_mapping(r: &Row<'_>) -> rusqlite::Result<OttProfileMapping> {
    Ok(OttProfileMapping {
        app_profile_id: r.get(0)?,
        provider_id: r.get(1)?,
        ott_native_profile_id: r.get(2)?,
        ott_native_profile_name: r.get(3)?,
    })
}

pub fn upsert_ott_mapping(c: &Connection, m: &OttProfileMapping) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO ott_profile_mappings
            (app_profile_id, provider_id, ott_native_profile_id, ott_native_profile_name)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(app_profile_id, provider_id) DO UPDATE SET
            ott_native_profile_id = excluded.ott_native_profile_id,
            ott_native_profile_name = excluded.ott_native_profile_name",
        params![
            m.app_profile_id,
            m.provider_id,
            m.ott_native_profile_id,
            m.ott_native_profile_name
        ],
    )?;
    Ok(())
}

pub fn get_ott_mapping(
    c: &Connection,
    app_profile_id: i64,
    provider_id: i64,
) -> rusqlite::Result<Option<OttProfileMapping>> {
    c.query_row(
        "SELECT app_profile_id, provider_id, ott_native_profile_id, ott_native_profile_name
         FROM ott_profile_mappings WHERE app_profile_id = ?1 AND provider_id = ?2",
        params![app_profile_id, provider_id],
        map_ott_mapping,
    )
    .optional()
}

pub fn list_ott_mappings(
    c: &Connection,
    app_profile_id: i64,
) -> rusqlite::Result<Vec<OttProfileMapping>> {
    collect_rows(
        c,
        "SELECT app_profile_id, provider_id, ott_native_profile_id, ott_native_profile_name
         FROM ott_profile_mappings WHERE app_profile_id = ?1 ORDER BY provider_id",
        [app_profile_id],
        map_ott_mapping,
    )
}

/// Reverse lookup used by the telemetry/import pipeline: which app profile owns this OTT profile?
pub fn find_app_profile_for_ott(
    c: &Connection,
    provider_id: i64,
    ott_native_profile_id: &str,
) -> rusqlite::Result<Option<i64>> {
    c.query_row(
        "SELECT app_profile_id FROM ott_profile_mappings
         WHERE provider_id = ?1 AND ott_native_profile_id = ?2 LIMIT 1",
        params![provider_id, ott_native_profile_id],
        |r| r.get(0),
    )
    .optional()
}

/// How many Omnia profiles have linked a profile of this provider (used to decide whether an
/// unverifiable scrape can be attributed unambiguously).
pub fn count_mappings_for_provider(c: &Connection, provider_id: i64) -> rusqlite::Result<i64> {
    c.query_row(
        "SELECT COUNT(*) FROM ott_profile_mappings WHERE provider_id = ?1",
        [provider_id],
        |r| r.get(0),
    )
}

pub fn list_all_ott_mappings(c: &Connection) -> rusqlite::Result<Vec<OttProfileMapping>> {
    collect_rows(
        c,
        "SELECT app_profile_id, provider_id, ott_native_profile_id, ott_native_profile_name
         FROM ott_profile_mappings ORDER BY app_profile_id, provider_id",
        [],
        map_ott_mapping,
    )
}

/// Moves a link to another provider id (canonicalisation of monetisation variants). If the
/// profile already has a link under the target id, that one wins and the old row is dropped.
pub fn rekey_ott_mapping(c: &Connection, app_profile_id: i64, from_provider: i64, to_provider: i64) -> rusqlite::Result<()> {
    c.execute(
        "UPDATE OR IGNORE ott_profile_mappings SET provider_id = ?3
         WHERE app_profile_id = ?1 AND provider_id = ?2",
        params![app_profile_id, from_provider, to_provider],
    )?;
    c.execute(
        "DELETE FROM ott_profile_mappings WHERE app_profile_id = ?1 AND provider_id = ?2",
        params![app_profile_id, from_provider],
    )?;
    Ok(())
}

pub fn delete_ott_mapping(
    c: &Connection,
    app_profile_id: i64,
    provider_id: i64,
) -> rusqlite::Result<bool> {
    Ok(c.execute(
        "DELETE FROM ott_profile_mappings WHERE app_profile_id = ?1 AND provider_id = ?2",
        params![app_profile_id, provider_id],
    )? > 0)
}

// ---------------------------------------------------------------------------------------------
// 3. app_settings
// ---------------------------------------------------------------------------------------------

pub fn get_setting(c: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    c.query_row("SELECT value FROM app_settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
}

pub fn set_setting(c: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_all_settings(c: &Connection) -> rusqlite::Result<HashMap<String, String>> {
    let pairs = collect_rows(c, "SELECT key, value FROM app_settings", [], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(pairs.into_iter().collect())
}

pub fn delete_setting(c: &Connection, key: &str) -> rusqlite::Result<bool> {
    Ok(c.execute("DELETE FROM app_settings WHERE key = ?1", [key])? > 0)
}

/// Seeds defaults without overwriting user choices. `region_code` is intentionally left unset
/// so the frontend runs IP geolocation on first launch.
pub fn ensure_default_settings(c: &Connection) -> rusqlite::Result<()> {
    let defaults = [
        (keys::REGION_SOURCE, "auto"),
        (keys::SUBSCRIPTIONS_ONLY, "false"),
        (keys::LAN_SERVER_ENABLED, "false"),
        (keys::KIDS_SAFE_MODE, "false"),
    ];
    for (k, v) in defaults {
        c.execute(
            "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?1, ?2)",
            params![k, v],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// 4. subscribed_providers
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedProvider {
    pub provider_id: i64,
    pub provider_name: String,
    pub logo_path: Option<String>,
    pub region_code: String,
    #[serde(default = "default_true")]
    pub is_active: bool,
}

fn default_true() -> bool {
    true
}

fn map_provider(r: &Row<'_>) -> rusqlite::Result<SubscribedProvider> {
    Ok(SubscribedProvider {
        provider_id: r.get(0)?,
        provider_name: r.get(1)?,
        logo_path: r.get(2)?,
        region_code: r.get(3)?,
        is_active: r.get::<_, Option<bool>>(4)?.unwrap_or(true),
    })
}

pub fn list_subscribed_providers(
    c: &Connection,
    region_code: &str,
    active_only: bool,
) -> rusqlite::Result<Vec<SubscribedProvider>> {
    collect_rows(
        c,
        "SELECT provider_id, provider_name, logo_path, region_code, is_active
         FROM subscribed_providers
         WHERE region_code = ?1 AND (?2 = 0 OR is_active = 1)
         ORDER BY provider_name COLLATE NOCASE",
        params![region_code, active_only],
        map_provider,
    )
}

pub fn upsert_subscribed_provider(c: &Connection, p: &SubscribedProvider) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO subscribed_providers (provider_id, provider_name, logo_path, region_code, is_active)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(provider_id, region_code) DO UPDATE SET
            provider_name = excluded.provider_name,
            logo_path = COALESCE(excluded.logo_path, subscribed_providers.logo_path),
            is_active = excluded.is_active",
        params![p.provider_id, p.provider_name, p.logo_path, p.region_code, p.is_active],
    )?;
    Ok(())
}

pub fn set_provider_active(
    c: &Connection,
    provider_id: i64,
    region_code: &str,
    is_active: bool,
) -> rusqlite::Result<bool> {
    Ok(c.execute(
        "UPDATE subscribed_providers SET is_active = ?3 WHERE provider_id = ?1 AND region_code = ?2",
        params![provider_id, region_code, is_active],
    )? > 0)
}

/// Makes `providers` the exact active subscription set for `region_code`. Providers not in the
/// list are deactivated (kept, so logos and names survive re-toggling).
pub fn replace_region_subscriptions(
    c: &mut Connection,
    region_code: &str,
    providers: &[SubscribedProvider],
) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    tx.execute(
        "UPDATE subscribed_providers SET is_active = 0 WHERE region_code = ?1",
        [region_code],
    )?;
    for p in providers {
        let p = SubscribedProvider {
            region_code: region_code.to_string(),
            is_active: true,
            ..p.clone()
        };
        upsert_subscribed_provider(&tx, &p)?;
    }
    tx.commit()
}

// ---------------------------------------------------------------------------------------------
// 5. media_catalog
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaCatalogEntry {
    pub tmdb_id: i64,
    pub media_type: String,
    pub title: String,
    #[serde(default)]
    pub original_title: Option<String>,
    #[serde(default)]
    pub overview: Option<String>,
    #[serde(default)]
    pub poster_path: Option<String>,
    #[serde(default)]
    pub backdrop_path: Option<String>,
    #[serde(default)]
    pub release_year: Option<i64>,
    #[serde(default)]
    pub runtime_mins: Option<i64>,
    #[serde(default)]
    pub genres: Option<Value>,
    #[serde(default)]
    pub keywords: Option<Value>,
    #[serde(default)]
    pub credits: Option<Value>,
    #[serde(default)]
    pub vote_average: Option<f64>,
    #[serde(default)]
    pub certification: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

const MEDIA_COLS: &str = "tmdb_id, media_type, title, original_title, overview, poster_path, \
    backdrop_path, release_year, runtime_mins, genres_json, keywords_json, credits_json, \
    vote_average, certification, updated_at";

fn map_media(r: &Row<'_>) -> rusqlite::Result<MediaCatalogEntry> {
    Ok(MediaCatalogEntry {
        tmdb_id: r.get(0)?,
        media_type: r.get(1)?,
        title: r.get(2)?,
        original_title: r.get(3)?,
        overview: r.get(4)?,
        poster_path: r.get(5)?,
        backdrop_path: r.get(6)?,
        release_year: r.get(7)?,
        runtime_mins: r.get(8)?,
        genres: text_to_json(r.get(9)?),
        keywords: text_to_json(r.get(10)?),
        credits: text_to_json(r.get(11)?),
        vote_average: r.get(12)?,
        certification: r.get(13)?,
        updated_at: r.get(14)?,
    })
}

/// Upserts metadata. Rich fields (keywords/credits/runtime/certification) are only overwritten
/// when the incoming record carries them, so a lightweight list-view payload never erases
/// details fetched earlier for the detail view.
pub fn upsert_media(c: &Connection, m: &MediaCatalogEntry) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO media_catalog (tmdb_id, media_type, title, original_title, overview, poster_path,
            backdrop_path, release_year, runtime_mins, genres_json, keywords_json, credits_json,
            vote_average, certification, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, datetime('now'))
         ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
            title = excluded.title,
            original_title = COALESCE(excluded.original_title, media_catalog.original_title),
            overview = COALESCE(excluded.overview, media_catalog.overview),
            poster_path = COALESCE(excluded.poster_path, media_catalog.poster_path),
            backdrop_path = COALESCE(excluded.backdrop_path, media_catalog.backdrop_path),
            release_year = COALESCE(excluded.release_year, media_catalog.release_year),
            runtime_mins = COALESCE(excluded.runtime_mins, media_catalog.runtime_mins),
            genres_json = COALESCE(excluded.genres_json, media_catalog.genres_json),
            keywords_json = COALESCE(excluded.keywords_json, media_catalog.keywords_json),
            credits_json = COALESCE(excluded.credits_json, media_catalog.credits_json),
            vote_average = COALESCE(excluded.vote_average, media_catalog.vote_average),
            certification = COALESCE(excluded.certification, media_catalog.certification),
            updated_at = excluded.updated_at",
        params![
            m.tmdb_id,
            m.media_type,
            m.title,
            m.original_title,
            m.overview,
            m.poster_path,
            m.backdrop_path,
            m.release_year,
            m.runtime_mins,
            json_to_text(&m.genres),
            json_to_text(&m.keywords),
            json_to_text(&m.credits),
            m.vote_average,
            m.certification,
        ],
    )?;
    Ok(())
}

pub fn upsert_media_batch(c: &mut Connection, items: &[MediaCatalogEntry]) -> rusqlite::Result<usize> {
    let tx = c.transaction()?;
    for m in items {
        upsert_media(&tx, m)?;
    }
    tx.commit()?;
    Ok(items.len())
}

pub fn get_media(
    c: &Connection,
    tmdb_id: i64,
    media_type: &str,
) -> rusqlite::Result<Option<MediaCatalogEntry>> {
    c.query_row(
        &format!("SELECT {MEDIA_COLS} FROM media_catalog WHERE tmdb_id = ?1 AND media_type = ?2"),
        params![tmdb_id, media_type],
        map_media,
    )
    .optional()
}

/// Local-first entity resolution: a cached catalog entry whose title or original title matches
/// case-insensitively (avoids a TMDB request for titles already known on this machine).
pub fn find_media_by_title(
    c: &Connection,
    title: &str,
    media_type: Option<&str>,
) -> rusqlite::Result<Option<MediaCatalogEntry>> {
    c.query_row(
        &format!(
            "SELECT {MEDIA_COLS} FROM media_catalog
             WHERE (title = ?1 COLLATE NOCASE OR original_title = ?1 COLLATE NOCASE)
               AND (?2 IS NULL OR media_type = ?2)
             ORDER BY updated_at DESC LIMIT 1"
        ),
        params![title.trim(), media_type],
        map_media,
    )
    .optional()
}

/// Every catalog entry the profile has interacted with (history or watchlist), for the recommender.
pub fn list_interacted_media(
    c: &Connection,
    app_profile_id: i64,
) -> rusqlite::Result<Vec<MediaCatalogEntry>> {
    let cols = MEDIA_COLS
        .split(", ")
        .map(|col| format!("mc.{}", col.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    collect_rows(
        c,
        &format!(
            "SELECT {cols} FROM media_catalog mc
             WHERE EXISTS (SELECT 1 FROM watch_history wh WHERE wh.app_profile_id = ?1
                             AND wh.tmdb_id = mc.tmdb_id AND wh.media_type = mc.media_type)
                OR EXISTS (SELECT 1 FROM watchlist wl WHERE wl.app_profile_id = ?1
                             AND wl.tmdb_id = mc.tmdb_id AND wl.media_type = mc.media_type)"
        ),
        [app_profile_id],
        map_media,
    )
}

// ---------------------------------------------------------------------------------------------
// 6. deep_links
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeepLink {
    pub tmdb_id: i64,
    pub media_type: String,
    pub region_code: String,
    pub provider_id: i64,
    pub provider_name: String,
    pub monetization_type: String,
    pub direct_url: String,
    pub quality: Option<String>,
    pub expires_at: Option<String>,
    pub resolved_at: Option<String>,
}

fn map_deep_link(r: &Row<'_>) -> rusqlite::Result<DeepLink> {
    Ok(DeepLink {
        tmdb_id: r.get(0)?,
        media_type: r.get(1)?,
        region_code: r.get(2)?,
        provider_id: r.get(3)?,
        provider_name: r.get(4)?,
        monetization_type: r.get(5)?,
        direct_url: r.get(6)?,
        quality: r.get(7)?,
        expires_at: r.get(8)?,
        resolved_at: r.get(9)?,
    })
}

/// Unexpired cached links for one title in one region.
pub fn get_valid_deep_links(
    c: &Connection,
    tmdb_id: i64,
    media_type: &str,
    region_code: &str,
) -> rusqlite::Result<Vec<DeepLink>> {
    collect_rows(
        c,
        "SELECT tmdb_id, media_type, region_code, provider_id, provider_name, monetization_type,
                direct_url, quality, expires_at, resolved_at
         FROM deep_links
         WHERE tmdb_id = ?1 AND media_type = ?2 AND region_code = ?3
           AND (expires_at IS NULL OR expires_at > datetime('now'))
         ORDER BY CASE monetization_type
                    WHEN 'flatrate' THEN 0 WHEN 'free' THEN 1 WHEN 'ads' THEN 2
                    WHEN 'rent' THEN 3 WHEN 'buy' THEN 4 ELSE 5 END,
                  provider_name COLLATE NOCASE",
        params![tmdb_id, media_type, region_code],
        map_deep_link,
    )
}

/// Atomically replaces the cached link set for a title/region. Each link carries its own TTL
/// in hours (direct JustWatch links: 7 days; search-page fallbacks: shorter, so they get retried).
pub fn replace_deep_links(
    c: &mut Connection,
    tmdb_id: i64,
    media_type: &str,
    region_code: &str,
    links: &[(DeepLink, i64)],
) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    tx.execute(
        "DELETE FROM deep_links WHERE tmdb_id = ?1 AND media_type = ?2 AND region_code = ?3",
        params![tmdb_id, media_type, region_code],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO deep_links (tmdb_id, media_type, region_code, provider_id,
                provider_name, monetization_type, direct_url, quality, expires_at, resolved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now', ?9), datetime('now'))",
        )?;
        for (link, ttl_hours) in links {
            stmt.execute(params![
                tmdb_id,
                media_type,
                region_code,
                link.provider_id,
                link.provider_name,
                link.monetization_type,
                link.direct_url,
                link.quality,
                format!("+{} hours", (*ttl_hours).max(1)),
            ])?;
        }
    }
    tx.commit()
}

pub fn purge_expired_deep_links(c: &Connection) -> rusqlite::Result<usize> {
    c.execute(
        "DELETE FROM deep_links WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')",
        [],
    )
}

// ---------------------------------------------------------------------------------------------
// 7. watch_history
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchHistoryEntry {
    pub id: i64,
    pub app_profile_id: i64,
    pub tmdb_id: i64,
    pub media_type: String,
    pub season_number: i64,
    pub episode_number: i64,
    pub episode_title: Option<String>,
    pub provider_name: Option<String>,
    pub direct_url: Option<String>,
    pub progress_seconds: f64,
    pub duration_seconds: f64,
    pub completion_ratio: f64,
    pub is_completed: bool,
    pub watch_count: i64,
    pub abandoned: bool,
    pub last_watched_at: String,
    pub time_of_day_bucket: Option<String>,
}

const WATCH_COLS: &str = "id, app_profile_id, tmdb_id, media_type, season_number, episode_number, \
    episode_title, provider_name, direct_url, progress_seconds, duration_seconds, completion_ratio, \
    is_completed, watch_count, abandoned, last_watched_at, time_of_day_bucket";

fn map_watch(r: &Row<'_>) -> rusqlite::Result<WatchHistoryEntry> {
    Ok(WatchHistoryEntry {
        id: r.get(0)?,
        app_profile_id: r.get(1)?,
        tmdb_id: r.get(2)?,
        media_type: r.get(3)?,
        season_number: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
        episode_number: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
        episode_title: r.get(6)?,
        provider_name: r.get(7)?,
        direct_url: r.get(8)?,
        progress_seconds: r.get(9)?,
        duration_seconds: r.get(10)?,
        completion_ratio: r.get::<_, Option<f64>>(11)?.unwrap_or(0.0),
        is_completed: r.get::<_, Option<bool>>(12)?.unwrap_or(false),
        watch_count: r.get::<_, Option<i64>>(13)?.unwrap_or(1),
        abandoned: r.get::<_, Option<bool>>(14)?.unwrap_or(false),
        last_watched_at: r.get::<_, Option<String>>(15)?.unwrap_or_default(),
        time_of_day_bucket: r.get(16)?,
    })
}

/// A live telemetry sample from the player window (or a manual "mark as watched").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressUpdate {
    pub app_profile_id: i64,
    pub tmdb_id: i64,
    pub media_type: String,
    #[serde(default)]
    pub season_number: i64,
    #[serde(default)]
    pub episode_number: i64,
    #[serde(default)]
    pub episode_title: Option<String>,
    #[serde(default)]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub direct_url: Option<String>,
    pub progress_seconds: f64,
    pub duration_seconds: f64,
}

pub fn get_history_entry(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
    season_number: i64,
    episode_number: i64,
) -> rusqlite::Result<Option<WatchHistoryEntry>> {
    c.query_row(
        &format!(
            "SELECT {WATCH_COLS} FROM watch_history
             WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3
               AND season_number = ?4 AND episode_number = ?5"
        ),
        params![app_profile_id, tmdb_id, media_type, season_number, episode_number],
        map_watch,
    )
    .optional()
}

/// Records live playback progress.
///
/// * Position always reflects the latest sample; duration only updates when known (> 1s).
/// * Completion is sticky once reached, except when a completed title is restarted from the
///   first 5% — that is a rewatch: `watch_count` increments and completion resets so the
///   recommender can detect "Comfort Favorites".
/// * Any new activity clears the `abandoned` flag.
pub fn record_progress(c: &Connection, u: &ProgressUpdate) -> rusqlite::Result<WatchHistoryEntry> {
    let duration = if u.duration_seconds.is_finite() && u.duration_seconds > 1.0 {
        u.duration_seconds
    } else {
        1.0
    };
    let mut progress = if u.progress_seconds.is_finite() { u.progress_seconds.max(0.0) } else { 0.0 };
    if duration > 1.0 {
        progress = progress.min(duration);
    }
    let completed = is_completion(progress, duration);

    c.execute(
        "INSERT INTO watch_history (app_profile_id, tmdb_id, media_type, season_number, episode_number,
            episode_title, provider_name, direct_url, progress_seconds, duration_seconds, is_completed,
            watch_count, abandoned, last_watched_at, time_of_day_bucket, is_imported)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, 0, datetime('now'), ?12, 0)
         ON CONFLICT(app_profile_id, tmdb_id, media_type, season_number, episode_number) DO UPDATE SET
            -- Played in Omnia: an imported row graduates to Continue Watching.
            is_imported = 0,
            episode_title = COALESCE(excluded.episode_title, watch_history.episode_title),
            provider_name = COALESCE(excluded.provider_name, watch_history.provider_name),
            direct_url = COALESCE(excluded.direct_url, watch_history.direct_url),
            watch_count = watch_history.watch_count + CASE
                WHEN watch_history.is_completed = 1
                 AND excluded.progress_seconds < watch_history.progress_seconds
                 AND excluded.progress_seconds <= 0.05 * MAX(excluded.duration_seconds, watch_history.duration_seconds)
                THEN 1 ELSE 0 END,
            is_completed = CASE
                WHEN excluded.is_completed = 1 THEN 1
                WHEN watch_history.is_completed = 1
                 AND excluded.progress_seconds < watch_history.progress_seconds
                 AND excluded.progress_seconds <= 0.05 * MAX(excluded.duration_seconds, watch_history.duration_seconds)
                THEN 0
                ELSE watch_history.is_completed END,
            progress_seconds = excluded.progress_seconds,
            duration_seconds = CASE WHEN excluded.duration_seconds > 1
                                    THEN excluded.duration_seconds
                                    ELSE watch_history.duration_seconds END,
            abandoned = 0,
            last_watched_at = excluded.last_watched_at,
            time_of_day_bucket = excluded.time_of_day_bucket",
        params![
            u.app_profile_id,
            u.tmdb_id,
            u.media_type,
            u.season_number,
            u.episode_number,
            u.episode_title,
            u.provider_name,
            u.direct_url,
            progress,
            duration,
            completed,
            current_time_of_day_bucket(),
        ],
    )?;
    get_history_entry(c, u.app_profile_id, u.tmdb_id, &u.media_type, u.season_number, u.episode_number)?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Marks an item fully watched (used on `ended`, on in-app episode hops, and manually).
pub fn mark_completed(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
    season_number: i64,
    episode_number: i64,
) -> rusqlite::Result<bool> {
    Ok(c.execute(
        "UPDATE watch_history
            SET is_completed = 1, abandoned = 0,
                progress_seconds = CASE WHEN duration_seconds > 1 THEN duration_seconds ELSE progress_seconds END,
                last_watched_at = datetime('now')
          WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3
            AND season_number = ?4 AND episode_number = ?5",
        params![app_profile_id, tmdb_id, media_type, season_number, episode_number],
    )? > 0)
}

/// All episode / movie rows for one title, ordered by season and episode (detail-view progress bars).
pub fn get_title_history(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
) -> rusqlite::Result<Vec<WatchHistoryEntry>> {
    collect_rows(
        c,
        &format!(
            "SELECT {WATCH_COLS} FROM watch_history
             WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3
             ORDER BY season_number, episode_number"
        ),
        params![app_profile_id, tmdb_id, media_type],
        map_watch,
    )
}

pub fn list_history(
    c: &Connection,
    app_profile_id: i64,
    limit: i64,
    offset: i64,
) -> rusqlite::Result<Vec<WatchHistoryEntry>> {
    collect_rows(
        c,
        &format!(
            "SELECT {WATCH_COLS} FROM watch_history WHERE app_profile_id = ?1
             ORDER BY last_watched_at DESC, id DESC LIMIT ?2 OFFSET ?3"
        ),
        params![app_profile_id, limit.clamp(1, 1_000_000), offset.max(0)],
        map_watch,
    )
}

/// A history row joined with its parent title's catalog metadata (show/movie name + artwork).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryWithMedia {
    #[serde(flatten)]
    pub entry: WatchHistoryEntry,
    pub title: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub release_year: Option<i64>,
}

/// Recent history with the parent title's name, poster and backdrop (Watching Now view).
pub fn list_history_with_media(
    c: &Connection,
    app_profile_id: i64,
    limit: i64,
    offset: i64,
) -> rusqlite::Result<Vec<HistoryWithMedia>> {
    let cols = WATCH_COLS
        .split(", ")
        .map(|col| format!("wh.{}", col.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    collect_rows(
        c,
        &format!(
            "SELECT {cols}, mc.title, mc.poster_path, mc.backdrop_path, mc.release_year
             FROM watch_history wh
             LEFT JOIN media_catalog mc ON mc.tmdb_id = wh.tmdb_id AND mc.media_type = wh.media_type
             WHERE wh.app_profile_id = ?1
             ORDER BY wh.last_watched_at DESC, wh.id DESC
             LIMIT ?2 OFFSET ?3"
        ),
        params![app_profile_id, limit.clamp(1, 1_000_000), offset.max(0)],
        |r| {
            Ok(HistoryWithMedia {
                entry: map_watch(r)?,
                title: r.get(17)?,
                poster_path: r.get(18)?,
                backdrop_path: r.get(19)?,
                release_year: r.get(20)?,
            })
        },
    )
}

pub fn delete_history_entry(c: &Connection, app_profile_id: i64, id: i64) -> rusqlite::Result<bool> {
    Ok(c.execute(
        "DELETE FROM watch_history WHERE id = ?1 AND app_profile_id = ?2",
        params![id, app_profile_id],
    )? > 0)
}

/// Rows removed by [`clear_profile_history`].
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClearedHistory {
    pub history_rows: usize,
    pub playback_events: usize,
}

/// "Clear Watch History": wipes one profile's `watch_history` and `playback_events` (plus its
/// Continue Watching hides and learned affinity scores, which only describe that history) in one
/// transaction. Other profiles, links, watchlist and preferences are untouched.
pub fn clear_profile_history(c: &mut Connection, app_profile_id: i64) -> rusqlite::Result<ClearedHistory> {
    let tx = c.transaction()?;
    let history_rows = tx.execute("DELETE FROM watch_history WHERE app_profile_id = ?1", params![app_profile_id])?;
    let playback_events = tx.execute("DELETE FROM playback_events WHERE app_profile_id = ?1", params![app_profile_id])?;
    tx.execute("DELETE FROM continue_watching_hidden WHERE app_profile_id = ?1", params![app_profile_id])?;
    tx.execute(
        "UPDATE media_embeddings SET computed_affinity_score = 0.0 WHERE app_profile_id = ?1",
        params![app_profile_id],
    )?;
    tx.commit()?;
    Ok(ClearedHistory { history_rows, playback_events })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContinueWatchingItem {
    #[serde(flatten)]
    pub entry: WatchHistoryEntry,
    pub title: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub release_year: Option<i64>,
    pub runtime_mins: Option<i64>,
    /// True when the latest episode of a series was finished: the card should offer the next episode.
    pub up_next: bool,
}

/// The "Continue Watching" shelf: one card per title (the most recent episode for series),
/// excluding abandoned items, finished movies, and barely-started items (< 30s).
/// Series whose latest episode was finished in the last 30 days appear as "Up Next".
pub fn continue_watching(
    c: &Connection,
    app_profile_id: i64,
    limit: i64,
) -> rusqlite::Result<Vec<ContinueWatchingItem>> {
    let cols = WATCH_COLS
        .split(", ")
        .map(|col| format!("w.{}", col.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    collect_rows(
        c,
        &format!(
            "SELECT {cols}, mc.title, mc.poster_path, mc.backdrop_path, mc.release_year, mc.runtime_mins
             FROM (
                SELECT wh.*, ROW_NUMBER() OVER (
                    PARTITION BY wh.tmdb_id, wh.media_type
                    ORDER BY wh.last_watched_at DESC, wh.id DESC) AS rn
                FROM watch_history wh
                WHERE wh.app_profile_id = ?1 AND wh.abandoned = 0
             ) w
             LEFT JOIN media_catalog mc ON mc.tmdb_id = w.tmdb_id AND mc.media_type = w.media_type
             LEFT JOIN continue_watching_hidden h
                ON h.app_profile_id = w.app_profile_id AND h.tmdb_id = w.tmdb_id AND h.media_type = w.media_type
             WHERE w.rn = 1
               -- Silent import: only titles whose latest activity was played in Omnia.
               AND w.is_imported = 0
               -- Hidden by the user, unless watched again after hiding.
               AND (h.hidden_at IS NULL OR w.last_watched_at > h.hidden_at)
               AND (
                (w.is_completed = 0 AND w.progress_seconds >= 30)
                OR (w.media_type = 'tv' AND w.is_completed = 1
                    AND w.last_watched_at >= datetime('now', '-30 days'))
             )
             ORDER BY w.last_watched_at DESC
             LIMIT ?2"
        ),
        params![app_profile_id, limit.clamp(1, 200)],
        |r| {
            let entry = map_watch(r)?;
            let up_next = entry.is_completed && entry.media_type == "tv";
            Ok(ContinueWatchingItem {
                entry,
                title: r.get(17)?,
                poster_path: r.get(18)?,
                backdrop_path: r.get(19)?,
                release_year: r.get(20)?,
                runtime_mins: r.get(21)?,
                up_next,
            })
        },
    )
}

/// Applies the Early Abandonment rule: watched 10-25 minutes, not finished, untouched for 7+ days.
/// Logs an `abandoned` playback event per newly-flagged row so the recommender sees the signal.
pub fn sweep_abandoned(c: &mut Connection) -> rusqlite::Result<usize> {
    let tx = c.transaction()?;
    let flagged: Vec<(i64, i64, String, f64)> = {
        let mut stmt = tx.prepare(
            "UPDATE watch_history SET abandoned = 1
             WHERE is_completed = 0 AND abandoned = 0
               AND progress_seconds BETWEEN 600 AND 1500
               AND last_watched_at < datetime('now', '-7 days')
             RETURNING app_profile_id, tmdb_id, media_type, progress_seconds",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        out
    };
    for (profile, tmdb_id, media_type, progress) in &flagged {
        insert_playback_event(&tx, *profile, *tmdb_id, media_type, "abandoned", *progress)?;
    }
    tx.commit()?;
    Ok(flagged.len())
}

/// A history row coming from the cookie-based OTT importer or a manual CSV/JSON import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryImport {
    pub app_profile_id: i64,
    pub tmdb_id: i64,
    pub media_type: String,
    #[serde(default)]
    pub season_number: i64,
    #[serde(default)]
    pub episode_number: i64,
    #[serde(default)]
    pub episode_title: Option<String>,
    #[serde(default)]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub direct_url: Option<String>,
    #[serde(default)]
    pub progress_seconds: f64,
    #[serde(default)]
    pub duration_seconds: f64,
    #[serde(default)]
    pub is_completed: bool,
    /// Any SQLite-parsable time string (ISO-8601 with optional `Z`/offset). Defaults to now.
    #[serde(default)]
    pub watched_at: Option<String>,
    #[serde(default)]
    pub time_of_day_bucket: Option<String>,
    /// Number of distinct viewings in the source (rewatch signal). Never lowers an existing count.
    #[serde(default)]
    pub watch_count: Option<i64>,
}

/// Idempotent bulk import: re-importing the same activity never duplicates rows or rolls back
/// newer live telemetry. Rows keep the source's own watch date and are stored as imported
/// (`is_imported = 1`, "silent"): they feed the recommender and the history view but not
/// Continue Watching. A row already played in Omnia stays live. Returns the rows processed.
pub fn upsert_imported_history(c: &mut Connection, rows: &[HistoryImport]) -> rusqlite::Result<usize> {
    let tx = c.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO watch_history (app_profile_id, tmdb_id, media_type, season_number, episode_number,
                episode_title, provider_name, direct_url, progress_seconds, duration_seconds, is_completed,
                watch_count, abandoned, last_watched_at, time_of_day_bucket, is_imported)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, MAX(1, COALESCE(?14, 1)), 0,
                     COALESCE(datetime(?12), datetime('now')), ?13, 1)
             ON CONFLICT(app_profile_id, tmdb_id, media_type, season_number, episode_number) DO UPDATE SET
                episode_title = COALESCE(watch_history.episode_title, excluded.episode_title),
                provider_name = COALESCE(watch_history.provider_name, excluded.provider_name),
                direct_url = COALESCE(watch_history.direct_url, excluded.direct_url),
                progress_seconds = CASE WHEN excluded.last_watched_at > watch_history.last_watched_at
                                        THEN excluded.progress_seconds
                                        ELSE watch_history.progress_seconds END,
                duration_seconds = CASE WHEN watch_history.duration_seconds <= 1
                                        THEN excluded.duration_seconds
                                        ELSE watch_history.duration_seconds END,
                is_completed = MAX(watch_history.is_completed, excluded.is_completed),
                watch_count = MAX(watch_history.watch_count, excluded.watch_count),
                last_watched_at = MAX(watch_history.last_watched_at, excluded.last_watched_at),
                time_of_day_bucket = COALESCE(watch_history.time_of_day_bucket, excluded.time_of_day_bucket)",
        )?;
        for row in rows {
            let duration = if row.duration_seconds.is_finite() && row.duration_seconds > 1.0 {
                row.duration_seconds
            } else {
                1.0
            };
            let progress = if row.progress_seconds.is_finite() { row.progress_seconds.max(0.0) } else { 0.0 };
            let progress = if duration > 1.0 { progress.min(duration) } else { progress };
            let completed = row.is_completed || is_completion(progress, duration);
            stmt.execute(params![
                row.app_profile_id,
                row.tmdb_id,
                row.media_type,
                row.season_number,
                row.episode_number,
                row.episode_title,
                row.provider_name,
                row.direct_url,
                progress,
                duration,
                completed,
                row.watched_at,
                row.time_of_day_bucket,
                row.watch_count,
            ])?;
        }
    }
    tx.commit()?;
    Ok(rows.len())
}

// ---------------------------------------------------------------------------------------------
// 8. playback_events
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackEvent {
    pub id: i64,
    pub app_profile_id: i64,
    pub tmdb_id: i64,
    pub media_type: String,
    pub event_type: String,
    pub session_watch_duration_sec: f64,
    pub timestamp: String,
}

fn map_event(r: &Row<'_>) -> rusqlite::Result<PlaybackEvent> {
    Ok(PlaybackEvent {
        id: r.get(0)?,
        app_profile_id: r.get(1)?,
        tmdb_id: r.get(2)?,
        media_type: r.get(3)?,
        event_type: r.get(4)?,
        session_watch_duration_sec: r.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
        timestamp: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
    })
}

pub fn insert_playback_event(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
    event_type: &str,
    session_watch_duration_sec: f64,
) -> rusqlite::Result<i64> {
    let duration = if session_watch_duration_sec.is_finite() { session_watch_duration_sec.max(0.0) } else { 0.0 };
    c.execute(
        "INSERT INTO playback_events (app_profile_id, tmdb_id, media_type, event_type,
            session_watch_duration_sec, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
        params![app_profile_id, tmdb_id, media_type, event_type, duration],
    )?;
    Ok(c.last_insert_rowid())
}

pub fn list_playback_events(
    c: &Connection,
    app_profile_id: i64,
    since: Option<&str>,
    limit: i64,
) -> rusqlite::Result<Vec<PlaybackEvent>> {
    collect_rows(
        c,
        "SELECT id, app_profile_id, tmdb_id, media_type, event_type, session_watch_duration_sec, timestamp
         FROM playback_events
         WHERE app_profile_id = ?1 AND (?2 IS NULL OR timestamp >= datetime(?2))
         ORDER BY timestamp DESC, id DESC
         LIMIT ?3",
        params![app_profile_id, since, limit.clamp(1, 100_000)],
        map_event,
    )
}

pub fn list_title_events(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
) -> rusqlite::Result<Vec<PlaybackEvent>> {
    collect_rows(
        c,
        "SELECT id, app_profile_id, tmdb_id, media_type, event_type, session_watch_duration_sec, timestamp
         FROM playback_events
         WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3
         ORDER BY timestamp, id",
        params![app_profile_id, tmdb_id, media_type],
        map_event,
    )
}

// ---------------------------------------------------------------------------------------------
// 9. media_embeddings
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingRecord {
    pub app_profile_id: i64,
    pub tmdb_id: i64,
    pub media_type: String,
    pub embedding: Vec<f32>,
    pub computed_affinity_score: f64,
    pub updated_at: String,
}

/// Little-endian f32 packing for the `embedding_blob` column (384 dims => 1536 bytes).
pub fn encode_embedding(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

pub fn decode_embedding(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

fn map_embedding(r: &Row<'_>) -> rusqlite::Result<EmbeddingRecord> {
    let blob: Vec<u8> = r.get(3)?;
    Ok(EmbeddingRecord {
        app_profile_id: r.get(0)?,
        tmdb_id: r.get(1)?,
        media_type: r.get(2)?,
        embedding: decode_embedding(&blob),
        computed_affinity_score: r.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
        updated_at: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
    })
}

pub fn upsert_embedding(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
    embedding: &[f32],
    affinity: f64,
) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO media_embeddings (app_profile_id, tmdb_id, media_type, embedding_blob,
            computed_affinity_score, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT(app_profile_id, tmdb_id, media_type) DO UPDATE SET
            embedding_blob = excluded.embedding_blob,
            computed_affinity_score = excluded.computed_affinity_score,
            updated_at = excluded.updated_at",
        params![app_profile_id, tmdb_id, media_type, encode_embedding(embedding), affinity],
    )?;
    Ok(())
}

pub fn update_affinity(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
    affinity: f64,
) -> rusqlite::Result<bool> {
    Ok(c.execute(
        "UPDATE media_embeddings SET computed_affinity_score = ?4, updated_at = datetime('now')
         WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3",
        params![app_profile_id, tmdb_id, media_type, affinity],
    )? > 0)
}

pub fn get_embedding(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
) -> rusqlite::Result<Option<EmbeddingRecord>> {
    c.query_row(
        "SELECT app_profile_id, tmdb_id, media_type, embedding_blob, computed_affinity_score, updated_at
         FROM media_embeddings WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3",
        params![app_profile_id, tmdb_id, media_type],
        map_embedding,
    )
    .optional()
}

/// Writes many (tmdb_id, media_type, vector, affinity) rows for one profile atomically.
pub fn upsert_embeddings_batch(
    c: &mut Connection,
    app_profile_id: i64,
    rows: &[(i64, String, Vec<f32>, f64)],
) -> rusqlite::Result<usize> {
    let tx = c.transaction()?;
    for (tmdb_id, media_type, vector, affinity) in rows {
        upsert_embedding(&tx, app_profile_id, *tmdb_id, media_type, vector, *affinity)?;
    }
    tx.commit()?;
    Ok(rows.len())
}

/// Drops every stored vector (all profiles) — used when the embedding model changes, since
/// vectors from different models live in incompatible spaces.
pub fn clear_all_embeddings(c: &Connection) -> rusqlite::Result<usize> {
    c.execute("DELETE FROM media_embeddings", [])
}

pub fn list_embeddings(c: &Connection, app_profile_id: i64) -> rusqlite::Result<Vec<EmbeddingRecord>> {
    collect_rows(
        c,
        "SELECT app_profile_id, tmdb_id, media_type, embedding_blob, computed_affinity_score, updated_at
         FROM media_embeddings WHERE app_profile_id = ?1",
        [app_profile_id],
        map_embedding,
    )
}

// ---------------------------------------------------------------------------------------------
// 10. custom_hubs
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomHub {
    pub hub_slug: String,
    pub display_name: String,
    pub category_type: String,
    #[serde(default)]
    pub logo_asset: Option<String>,
    #[serde(default)]
    pub hero_video_asset: Option<String>,
    /// The TMDB discover rule set (companies, networks, keywords, genres, certifications...).
    pub tmdb_filter_rule: Value,
    #[serde(default)]
    pub sort_order: i64,
}

fn map_hub(r: &Row<'_>) -> rusqlite::Result<CustomHub> {
    let rule: String = r.get(5)?;
    Ok(CustomHub {
        hub_slug: r.get(0)?,
        display_name: r.get(1)?,
        category_type: r.get(2)?,
        logo_asset: r.get(3)?,
        hero_video_asset: r.get(4)?,
        tmdb_filter_rule: serde_json::from_str(&rule).unwrap_or(Value::Null),
        sort_order: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
    })
}

const HUB_COLS: &str =
    "hub_slug, display_name, category_type, logo_asset, hero_video_asset, tmdb_filter_Rule_json, sort_order";

pub fn list_hubs(c: &Connection, category_type: Option<&str>) -> rusqlite::Result<Vec<CustomHub>> {
    collect_rows(
        c,
        &format!(
            "SELECT {HUB_COLS} FROM custom_hubs
             WHERE (?1 IS NULL OR category_type = ?1)
             ORDER BY sort_order, display_name COLLATE NOCASE"
        ),
        [category_type],
        map_hub,
    )
}

pub fn get_hub(c: &Connection, hub_slug: &str) -> rusqlite::Result<Option<CustomHub>> {
    c.query_row(
        &format!("SELECT {HUB_COLS} FROM custom_hubs WHERE hub_slug = ?1"),
        [hub_slug],
        map_hub,
    )
    .optional()
}

pub fn upsert_hub(c: &Connection, h: &CustomHub) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO custom_hubs (hub_slug, display_name, category_type, logo_asset, hero_video_asset,
            tmdb_filter_Rule_json, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(hub_slug) DO UPDATE SET
            display_name = excluded.display_name,
            category_type = excluded.category_type,
            logo_asset = excluded.logo_asset,
            hero_video_asset = excluded.hero_video_asset,
            tmdb_filter_Rule_json = excluded.tmdb_filter_Rule_json,
            sort_order = excluded.sort_order",
        params![
            h.hub_slug,
            h.display_name,
            h.category_type,
            h.logo_asset,
            h.hero_video_asset,
            h.tmdb_filter_rule.to_string(),
            h.sort_order
        ],
    )?;
    Ok(())
}

pub fn upsert_hubs_batch(c: &mut Connection, hubs: &[CustomHub]) -> rusqlite::Result<usize> {
    let tx = c.transaction()?;
    for h in hubs {
        upsert_hub(&tx, h)?;
    }
    tx.commit()?;
    Ok(hubs.len())
}

pub fn delete_hub(c: &Connection, hub_slug: &str) -> rusqlite::Result<bool> {
    Ok(c.execute("DELETE FROM custom_hubs WHERE hub_slug = ?1", [hub_slug])? > 0)
}

// ---------------------------------------------------------------------------------------------
// 11. watchlist
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistItem {
    pub app_profile_id: i64,
    pub tmdb_id: i64,
    pub media_type: String,
    pub added_at: String,
    pub title: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub release_year: Option<i64>,
    pub vote_average: Option<f64>,
}

pub fn add_to_watchlist(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
) -> rusqlite::Result<()> {
    c.execute(
        "INSERT OR IGNORE INTO watchlist (app_profile_id, tmdb_id, media_type, added_at)
         VALUES (?1, ?2, ?3, datetime('now'))",
        params![app_profile_id, tmdb_id, media_type],
    )?;
    Ok(())
}

pub fn remove_from_watchlist(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
) -> rusqlite::Result<bool> {
    Ok(c.execute(
        "DELETE FROM watchlist WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3",
        params![app_profile_id, tmdb_id, media_type],
    )? > 0)
}

pub fn is_in_watchlist(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM watchlist
                       WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3)",
        params![app_profile_id, tmdb_id, media_type],
        |r| r.get(0),
    )
}

pub fn list_watchlist(c: &Connection, app_profile_id: i64) -> rusqlite::Result<Vec<WatchlistItem>> {
    collect_rows(
        c,
        "SELECT wl.app_profile_id, wl.tmdb_id, wl.media_type, wl.added_at,
                mc.title, mc.poster_path, mc.backdrop_path, mc.release_year, mc.vote_average
         FROM watchlist wl
         LEFT JOIN media_catalog mc ON mc.tmdb_id = wl.tmdb_id AND mc.media_type = wl.media_type
         WHERE wl.app_profile_id = ?1
         ORDER BY wl.added_at DESC",
        [app_profile_id],
        |r| {
            Ok(WatchlistItem {
                app_profile_id: r.get(0)?,
                tmdb_id: r.get(1)?,
                media_type: r.get(2)?,
                added_at: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                title: r.get(4)?,
                poster_path: r.get(5)?,
                backdrop_path: r.get(6)?,
                release_year: r.get(7)?,
                vote_average: r.get(8)?,
            })
        },
    )
}

/// "Remove from Continue Watching": hides the title until it is watched again. History is kept.
pub fn hide_from_continue_watching(c: &Connection, app_profile_id: i64, tmdb_id: i64, media_type: &str) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO continue_watching_hidden (app_profile_id, tmdb_id, media_type, hidden_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(app_profile_id, tmdb_id, media_type) DO UPDATE SET hidden_at = excluded.hidden_at",
        params![app_profile_id, tmdb_id, media_type],
    )?;
    Ok(())
}

pub fn unhide_from_continue_watching(c: &Connection, app_profile_id: i64, tmdb_id: i64, media_type: &str) -> rusqlite::Result<bool> {
    Ok(c.execute(
        "DELETE FROM continue_watching_hidden WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3",
        params![app_profile_id, tmdb_id, media_type],
    )? > 0)
}

// ---------------------------------------------------------------------------------------------
// 12. preferred_providers
// ---------------------------------------------------------------------------------------------

/// The OTT a profile chose for a title ("Where do you want to watch this?"). `provider_id` is
/// canonical, so it matches every monetisation variant of that service.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreferredProvider {
    pub app_profile_id: i64,
    pub tmdb_id: i64,
    pub media_type: String,
    pub provider_id: i64,
    pub provider_name: String,
    pub updated_at: String,
}

pub fn get_preferred_provider(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
) -> rusqlite::Result<Option<PreferredProvider>> {
    c.query_row(
        "SELECT app_profile_id, tmdb_id, media_type, provider_id, provider_name, updated_at
         FROM preferred_providers WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3",
        params![app_profile_id, tmdb_id, media_type],
        |r| {
            Ok(PreferredProvider {
                app_profile_id: r.get(0)?,
                tmdb_id: r.get(1)?,
                media_type: r.get(2)?,
                provider_id: r.get(3)?,
                provider_name: r.get(4)?,
                updated_at: r.get(5)?,
            })
        },
    )
    .optional()
}

pub fn set_preferred_provider(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
    provider_id: i64,
    provider_name: &str,
) -> rusqlite::Result<PreferredProvider> {
    c.execute(
        "INSERT INTO preferred_providers (app_profile_id, tmdb_id, media_type, provider_id, provider_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT(app_profile_id, tmdb_id, media_type) DO UPDATE SET
            provider_id = excluded.provider_id,
            provider_name = excluded.provider_name,
            updated_at = excluded.updated_at",
        params![app_profile_id, tmdb_id, media_type, provider_id, provider_name],
    )?;
    get_preferred_provider(c, app_profile_id, tmdb_id, media_type)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn clear_preferred_provider(c: &Connection, app_profile_id: i64, tmdb_id: i64, media_type: &str) -> rusqlite::Result<bool> {
    Ok(c.execute(
        "DELETE FROM preferred_providers WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3",
        params![app_profile_id, tmdb_id, media_type],
    )? > 0)
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        crate::db::configure(&c).unwrap();
        crate::db::migrate(&mut c).unwrap();
        ensure_default_profile(&c).unwrap();
        ensure_default_settings(&c).unwrap();
        c
    }

    fn sample_update(progress: f64, duration: f64) -> ProgressUpdate {
        ProgressUpdate {
            app_profile_id: 1,
            tmdb_id: 603,
            media_type: "movie".into(),
            season_number: 0,
            episode_number: 0,
            episode_title: None,
            provider_name: Some("Netflix".into()),
            direct_url: None,
            progress_seconds: progress,
            duration_seconds: duration,
        }
    }

    #[test]
    fn hiding_from_continue_watching_keeps_history_until_rewatched() {
        let c = test_db();
        record_progress(&c, &sample_update(600.0, 8160.0)).unwrap();
        assert_eq!(continue_watching(&c, 1, 30).unwrap().len(), 1);

        hide_from_continue_watching(&c, 1, 603, "movie").unwrap();
        assert!(continue_watching(&c, 1, 30).unwrap().is_empty());
        // History itself is untouched.
        assert_eq!(get_title_history(&c, 1, 603, "movie").unwrap().len(), 1);

        // Watching again after the hide brings it back.
        c.execute("UPDATE continue_watching_hidden SET hidden_at = datetime('now', '-1 hour')", []).unwrap();
        record_progress(&c, &sample_update(900.0, 8160.0)).unwrap();
        assert_eq!(continue_watching(&c, 1, 30).unwrap().len(), 1);

        hide_from_continue_watching(&c, 1, 603, "movie").unwrap();
        assert!(unhide_from_continue_watching(&c, 1, 603, "movie").unwrap());
        assert_eq!(continue_watching(&c, 1, 30).unwrap().len(), 1);
    }

    #[test]
    fn clearing_history_only_touches_the_active_profile() {
        let mut c = test_db();
        let other = create_profile(&c, "Clara", None, false).unwrap();
        record_progress(&c, &sample_update(600.0, 8160.0)).unwrap();
        let mut theirs = sample_update(300.0, 8160.0);
        theirs.app_profile_id = other.profile_id;
        record_progress(&c, &theirs).unwrap();
        insert_playback_event(&c, 1, 603, "movie", "pause", 10.0).unwrap();
        insert_playback_event(&c, other.profile_id, 603, "movie", "pause", 10.0).unwrap();
        hide_from_continue_watching(&c, 1, 603, "movie").unwrap();

        let cleared = clear_profile_history(&mut c, 1).unwrap();
        assert_eq!(cleared, ClearedHistory { history_rows: 1, playback_events: 1 });
        assert!(get_title_history(&c, 1, 603, "movie").unwrap().is_empty());
        let hidden: i64 = c
            .query_row("SELECT COUNT(*) FROM continue_watching_hidden WHERE app_profile_id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hidden, 0);
        // The other profile keeps everything.
        assert_eq!(get_title_history(&c, other.profile_id, 603, "movie").unwrap().len(), 1);
        let events: i64 = c
            .query_row("SELECT COUNT(*) FROM playback_events WHERE app_profile_id = ?1", [other.profile_id], |r| r.get(0))
            .unwrap();
        assert_eq!(events, 1);
    }

    #[test]
    fn preferred_provider_is_per_profile_and_cascades() {
        let mut c = test_db();
        let other = create_profile(&c, "Clara", None, false).unwrap();
        set_preferred_provider(&c, 1, 1668, "tv", 8, "Netflix").unwrap();
        set_preferred_provider(&c, other.profile_id, 1668, "tv", 122, "JioHotstar").unwrap();
        assert_eq!(get_preferred_provider(&c, 1, 1668, "tv").unwrap().unwrap().provider_id, 8);
        assert_eq!(get_preferred_provider(&c, other.profile_id, 1668, "tv").unwrap().unwrap().provider_id, 122);
        assert!(get_preferred_provider(&c, 1, 1668, "movie").unwrap().is_none());

        // Changing the choice overwrites it.
        let p = set_preferred_provider(&c, 1, 1668, "tv", 9, "Prime Video").unwrap();
        assert_eq!((p.provider_id, p.provider_name.as_str()), (9, "Prime Video"));

        assert!(clear_preferred_provider(&c, 1, 1668, "tv").unwrap());
        assert!(get_preferred_provider(&c, 1, 1668, "tv").unwrap().is_none());

        // Deleting a profile removes its choices.
        assert!(delete_profile(&mut c, other.profile_id).unwrap());
        assert!(get_preferred_provider(&c, other.profile_id, 1668, "tv").unwrap().is_none());
    }

    #[test]
    fn migrations_are_idempotent_and_seed_defaults() {
        let mut c = test_db();
        crate::db::migrate(&mut c).unwrap();
        assert_eq!(list_profiles(&c).unwrap().len(), 1);
        assert_eq!(get_setting(&c, keys::ACTIVE_PROFILE_ID).unwrap().as_deref(), Some("1"));
        assert_eq!(get_setting(&c, keys::SUBSCRIPTIONS_ONLY).unwrap().as_deref(), Some("false"));
    }

    #[test]
    fn progress_completion_and_rewatch() {
        let c = test_db();
        let e = record_progress(&c, &sample_update(600.0, 8160.0)).unwrap();
        assert!(!e.is_completed);
        assert!((e.completion_ratio - 600.0 / 8160.0).abs() < 1e-9);

        let e = record_progress(&c, &sample_update(8100.0, 8160.0)).unwrap();
        assert!(e.is_completed);
        assert_eq!(e.watch_count, 1);

        // Restart from the beginning => rewatch.
        let e = record_progress(&c, &sample_update(12.0, 8160.0)).unwrap();
        assert!(!e.is_completed);
        assert_eq!(e.watch_count, 2);

        // Continuing the rewatch must not increment again.
        let e = record_progress(&c, &sample_update(300.0, 8160.0)).unwrap();
        assert_eq!(e.watch_count, 2);
    }

    #[test]
    fn continue_watching_one_card_per_series() {
        let c = test_db();
        for ep in 1..=3 {
            let mut u = sample_update(900.0, 2700.0);
            u.tmdb_id = 66732;
            u.media_type = "tv".into();
            u.season_number = 1;
            u.episode_number = ep;
            record_progress(&c, &u).unwrap();
        }
        record_progress(&c, &sample_update(10.0, 8160.0)).unwrap(); // < 30s, excluded
        let rows = continue_watching(&c, 1, 20).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].entry.tmdb_id, 66732);
    }

    #[test]
    fn deep_link_cache_roundtrip_and_expiry() {
        let mut c = test_db();
        let link = DeepLink {
            tmdb_id: 603,
            media_type: "movie".into(),
            region_code: "IN".into(),
            provider_id: 8,
            provider_name: "Netflix".into(),
            monetization_type: "flatrate".into(),
            direct_url: "https://www.netflix.com/title/20557937".into(),
            quality: Some("HD".into()),
            expires_at: None,
            resolved_at: None,
        };
        replace_deep_links(&mut c, 603, "movie", "IN", &[(link, 168)]).unwrap();
        assert_eq!(get_valid_deep_links(&c, 603, "movie", "IN").unwrap().len(), 1);
        assert!(get_valid_deep_links(&c, 603, "movie", "US").unwrap().is_empty());
        c.execute("UPDATE deep_links SET expires_at = datetime('now', '-1 hours')", []).unwrap();
        assert!(get_valid_deep_links(&c, 603, "movie", "IN").unwrap().is_empty());
        assert_eq!(purge_expired_deep_links(&c).unwrap(), 1);
    }

    #[test]
    fn history_with_media_joins_parent_title() {
        let c = test_db();
        upsert_media(
            &c,
            &MediaCatalogEntry {
                tmdb_id: 1668,
                media_type: "tv".into(),
                title: "Friends".into(),
                original_title: None,
                overview: None,
                poster_path: Some("/friends.jpg".into()),
                backdrop_path: Some("/friends-bg.jpg".into()),
                release_year: Some(1994),
                runtime_mins: None,
                genres: None,
                keywords: None,
                credits: None,
                vote_average: None,
                certification: None,
                updated_at: None,
            },
        )
        .unwrap();
        let mut u = sample_update(300.0, 1320.0);
        u.tmdb_id = 1668;
        u.media_type = "tv".into();
        u.season_number = 2;
        u.episode_number = 1;
        u.episode_title = Some("The One with Ross's New Girlfriend".into());
        record_progress(&c, &u).unwrap();
        let rows = list_history_with_media(&c, 1, 10, 0).unwrap();
        assert_eq!(rows[0].title.as_deref(), Some("Friends"));
        assert_eq!(rows[0].poster_path.as_deref(), Some("/friends.jpg"));
        assert_eq!((rows[0].entry.season_number, rows[0].entry.episode_number), (2, 1));
    }

    #[test]
    fn mapping_rekey_merges_variants() {
        let c = test_db();
        let m = |provider_id: i64, id: &str| OttProfileMapping {
            app_profile_id: 1,
            provider_id,
            ott_native_profile_id: id.into(),
            ott_native_profile_name: None,
        };
        upsert_ott_mapping(&c, &m(119, "P1")).unwrap();
        rekey_ott_mapping(&c, 1, 119, 9).unwrap();
        assert_eq!(get_ott_mapping(&c, 1, 9).unwrap().unwrap().ott_native_profile_id, "P1");
        upsert_ott_mapping(&c, &m(2100, "P2")).unwrap();
        rekey_ott_mapping(&c, 1, 2100, 9).unwrap();
        assert_eq!(get_ott_mapping(&c, 1, 9).unwrap().unwrap().ott_native_profile_id, "P1");
        assert!(get_ott_mapping(&c, 1, 2100).unwrap().is_none());
    }

    #[test]
    fn embeddings_roundtrip() {
        let c = test_db();
        let v: Vec<f32> = (0..384).map(|i| i as f32 / 384.0).collect();
        upsert_embedding(&c, 1, 603, "movie", &v, 1.5).unwrap();
        let rec = get_embedding(&c, 1, 603, "movie").unwrap().unwrap();
        assert_eq!(rec.embedding, v);
        assert_eq!(rec.computed_affinity_score, 1.5);
    }

    #[test]
    fn profile_delete_cascades_and_keeps_last() {
        let mut c = test_db();
        assert!(!delete_profile(&mut c, 1).unwrap());
        let p = create_profile(&c, "Kids", None, true).unwrap();
        add_to_watchlist(&c, p.profile_id, 603, "movie").unwrap();
        set_setting(&c, keys::ACTIVE_PROFILE_ID, &p.profile_id.to_string()).unwrap();
        assert!(delete_profile(&mut c, p.profile_id).unwrap());
        assert!(list_watchlist(&c, p.profile_id).unwrap().is_empty());
        assert_eq!(get_setting(&c, keys::ACTIVE_PROFILE_ID).unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn import_is_idempotent() {
        let mut c = test_db();
        let row = HistoryImport {
            app_profile_id: 1,
            tmdb_id: 1396,
            media_type: "tv".into(),
            season_number: 1,
            episode_number: 1,
            episode_title: Some("Pilot".into()),
            provider_name: Some("Netflix".into()),
            direct_url: None,
            progress_seconds: 3480.0,
            duration_seconds: 3480.0,
            is_completed: true,
            watched_at: Some("2025-01-10T21:30:00Z".into()),
            time_of_day_bucket: Some("PrimeTime".into()),
            watch_count: Some(2),
        };
        upsert_imported_history(&mut c, &[row.clone(), row]).unwrap();
        let rows = get_title_history(&c, 1, 1396, "tv").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].is_completed);
        assert_eq!(rows[0].last_watched_at, "2025-01-10 21:30:00");
        assert_eq!(rows[0].watch_count, 2);
    }

    #[test]
    fn imported_history_is_silent_until_played_in_omnia() {
        let mut c = test_db();
        // Half-watched episode imported with its real (old) Netflix date, plus an unfinished movie.
        let episode = HistoryImport {
            app_profile_id: 1,
            tmdb_id: 1396,
            media_type: "tv".into(),
            season_number: 2,
            episode_number: 3,
            episode_title: None,
            provider_name: Some("Netflix".into()),
            direct_url: None,
            progress_seconds: 1200.0,
            duration_seconds: 2700.0,
            is_completed: false,
            watched_at: Some("2019-03-04T22:15:00Z".into()),
            time_of_day_bucket: None,
            watch_count: None,
        };
        let movie = HistoryImport { tmdb_id: 603, media_type: "movie".into(), season_number: 0, episode_number: 0, ..episode.clone() };
        upsert_imported_history(&mut c, &[episode.clone(), movie]).unwrap();

        // Feeds history (with the source's date), but not Continue Watching.
        let history = get_title_history(&c, 1, 1396, "tv").unwrap();
        assert_eq!(history[0].last_watched_at, "2019-03-04 22:15:00");
        assert!(continue_watching(&c, 1, 20).unwrap().is_empty());

        // Played in Omnia today: the series graduates; the untouched movie stays silent.
        let mut live = sample_update(1300.0, 2700.0);
        live.tmdb_id = 1396;
        live.media_type = "tv".into();
        live.season_number = 2;
        live.episode_number = 3;
        record_progress(&c, &live).unwrap();
        let rows = continue_watching(&c, 1, 20).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].entry.tmdb_id, 1396);

        // Re-importing older activity never silences a title played in Omnia.
        upsert_imported_history(&mut c, &[episode]).unwrap();
        assert_eq!(continue_watching(&c, 1, 20).unwrap().len(), 1);
    }
}
