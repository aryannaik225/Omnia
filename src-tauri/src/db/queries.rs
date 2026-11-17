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
                             AND wl.tmdb_id = mc.tmdb_id AND wl.media_type = mc.media_type)
                OR EXISTS (SELECT 1 FROM favorites f WHERE f.app_profile_id = ?1
                             AND f.tmdb_id = mc.tmdb_id AND f.media_type = mc.media_type)"
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

/// One "Recently watched" card: the title's most recent history row plus how many rows it has.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTitle {
    #[serde(flatten)]
    pub latest: HistoryWithMedia,
    pub entry_count: i64,
}

/// Recently watched titles, grouped in SQL (one row per title, newest first) so a lifetime
/// import of thousands of episodes pages by *title* instead of hiding older shows behind the
/// newest few hundred episode rows. Rows kept without an episode number are included.
/// Watch History platform filter: rows stored under these provider names, plus (optionally)
/// rows with no provider at all ("Offline / Manual": Mark as Watched, file imports).
#[derive(Debug, Clone, Default)]
pub struct HistoryProviderFilter {
    pub names: Vec<String>,
    pub include_unattributed: bool,
}

pub fn list_history_titles(
    c: &Connection,
    app_profile_id: i64,
    limit: i64,
    offset: i64,
) -> rusqlite::Result<Vec<HistoryTitle>> {
    list_history_titles_filtered(c, app_profile_id, limit, offset, None)
}

pub fn list_history_titles_filtered(
    c: &Connection,
    app_profile_id: i64,
    limit: i64,
    offset: i64,
    filter: Option<&HistoryProviderFilter>,
) -> rusqlite::Result<Vec<HistoryTitle>> {
    let names_json = filter.map(|f| serde_json::to_string(&f.names).unwrap_or_else(|_| "[]".into()));
    let unattributed = filter.is_some_and(|f| f.include_unattributed);
    let cols = WATCH_COLS
        .split(", ")
        .map(|col| format!("wh.{}", col.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    collect_rows(
        c,
        &format!(
            "WITH ranked AS (
                 SELECT *,
                        ROW_NUMBER() OVER (PARTITION BY tmdb_id, media_type ORDER BY last_watched_at DESC, id DESC) AS rn,
                        COUNT(*) OVER (PARTITION BY tmdb_id, media_type) AS entry_count
                 FROM watch_history WHERE app_profile_id = ?1
                   AND (?4 IS NULL
                        OR provider_name IN (SELECT value FROM json_each(?4))
                        OR (?5 = 1 AND (provider_name IS NULL OR provider_name = '')))
             )
             SELECT {cols}, mc.title, mc.poster_path, mc.backdrop_path, mc.release_year, wh.entry_count
             FROM ranked wh
             LEFT JOIN media_catalog mc ON mc.tmdb_id = wh.tmdb_id AND mc.media_type = wh.media_type
             WHERE wh.rn = 1
             ORDER BY wh.last_watched_at DESC, wh.id DESC
             LIMIT ?2 OFFSET ?3"
        ),
        params![app_profile_id, limit.clamp(1, 10_000), offset.max(0), names_json, unattributed],
        |r| {
            Ok(HistoryTitle {
                latest: HistoryWithMedia {
                    entry: map_watch(r)?,
                    title: r.get(17)?,
                    poster_path: r.get(18)?,
                    backdrop_path: r.get(19)?,
                    release_year: r.get(20)?,
                },
                entry_count: r.get(21)?,
            })
        },
    )
}

/// Removes every history row of one title (all its episodes) for one profile.
pub fn delete_title_history(c: &Connection, app_profile_id: i64, tmdb_id: i64, media_type: &str) -> rusqlite::Result<usize> {
    c.execute(
        "DELETE FROM watch_history WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3",
        params![app_profile_id, tmdb_id, media_type],
    )
}

/// History row counts per stored provider name for one profile (rows without one are skipped).
/// Rows without a provider (Mark as Watched, file imports) are reported under "".
pub fn history_provider_names(c: &Connection, app_profile_id: i64) -> rusqlite::Result<Vec<(String, i64)>> {
    collect_rows(
        c,
        "SELECT COALESCE(provider_name, ''), COUNT(*) FROM watch_history
         WHERE app_profile_id = ?1
         GROUP BY COALESCE(provider_name, '')",
        params![app_profile_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// "Clear by provider": deletes only this profile's history rows recorded under the given
/// provider names (one provider family), in one transaction. Other providers are untouched.
pub fn clear_provider_history(c: &mut Connection, app_profile_id: i64, provider_names: &[String]) -> rusqlite::Result<usize> {
    let tx = c.transaction()?;
    let mut removed = 0;
    for name in provider_names {
        removed += tx.execute(
            "DELETE FROM watch_history WHERE app_profile_id = ?1 AND provider_name = ?2",
            params![app_profile_id, name],
        )?;
    }
    tx.commit()?;
    Ok(removed)
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
    tx.execute("DELETE FROM airing_checks WHERE app_profile_id = ?1", params![app_profile_id])?;
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
    /// Recorded with "Mark as Watched" (not played in a provider).
    pub is_manual: bool,
    /// A caught-up airing series that has a new episode out (S/E and air date), from `airing_checks`.
    pub new_episode: Option<NewEpisode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewEpisode {
    pub season_number: i64,
    pub episode_number: i64,
    pub air_date: String,
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
            "SELECT {cols}, mc.title, mc.poster_path, mc.backdrop_path, mc.release_year, mc.runtime_mins,
                    w.is_manual, a.new_season, a.new_episode, a.new_air_date
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
             LEFT JOIN airing_checks a
                ON a.app_profile_id = w.app_profile_id AND a.tmdb_id = w.tmdb_id AND w.media_type = 'tv'
             WHERE w.rn = 1
               -- Hidden by the user, unless watched again (or a new episode aired) after hiding.
               AND (h.hidden_at IS NULL OR w.last_watched_at > h.hidden_at OR a.new_air_date > date(h.hidden_at))
               AND (
                -- Silent import: in-progress / Up Next only for titles last played in Omnia.
                (w.is_imported = 0 AND (
                    (w.is_completed = 0 AND w.progress_seconds >= 30)
                    OR (w.media_type = 'tv' AND w.is_completed = 1
                        AND w.last_watched_at >= datetime('now', '-30 days'))
                    -- Mark as Watched: a movie stays visible for a week as a confirmation.
                    OR (w.is_manual = 1 AND w.last_watched_at >= datetime('now', '-7 days'))))
                -- An airing show you were caught up on has a new episode (imported or not).
                OR (w.media_type = 'tv' AND w.is_completed = 1 AND a.new_air_date IS NOT NULL
                    AND a.new_air_date > date(w.last_watched_at))
             )
             ORDER BY COALESCE(MAX(a.new_air_date, date(w.last_watched_at)), w.last_watched_at) DESC, w.last_watched_at DESC
             LIMIT ?2"
        ),
        params![app_profile_id, limit.clamp(1, 200)],
        |r| {
            let entry = map_watch(r)?;
            let up_next = entry.is_completed && entry.media_type == "tv";
            let new_episode = match (r.get::<_, Option<i64>>(23)?, r.get::<_, Option<i64>>(24)?, r.get::<_, Option<String>>(25)?) {
                (Some(season_number), Some(episode_number), Some(air_date)) if up_next => Some(NewEpisode { season_number, episode_number, air_date }),
                _ => None,
            };
            Ok(ContinueWatchingItem {
                entry,
                title: r.get(17)?,
                poster_path: r.get(18)?,
                backdrop_path: r.get(19)?,
                release_year: r.get(20)?,
                runtime_mins: r.get(21)?,
                up_next,
                is_manual: r.get(22)?,
                new_episode,
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
    /// Used only when the row is created and `watched_at` is missing (keeps a source's order).
    #[serde(default)]
    pub fallback_watched_at: Option<String>,
    #[serde(default)]
    pub time_of_day_bucket: Option<String>,
    /// Number of distinct viewings in the source (rewatch signal). Never lowers an existing count.
    #[serde(default)]
    pub watch_count: Option<i64>,
    /// Fresh activity from a background delta sync (e.g. watched on a phone since the last
    /// sync): stored as live, so it reaches Continue Watching like playback in Omnia would.
    #[serde(default)]
    pub live: bool,
}

/// Idempotent bulk import: re-importing the same activity never duplicates rows or rolls back
/// newer live telemetry. Rows keep the source's own watch date and are stored as imported
/// (`is_imported = 1`, "silent"): they feed the recommender and the history view but not
/// Continue Watching. A row already played in Omnia stays live. Returns the rows processed.
pub fn upsert_imported_history(c: &mut Connection, rows: &[HistoryImport]) -> rusqlite::Result<usize> {
    upsert_imported_history_tracked(c, rows).map(|(processed, _)| processed)
}

/// [`upsert_imported_history`], also counting rows that are new or whose date, progress,
/// completion or live state actually changed (a background sync's "new activity").
pub fn upsert_imported_history_tracked(c: &mut Connection, rows: &[HistoryImport]) -> rusqlite::Result<(usize, usize)> {
    let tx = c.transaction()?;
    let mut changed = 0usize;
    {
        type Snap = (String, f64, bool, bool);
        let mut probe = tx.prepare(
            "SELECT last_watched_at, progress_seconds, is_completed, is_imported FROM watch_history
             WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3 AND season_number = ?4 AND episode_number = ?5",
        )?;
        let mut snap = |row: &HistoryImport| -> rusqlite::Result<Option<Snap>> {
            probe
                .query_row(params![row.app_profile_id, row.tmdb_id, row.media_type, row.season_number, row.episode_number], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .optional()
        };
        let mut stmt = tx.prepare(
            "INSERT INTO watch_history (app_profile_id, tmdb_id, media_type, season_number, episode_number,
                episode_title, provider_name, direct_url, progress_seconds, duration_seconds, is_completed,
                watch_count, abandoned, last_watched_at, time_of_day_bucket, is_imported)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, MAX(1, COALESCE(?14, 1)), 0,
                     COALESCE(datetime(?12), datetime(?16), datetime('now')), ?13, CASE WHEN ?15 THEN 0 ELSE 1 END)
             ON CONFLICT(app_profile_id, tmdb_id, media_type, season_number, episode_number) DO UPDATE SET
                episode_title = COALESCE(watch_history.episode_title, excluded.episode_title),
                provider_name = COALESCE(watch_history.provider_name, excluded.provider_name),
                direct_url = COALESCE(watch_history.direct_url, excluded.direct_url),
                -- An entry without a date (a Continue Watching tile) counts as new activity only
                -- when its progress moved; then it is stamped now, otherwise its date is kept.
                is_imported = CASE
                    WHEN ?15 AND (
                        (?12 IS NOT NULL AND excluded.last_watched_at > watch_history.last_watched_at)
                        OR (?12 IS NULL AND ABS(excluded.progress_seconds - watch_history.progress_seconds) > 30))
                    THEN 0 ELSE watch_history.is_imported END,
                progress_seconds = CASE
                    WHEN ?12 IS NULL THEN CASE WHEN ABS(excluded.progress_seconds - watch_history.progress_seconds) > 30
                                               THEN excluded.progress_seconds ELSE watch_history.progress_seconds END
                    WHEN excluded.last_watched_at > watch_history.last_watched_at THEN excluded.progress_seconds
                    ELSE watch_history.progress_seconds END,
                duration_seconds = CASE WHEN watch_history.duration_seconds <= 1
                                        THEN excluded.duration_seconds
                                        ELSE watch_history.duration_seconds END,
                is_completed = MAX(watch_history.is_completed, excluded.is_completed),
                watch_count = MAX(watch_history.watch_count, excluded.watch_count),
                last_watched_at = CASE
                    WHEN ?12 IS NULL THEN CASE WHEN ?15 AND ABS(excluded.progress_seconds - watch_history.progress_seconds) > 30
                                               THEN datetime('now') ELSE watch_history.last_watched_at END
                    ELSE MAX(watch_history.last_watched_at, excluded.last_watched_at) END,
                time_of_day_bucket = COALESCE(watch_history.time_of_day_bucket, excluded.time_of_day_bucket)",
        )?;
        for row in rows {
            let before = snap(row)?;
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
                row.live,
                row.fallback_watched_at,
            ])?;
            let after = snap(row)?;
            let moved = match (&before, &after) {
                (None, Some(_)) => true,
                (Some(b), Some(a)) => b.0 != a.0 || (b.1 - a.1).abs() > 1.0 || b.2 != a.2 || b.3 != a.3,
                _ => false,
            };
            changed += usize::from(moved);
        }
    }
    tx.commit()?;
    Ok((rows.len(), changed))
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

// --- title_vectors (content-only composite vectors, migration v8) ----------------------------

/// (tmdb_id, media_type) -> (doc_hash, vector).
pub type StoredTitleVectors = HashMap<(i64, String), (String, Vec<f32>)>;

/// Stored vectors for `keys` under `model_id`.
pub fn get_title_vectors(c: &Connection, model_id: &str, keys: &[(i64, String)]) -> rusqlite::Result<StoredTitleVectors> {
    let mut stmt = c.prepare_cached(
        "SELECT doc_hash, vector_blob FROM title_vectors WHERE tmdb_id = ?1 AND media_type = ?2 AND model_id = ?3",
    )?;
    let mut out = HashMap::new();
    for (id, mt) in keys {
        let row = stmt
            .query_row(params![id, mt, model_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))
            .optional()?;
        if let Some((hash, blob)) = row {
            out.insert((*id, mt.clone()), (hash, decode_embedding(&blob)));
        }
    }
    Ok(out)
}

/// Upserts (tmdb_id, media_type, doc_hash, vector) rows for one model in a single transaction.
pub fn upsert_title_vectors(
    c: &mut Connection,
    model_id: &str,
    rows: &[(i64, String, String, Vec<f32>)],
) -> rusqlite::Result<usize> {
    let tx = c.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO title_vectors (tmdb_id, media_type, model_id, doc_hash, vector_blob, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
             ON CONFLICT(tmdb_id, media_type, model_id) DO UPDATE SET
                doc_hash = excluded.doc_hash,
                vector_blob = excluded.vector_blob,
                updated_at = excluded.updated_at",
        )?;
        for (id, mt, hash, v) in rows {
            stmt.execute(params![id, mt, model_id, hash, encode_embedding(v)])?;
        }
    }
    tx.commit()?;
    Ok(rows.len())
}

/// Drops vectors computed by any other model (they live in incompatible spaces).
pub fn prune_title_vectors(c: &Connection, keep_model_id: &str) -> rusqlite::Result<usize> {
    c.execute("DELETE FROM title_vectors WHERE model_id != ?1", [keep_model_id])
}

/// Catalog entries that already have a stored vector for `model_id`, with that vector (most
/// recently embedded first). The fast "More Like This" search space: nothing is embedded.
pub fn list_embedded_media(c: &Connection, model_id: &str, limit: i64) -> rusqlite::Result<Vec<(MediaCatalogEntry, Vec<f32>)>> {
    let cols = MEDIA_COLS.split(", ").map(|col| format!("mc.{}", col.trim())).collect::<Vec<_>>().join(", ");
    collect_rows(
        c,
        &format!(
            "SELECT {cols}, tv.vector_blob FROM title_vectors tv
             JOIN media_catalog mc ON mc.tmdb_id = tv.tmdb_id AND mc.media_type = tv.media_type
             WHERE tv.model_id = ?1
             ORDER BY tv.updated_at DESC LIMIT ?2"
        ),
        params![model_id, limit],
        |r| Ok((map_media(r)?, decode_embedding(&r.get::<_, Vec<u8>>(15)?))),
    )
}

/// Catalog entries with full metadata (keywords + credits), most recently refreshed first: the
/// local search space for "More Like This".
pub fn list_rich_media(c: &Connection, limit: i64) -> rusqlite::Result<Vec<MediaCatalogEntry>> {
    collect_rows(
        c,
        &format!(
            "SELECT {MEDIA_COLS} FROM media_catalog
             WHERE keywords_json IS NOT NULL AND keywords_json != 'null'
               AND credits_json IS NOT NULL AND credits_json != 'null'
             ORDER BY updated_at DESC LIMIT ?1"
        ),
        [limit],
        map_media,
    )
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
         ORDER BY wl.added_at DESC, wl.rowid DESC",
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

// ---------------------------------------------------------------------------------------------
// Manual tracking ("Mark as Watched")
// ---------------------------------------------------------------------------------------------

/// Records a title / episode as watched by hand (cinema, a local file, another device): a
/// completed, non-imported row without a provider. Marking again counts as a rewatch.
#[allow(clippy::too_many_arguments)]
pub fn mark_watched_manually(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
    season_number: i64,
    episode_number: i64,
    episode_title: Option<&str>,
    duration_seconds: Option<f64>,
) -> rusqlite::Result<WatchHistoryEntry> {
    mark_watched_manually_at(c, app_profile_id, tmdb_id, media_type, season_number, episode_number, episode_title, duration_seconds, 0)
}

/// One episode of a bulk "Mark season as watched".
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeMark {
    pub season_number: i64,
    pub episode_number: i64,
    #[serde(default)]
    pub episode_title: Option<String>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
}

/// "Mark season as watched" in one transaction. Episodes are stamped a second apart in episode
/// order (the last one now), so "latest watched" and the next-episode pick stay in story order.
pub fn mark_episodes_watched_manually(c: &mut Connection, app_profile_id: i64, tmdb_id: i64, episodes: &[EpisodeMark]) -> rusqlite::Result<usize> {
    let mut sorted: Vec<&EpisodeMark> = episodes.iter().filter(|e| e.season_number > 0 && e.episode_number > 0).collect();
    sorted.sort_by_key(|e| (e.season_number, e.episode_number));
    sorted.dedup_by_key(|e| (e.season_number, e.episode_number));
    let tx = c.transaction()?;
    let n = sorted.len();
    for (i, e) in sorted.iter().enumerate() {
        let seconds_ago = (n - 1 - i) as i64;
        mark_watched_manually_at(&tx, app_profile_id, tmdb_id, "tv", e.season_number, e.episode_number, e.episode_title.as_deref(), e.duration_seconds, seconds_ago)?;
    }
    tx.commit()?;
    Ok(n)
}

#[allow(clippy::too_many_arguments)]
fn mark_watched_manually_at(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
    season_number: i64,
    episode_number: i64,
    episode_title: Option<&str>,
    duration_seconds: Option<f64>,
    seconds_ago: i64,
) -> rusqlite::Result<WatchHistoryEntry> {
    let (season, episode) = if media_type == "tv" { (season_number.max(0), episode_number.max(0)) } else { (0, 0) };
    let duration = duration_seconds.filter(|d| d.is_finite() && *d > 1.0).unwrap_or(1.0);
    c.execute(
        "INSERT INTO watch_history
            (app_profile_id, tmdb_id, media_type, season_number, episode_number, episode_title, provider_name,
             progress_seconds, duration_seconds, is_completed, watch_count, abandoned, last_watched_at,
             time_of_day_bucket, is_imported, is_manual)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7, 1, 1, 0, datetime('now', ?9), ?8, 0, 1)
         ON CONFLICT(app_profile_id, tmdb_id, media_type, season_number, episode_number) DO UPDATE SET
            watch_count = watch_history.watch_count + CASE WHEN watch_history.is_completed = 1 THEN 1 ELSE 0 END,
            duration_seconds = MAX(watch_history.duration_seconds, excluded.duration_seconds),
            progress_seconds = MAX(watch_history.duration_seconds, excluded.duration_seconds),
            is_completed = 1,
            abandoned = 0,
            episode_title = COALESCE(watch_history.episode_title, excluded.episode_title),
            last_watched_at = excluded.last_watched_at,
            time_of_day_bucket = excluded.time_of_day_bucket,
            is_imported = 0,
            is_manual = 1",
        params![app_profile_id, tmdb_id, media_type, season, episode, episode_title, duration, current_time_of_day_bucket(), format!("-{} seconds", seconds_ago.max(0))],
    )?;
    get_history_entry(c, app_profile_id, tmdb_id, media_type, season, episode)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Undoes "Mark as Watched": a hand-made row (no provider) is deleted; a row that also came
/// from a provider just loses its manual flag (its real progress stays).
pub fn unmark_watched_manually(
    c: &Connection,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: &str,
    season_number: i64,
    episode_number: i64,
) -> rusqlite::Result<bool> {
    let (season, episode) = if media_type == "tv" { (season_number, episode_number) } else { (0, 0) };
    let deleted = c.execute(
        "DELETE FROM watch_history
          WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3 AND season_number = ?4 AND episode_number = ?5
            AND is_manual = 1 AND (provider_name IS NULL OR provider_name = '')",
        params![app_profile_id, tmdb_id, media_type, season, episode],
    )?;
    let updated = c.execute(
        "UPDATE watch_history SET is_manual = 0
          WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3 AND season_number = ?4 AND episode_number = ?5
            AND is_manual = 1",
        params![app_profile_id, tmdb_id, media_type, season, episode],
    )?;
    Ok(deleted + updated > 0)
}

// ---------------------------------------------------------------------------------------------
// Favorites ("Love")
// ---------------------------------------------------------------------------------------------

pub fn add_favorite(c: &Connection, app_profile_id: i64, tmdb_id: i64, media_type: &str) -> rusqlite::Result<()> {
    c.execute(
        "INSERT OR IGNORE INTO favorites (app_profile_id, tmdb_id, media_type, added_at) VALUES (?1, ?2, ?3, datetime('now'))",
        params![app_profile_id, tmdb_id, media_type],
    )?;
    Ok(())
}

pub fn remove_favorite(c: &Connection, app_profile_id: i64, tmdb_id: i64, media_type: &str) -> rusqlite::Result<bool> {
    Ok(c.execute(
        "DELETE FROM favorites WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3",
        params![app_profile_id, tmdb_id, media_type],
    )? > 0)
}

pub fn is_favorite(c: &Connection, app_profile_id: i64, tmdb_id: i64, media_type: &str) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM favorites WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3)",
        params![app_profile_id, tmdb_id, media_type],
        |r| r.get(0),
    )
}

/// Favorites with catalog metadata, newest first (same shape as the watchlist).
pub fn list_favorites(c: &Connection, app_profile_id: i64) -> rusqlite::Result<Vec<WatchlistItem>> {
    collect_rows(
        c,
        "SELECT f.app_profile_id, f.tmdb_id, f.media_type, f.added_at,
                mc.title, mc.poster_path, mc.backdrop_path, mc.release_year, mc.vote_average
         FROM favorites f
         LEFT JOIN media_catalog mc ON mc.tmdb_id = f.tmdb_id AND mc.media_type = f.media_type
         WHERE f.app_profile_id = ?1
         ORDER BY f.added_at DESC",
        [app_profile_id],
        map_listed_item,
    )
}

fn map_listed_item(r: &Row<'_>) -> rusqlite::Result<WatchlistItem> {
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
}

// ---------------------------------------------------------------------------------------------
// Collections (custom lists)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub collection_id: i64,
    pub app_profile_id: i64,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub item_count: i64,
    /// Up to four poster paths of the newest items (cover mosaic).
    pub cover_posters: Vec<String>,
}

/// Collection names: trimmed, 1-60 characters.
pub fn clean_collection_name(name: &str) -> Option<String> {
    let name: String = name.split_whitespace().collect::<Vec<_>>().join(" ");
    (!name.is_empty()).then(|| name.chars().take(60).collect())
}

fn collection_owned(c: &Connection, app_profile_id: i64, collection_id: i64) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE collection_id = ?1 AND app_profile_id = ?2)",
        params![collection_id, app_profile_id],
        |r| r.get(0),
    )
}

fn touch_collection(c: &Connection, collection_id: i64) -> rusqlite::Result<()> {
    c.execute("UPDATE collections SET updated_at = datetime('now') WHERE collection_id = ?1", [collection_id])?;
    Ok(())
}

pub fn list_collections(c: &Connection, app_profile_id: i64) -> rusqlite::Result<Vec<Collection>> {
    let mut rows = collect_rows(
        c,
        "SELECT col.collection_id, col.app_profile_id, col.name, col.created_at, col.updated_at,
                (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = col.collection_id)
         FROM collections col
         WHERE col.app_profile_id = ?1
         ORDER BY col.updated_at DESC, col.collection_id DESC",
        [app_profile_id],
        |r| {
            Ok(Collection {
                collection_id: r.get(0)?,
                app_profile_id: r.get(1)?,
                name: r.get(2)?,
                created_at: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                updated_at: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                item_count: r.get(5)?,
                cover_posters: Vec::new(),
            })
        },
    )?;
    for col in &mut rows {
        col.cover_posters = collect_rows(
            c,
            "SELECT mc.poster_path FROM collection_items ci
             JOIN media_catalog mc ON mc.tmdb_id = ci.tmdb_id AND mc.media_type = ci.media_type
             WHERE ci.collection_id = ?1 AND mc.poster_path IS NOT NULL
             ORDER BY ci.added_at DESC LIMIT 4",
            [col.collection_id],
            |r| r.get(0),
        )?;
    }
    Ok(rows)
}

/// Creates a collection; a name the profile already uses (case-insensitive) returns that one.
pub fn create_collection(c: &Connection, app_profile_id: i64, name: &str) -> rusqlite::Result<Option<Collection>> {
    let Some(name) = clean_collection_name(name) else {
        return Ok(None);
    };
    c.execute(
        "INSERT OR IGNORE INTO collections (app_profile_id, name, created_at, updated_at) VALUES (?1, ?2, datetime('now'), datetime('now'))",
        params![app_profile_id, name],
    )?;
    let id: i64 = c.query_row(
        "SELECT collection_id FROM collections WHERE app_profile_id = ?1 AND name = ?2 COLLATE NOCASE",
        params![app_profile_id, name],
        |r| r.get(0),
    )?;
    Ok(list_collections(c, app_profile_id)?.into_iter().find(|col| col.collection_id == id))
}

/// Renames a collection. `Ok(false)` when it isn't this profile's, or the name is empty / taken.
pub fn rename_collection(c: &Connection, app_profile_id: i64, collection_id: i64, name: &str) -> rusqlite::Result<bool> {
    let Some(name) = clean_collection_name(name) else {
        return Ok(false);
    };
    let taken: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE app_profile_id = ?1 AND name = ?2 COLLATE NOCASE AND collection_id <> ?3)",
        params![app_profile_id, name, collection_id],
        |r| r.get(0),
    )?;
    if taken {
        return Ok(false);
    }
    Ok(c.execute(
        "UPDATE collections SET name = ?3, updated_at = datetime('now') WHERE collection_id = ?1 AND app_profile_id = ?2",
        params![collection_id, app_profile_id, name],
    )? > 0)
}

pub fn delete_collection(c: &mut Connection, app_profile_id: i64, collection_id: i64) -> rusqlite::Result<bool> {
    let tx = c.transaction()?;
    if !collection_owned(&tx, app_profile_id, collection_id)? {
        return Ok(false);
    }
    tx.execute("DELETE FROM collection_items WHERE collection_id = ?1", [collection_id])?;
    tx.execute("DELETE FROM collections WHERE collection_id = ?1", [collection_id])?;
    tx.commit()?;
    Ok(true)
}

pub fn add_to_collection(c: &Connection, app_profile_id: i64, collection_id: i64, tmdb_id: i64, media_type: &str) -> rusqlite::Result<bool> {
    if !collection_owned(c, app_profile_id, collection_id)? {
        return Ok(false);
    }
    let added = c.execute(
        "INSERT OR IGNORE INTO collection_items (collection_id, tmdb_id, media_type, added_at) VALUES (?1, ?2, ?3, datetime('now'))",
        params![collection_id, tmdb_id, media_type],
    )? > 0;
    touch_collection(c, collection_id)?;
    Ok(added)
}

pub fn remove_from_collection(c: &Connection, app_profile_id: i64, collection_id: i64, tmdb_id: i64, media_type: &str) -> rusqlite::Result<bool> {
    if !collection_owned(c, app_profile_id, collection_id)? {
        return Ok(false);
    }
    let removed = c.execute(
        "DELETE FROM collection_items WHERE collection_id = ?1 AND tmdb_id = ?2 AND media_type = ?3",
        params![collection_id, tmdb_id, media_type],
    )? > 0;
    if removed {
        touch_collection(c, collection_id)?;
    }
    Ok(removed)
}

/// A collection's titles with catalog metadata, newest first (same shape as the watchlist).
pub fn list_collection_items(c: &Connection, app_profile_id: i64, collection_id: i64) -> rusqlite::Result<Vec<WatchlistItem>> {
    collect_rows(
        c,
        "SELECT col.app_profile_id, ci.tmdb_id, ci.media_type, ci.added_at,
                mc.title, mc.poster_path, mc.backdrop_path, mc.release_year, mc.vote_average
         FROM collection_items ci
         JOIN collections col ON col.collection_id = ci.collection_id
         LEFT JOIN media_catalog mc ON mc.tmdb_id = ci.tmdb_id AND mc.media_type = ci.media_type
         WHERE ci.collection_id = ?1 AND col.app_profile_id = ?2
         ORDER BY ci.added_at DESC",
        params![collection_id, app_profile_id],
        map_listed_item,
    )
}

/// Ids of this profile's collections that contain the title (the detail view's checkmarks).
pub fn collections_with_title(c: &Connection, app_profile_id: i64, tmdb_id: i64, media_type: &str) -> rusqlite::Result<Vec<i64>> {
    collect_rows(
        c,
        "SELECT ci.collection_id FROM collection_items ci
         JOIN collections col ON col.collection_id = ci.collection_id
         WHERE col.app_profile_id = ?1 AND ci.tmdb_id = ?2 AND ci.media_type = ?3",
        params![app_profile_id, tmdb_id, media_type],
        |r| r.get(0),
    )
}

// ---------------------------------------------------------------------------------------------
// Airing shows
// ---------------------------------------------------------------------------------------------

/// A series whose most recent activity is a finished episode (the user may be caught up).
#[derive(Debug, Clone, PartialEq)]
pub struct AiringCandidate {
    pub tmdb_id: i64,
    pub season_number: i64,
    pub episode_number: i64,
    /// `YYYY-MM-DD` of the last watch.
    pub last_watched_date: String,
}

/// Series to check for new episodes: the furthest episode watched is finished, it was watched in
/// the last `within_days`, and the series wasn't checked in the last `recheck_hours`.
pub fn airing_candidates(
    c: &Connection,
    app_profile_id: i64,
    within_days: i64,
    recheck_hours: i64,
    limit: i64,
) -> rusqlite::Result<Vec<AiringCandidate>> {
    collect_rows(
        c,
        "SELECT w.tmdb_id, w.season_number, w.episode_number, date(w.last_watched_at)
         FROM (
            SELECT wh.*, ROW_NUMBER() OVER (
                PARTITION BY wh.tmdb_id ORDER BY wh.season_number DESC, wh.episode_number DESC, wh.last_watched_at DESC) AS rn
            FROM watch_history wh
            WHERE wh.app_profile_id = ?1 AND wh.media_type = 'tv' AND wh.season_number > 0 AND wh.episode_number > 0
         ) w
         LEFT JOIN airing_checks a ON a.app_profile_id = w.app_profile_id AND a.tmdb_id = w.tmdb_id
         WHERE w.rn = 1
           AND (w.is_completed = 1 OR w.completion_ratio >= 0.9)
           AND w.last_watched_at >= datetime('now', '-' || ?2 || ' days')
           AND (a.checked_at IS NULL OR a.checked_at < datetime('now', '-' || ?3 || ' hours'))
         ORDER BY w.last_watched_at DESC
         LIMIT ?4",
        params![app_profile_id, within_days, recheck_hours, limit.clamp(1, 500)],
        |r| {
            Ok(AiringCandidate {
                tmdb_id: r.get(0)?,
                season_number: r.get(1)?,
                episode_number: r.get(2)?,
                last_watched_date: r.get(3)?,
            })
        },
    )
}

/// Stores a check result (`new` = the first unwatched episode that aired after the last watch).
pub fn record_airing_check(c: &Connection, app_profile_id: i64, tmdb_id: i64, new: Option<&NewEpisode>) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO airing_checks (app_profile_id, tmdb_id, checked_at, new_season, new_episode, new_air_date)
         VALUES (?1, ?2, datetime('now'), ?3, ?4, ?5)
         ON CONFLICT(app_profile_id, tmdb_id) DO UPDATE SET
            checked_at = excluded.checked_at, new_season = excluded.new_season,
            new_episode = excluded.new_episode, new_air_date = excluded.new_air_date",
        params![
            app_profile_id,
            tmdb_id,
            new.map(|n| n.season_number),
            new.map(|n| n.episode_number),
            new.map(|n| n.air_date.clone())
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Background delta sync state
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OttSyncState {
    pub app_profile_id: i64,
    pub provider_id: i64,
    pub last_attempt_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
    pub last_new_rows: i64,
}

pub fn get_sync_state(c: &Connection, app_profile_id: i64, provider_id: i64) -> rusqlite::Result<Option<OttSyncState>> {
    c.query_row(
        "SELECT app_profile_id, provider_id, last_attempt_at, last_success_at, last_error, last_new_rows
         FROM ott_sync_state WHERE app_profile_id = ?1 AND provider_id = ?2",
        params![app_profile_id, provider_id],
        map_sync_state,
    )
    .optional()
}

pub fn list_sync_states(c: &Connection, app_profile_id: i64) -> rusqlite::Result<Vec<OttSyncState>> {
    collect_rows(
        c,
        "SELECT app_profile_id, provider_id, last_attempt_at, last_success_at, last_error, last_new_rows
         FROM ott_sync_state WHERE app_profile_id = ?1",
        [app_profile_id],
        map_sync_state,
    )
}

fn map_sync_state(r: &Row<'_>) -> rusqlite::Result<OttSyncState> {
    Ok(OttSyncState {
        app_profile_id: r.get(0)?,
        provider_id: r.get(1)?,
        last_attempt_at: r.get(2)?,
        last_success_at: r.get(3)?,
        last_error: r.get(4)?,
        last_new_rows: r.get(5)?,
    })
}

/// Records a sync attempt. `Ok(new_rows)` also moves `last_success_at` to `started_at` (the
/// moment reading began, so activity during the sync is picked up next time).
pub fn record_sync_result(c: &Connection, app_profile_id: i64, provider_id: i64, started_at: &str, result: Result<usize, &str>) -> rusqlite::Result<()> {
    let (ok, rows, error) = match result {
        Ok(n) => (true, n as i64, None),
        Err(e) => (false, 0, Some(e.chars().take(300).collect::<String>())),
    };
    c.execute(
        "INSERT INTO ott_sync_state (app_profile_id, provider_id, last_attempt_at, last_success_at, last_error, last_new_rows)
         VALUES (?1, ?2, datetime('now'), CASE WHEN ?3 THEN datetime(?4) END, ?5, ?6)
         ON CONFLICT(app_profile_id, provider_id) DO UPDATE SET
            last_attempt_at = excluded.last_attempt_at,
            last_success_at = CASE WHEN ?3 THEN datetime(?4) ELSE ott_sync_state.last_success_at END,
            last_error = excluded.last_error,
            last_new_rows = CASE WHEN ?3 THEN excluded.last_new_rows ELSE ott_sync_state.last_new_rows END",
        params![app_profile_id, provider_id, ok, started_at, error, rows],
    )?;
    Ok(())
}

/// Newest watch date stored for these provider names (accounts imported before sync state existed).
pub fn latest_provider_activity(c: &Connection, app_profile_id: i64, provider_names: &[String]) -> rusqlite::Result<Option<String>> {
    let names = serde_json::to_string(provider_names).unwrap_or_else(|_| "[]".into());
    c.query_row(
        "SELECT MAX(last_watched_at) FROM watch_history
         WHERE app_profile_id = ?1 AND provider_name IN (SELECT value FROM json_each(?2))",
        params![app_profile_id, names],
        |r| r.get(0),
    )
}

// ---------------------------------------------------------------------------------------------
// LAN companion: paired devices (migration v7)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LanDevice {
    pub device_id: i64,
    pub device_name: String,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
}

pub fn add_lan_device(c: &Connection, device_name: &str, token_hash: &str) -> rusqlite::Result<i64> {
    c.execute("INSERT INTO lan_devices (device_name, token_hash) VALUES (?1, ?2)", params![device_name, token_hash])?;
    Ok(c.last_insert_rowid())
}

/// The paired device holding the token with this hash (also stamps it as seen, at most once a minute).
pub fn touch_lan_device(c: &Connection, token_hash: &str) -> rusqlite::Result<Option<i64>> {
    let id: Option<i64> = c
        .query_row("SELECT device_id FROM lan_devices WHERE token_hash = ?1", [token_hash], |r| r.get(0))
        .optional()?;
    if let Some(id) = id {
        c.execute(
            "UPDATE lan_devices SET last_seen_at = datetime('now')
             WHERE device_id = ?1 AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 minute'))",
            [id],
        )?;
    }
    Ok(id)
}

pub fn list_lan_devices(c: &Connection) -> rusqlite::Result<Vec<LanDevice>> {
    collect_rows(
        c,
        "SELECT device_id, device_name, paired_at, last_seen_at FROM lan_devices ORDER BY paired_at DESC, device_id DESC",
        [],
        |r| Ok(LanDevice { device_id: r.get(0)?, device_name: r.get(1)?, paired_at: r.get(2)?, last_seen_at: r.get(3)? }),
    )
}

pub fn revoke_lan_device(c: &Connection, device_id: i64) -> rusqlite::Result<bool> {
    Ok(c.execute("DELETE FROM lan_devices WHERE device_id = ?1", [device_id])? > 0)
}

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
            fallback_watched_at: None,
            time_of_day_bucket: Some("PrimeTime".into()),
            watch_count: Some(2),
            live: false,
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
            fallback_watched_at: None,
            time_of_day_bucket: None,
            watch_count: None,
            live: false,
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

    #[test]
    fn history_titles_group_lifetime_imports_and_clear_by_provider() {
        let mut c = test_db();
        let base = HistoryImport {
            app_profile_id: 1,
            tmdb_id: 66732,
            media_type: "tv".into(),
            season_number: 4,
            episode_number: 0, // kept under its season without an episode number
            episode_title: Some("Chapter One: The Hellfire Club".into()),
            provider_name: Some("Netflix".into()),
            direct_url: None,
            progress_seconds: 0.0,
            duration_seconds: 1.0,
            is_completed: true,
            watched_at: Some("2022-05-28T20:00:00Z".into()),
            fallback_watched_at: None,
            time_of_day_bucket: None,
            watch_count: None,
            live: false,
        };
        // 500 newer episodes of another show must not push the older series off the list.
        let mut rows: Vec<HistoryImport> = (1..=500)
            .map(|e| HistoryImport { tmdb_id: 1668, season_number: 1 + e / 30, episode_number: e % 30 + 1, watched_at: Some("2024-01-01T10:00:00Z".into()), episode_title: None, ..base.clone() })
            .collect();
        rows.push(base.clone());
        rows.push(HistoryImport { tmdb_id: 603, media_type: "movie".into(), season_number: 0, provider_name: Some("Amazon Prime Video".into()), ..base.clone() });
        upsert_imported_history(&mut c, &rows).unwrap();

        let titles = list_history_titles(&c, 1, 100, 0).unwrap();
        assert_eq!(titles.len(), 3);
        let st = titles.iter().find(|t| t.latest.entry.tmdb_id == 66732).unwrap();
        assert_eq!((st.latest.entry.season_number, st.latest.entry.episode_number, st.entry_count), (4, 0, 1));
        assert!(titles.iter().any(|t| t.latest.entry.tmdb_id == 1668 && t.entry_count > 400));

        let names = history_provider_names(&c, 1).unwrap();
        assert!(names.contains(&("Amazon Prime Video".to_string(), 1)));
        assert_eq!(clear_provider_history(&mut c, 1, &["Amazon Prime Video".to_string()]).unwrap(), 1);
        let titles = list_history_titles(&c, 1, 100, 0).unwrap();
        assert_eq!(titles.len(), 2);
        assert!(titles.iter().all(|t| t.latest.entry.provider_name.as_deref() == Some("Netflix")));
        assert_eq!(delete_title_history(&c, 1, 66732, "tv").unwrap(), 1);
    }

    #[test]
    fn manual_tracking_shows_on_continue_watching_and_undoes_cleanly() {
        let c = test_db();
        // A movie seen in the cinema: in history + Continue Watching (for a week), no provider.
        let row = mark_watched_manually(&c, 1, 603, "movie", 0, 0, None, Some(8160.0)).unwrap();
        assert!(row.is_completed && row.provider_name.is_none());
        let cw = continue_watching(&c, 1, 20).unwrap();
        assert_eq!(cw.len(), 1);
        assert!(cw[0].is_manual && !cw[0].up_next);
        // Marking again is a rewatch (Comfort Favorite signal).
        assert_eq!(mark_watched_manually(&c, 1, 603, "movie", 0, 0, None, None).unwrap().watch_count, 2);
        // An episode watched elsewhere: Up Next for the series.
        mark_watched_manually(&c, 1, 1396, "tv", 1, 1, Some("Pilot"), Some(3480.0)).unwrap();
        let cw = continue_watching(&c, 1, 20).unwrap();
        assert!(cw.iter().any(|i| i.entry.tmdb_id == 1396 && i.up_next));
        // Undo deletes hand-made rows.
        assert!(unmark_watched_manually(&c, 1, 603, "movie", 0, 0).unwrap());
        assert!(get_title_history(&c, 1, 603, "movie").unwrap().is_empty());
        // Watch History "Offline / Manual" filter.
        let manual = HistoryProviderFilter { names: vec![], include_unattributed: true };
        let rows = list_history_titles_filtered(&c, 1, 50, 0, Some(&manual)).unwrap();
        assert_eq!(rows.len(), 1);
        let netflix = HistoryProviderFilter { names: vec!["Netflix".into()], include_unattributed: false };
        assert!(list_history_titles_filtered(&c, 1, 50, 0, Some(&netflix)).unwrap().is_empty());
    }

    #[test]
    fn favorites_and_collections_are_profile_scoped() {
        let mut c = test_db();
        let other = create_profile(&c, "Mom", None, false).unwrap().profile_id;
        add_favorite(&c, 1, 603, "movie").unwrap();
        add_favorite(&c, 1, 603, "movie").unwrap();
        assert!(is_favorite(&c, 1, 603, "movie").unwrap());
        assert!(!is_favorite(&c, other, 603, "movie").unwrap());
        assert_eq!(list_favorites(&c, 1).unwrap().len(), 1);
        assert!(remove_favorite(&c, 1, 603, "movie").unwrap());

        let col = create_collection(&c, 1, "  Date   night ").unwrap().unwrap();
        assert_eq!(col.name, "Date night");
        // Same name (any case) returns the existing list instead of a duplicate.
        assert_eq!(create_collection(&c, 1, "date NIGHT").unwrap().unwrap().collection_id, col.collection_id);
        assert!(create_collection(&c, 1, "   ").unwrap().is_none());
        assert!(add_to_collection(&c, 1, col.collection_id, 603, "movie").unwrap());
        assert!(!add_to_collection(&c, 1, col.collection_id, 603, "movie").unwrap());
        add_to_collection(&c, 1, col.collection_id, 1396, "tv").unwrap();
        // Another profile can't read or change it.
        assert!(!add_to_collection(&c, other, col.collection_id, 1, "movie").unwrap());
        assert!(list_collection_items(&c, other, col.collection_id).unwrap().is_empty());
        assert!(!delete_collection(&mut c, other, col.collection_id).unwrap());
        assert_eq!(list_collection_items(&c, 1, col.collection_id).unwrap().len(), 2);
        assert_eq!(collections_with_title(&c, 1, 603, "movie").unwrap(), vec![col.collection_id]);
        assert_eq!(list_collections(&c, 1).unwrap()[0].item_count, 2);
        let second = create_collection(&c, 1, "Best of 2025").unwrap().unwrap();
        assert!(!rename_collection(&c, 1, second.collection_id, "date night").unwrap());
        assert!(rename_collection(&c, 1, second.collection_id, "Favourites 2025").unwrap());
        assert!(remove_from_collection(&c, 1, col.collection_id, 603, "movie").unwrap());
        assert!(delete_collection(&mut c, 1, col.collection_id).unwrap());
        assert_eq!(list_collections(&c, 1).unwrap().len(), 1);
    }

    #[test]
    fn caught_up_airing_show_returns_with_its_new_episode() {
        let mut c = test_db();
        // Imported (silent) finale, watched 40 days ago: not on Continue Watching.
        let finale = HistoryImport {
            app_profile_id: 1,
            tmdb_id: 94997,
            media_type: "tv".into(),
            season_number: 2,
            episode_number: 8,
            episode_title: None,
            provider_name: Some("JioHotstar".into()),
            direct_url: None,
            progress_seconds: 3000.0,
            duration_seconds: 3000.0,
            is_completed: true,
            watched_at: Some((chrono::Utc::now() - chrono::Duration::days(40)).format("%Y-%m-%dT%H:%M:%SZ").to_string()),
            fallback_watched_at: None,
            time_of_day_bucket: None,
            watch_count: None,
            live: false,
        };
        upsert_imported_history(&mut c, &[finale]).unwrap();
        assert!(continue_watching(&c, 1, 20).unwrap().is_empty());
        let cands = airing_candidates(&c, 1, 365, 12, 50).unwrap();
        assert_eq!(cands.len(), 1);
        assert_eq!((cands[0].season_number, cands[0].episode_number), (2, 8));

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let new = NewEpisode { season_number: 3, episode_number: 1, air_date: today };
        record_airing_check(&c, 1, 94997, Some(&new)).unwrap();
        let cw = continue_watching(&c, 1, 20).unwrap();
        assert_eq!(cw.len(), 1);
        assert_eq!(cw[0].new_episode.as_ref(), Some(&new));
        assert!(cw[0].up_next);
        // Checked recently: not a candidate again until the throttle passes.
        assert!(airing_candidates(&c, 1, 365, 12, 50).unwrap().is_empty());
        // Nothing new any more: it leaves again.
        record_airing_check(&c, 1, 94997, None).unwrap();
        assert!(continue_watching(&c, 1, 20).unwrap().is_empty());
    }

    #[test]
    fn lan_devices_pair_touch_and_revoke() {
        let c = test_db();
        let id = add_lan_device(&c, "iPhone", "hash-a").unwrap();
        assert_eq!(touch_lan_device(&c, "hash-a").unwrap(), Some(id));
        assert_eq!(touch_lan_device(&c, "nope").unwrap(), None);
        let list = list_lan_devices(&c).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].last_seen_at.is_some());
        assert!(revoke_lan_device(&c, id).unwrap());
        assert_eq!(touch_lan_device(&c, "hash-a").unwrap(), None);
    }

    #[test]
    fn season_marked_watched_in_one_go_keeps_episode_order() {
        let mut c = test_db();
        let ep = |e: i64| EpisodeMark { season_number: 1, episode_number: e, episode_title: None, duration_seconds: Some(1500.0) };
        // Out of order and with a duplicate: stored once each, stamped in episode order.
        assert_eq!(mark_episodes_watched_manually(&mut c, 1, 1668, &[ep(3), ep(1), ep(2), ep(2)]).unwrap(), 3);
        let rows = get_title_history(&c, 1, 1668, "tv").unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.is_completed));
        let at = |e: i64| rows.iter().find(|r| r.episode_number == e).unwrap().last_watched_at.clone();
        assert!(at(1) < at(2) && at(2) < at(3), "{} {} {}", at(1), at(2), at(3));
        // Watchlist entries are never touched by watching.
        add_to_watchlist(&c, 1, 1668, "tv").unwrap();
        mark_episodes_watched_manually(&mut c, 1, 1668, &[ep(4)]).unwrap();
        assert!(is_in_watchlist(&c, 1, 1668, "tv").unwrap());
    }

    #[test]
    fn delta_sync_surfaces_new_activity_and_keeps_undated_dates() {
        let mut c = test_db();
        let base = HistoryImport {
            app_profile_id: 1,
            tmdb_id: 1396,
            media_type: "tv".into(),
            season_number: 1,
            episode_number: 2,
            episode_title: None,
            provider_name: Some("JioHotstar".into()),
            direct_url: None,
            progress_seconds: 600.0,
            duration_seconds: 2700.0,
            is_completed: false,
            watched_at: None,
            fallback_watched_at: None,
            time_of_day_bucket: None,
            watch_count: None,
            live: false,
        };
        // First (full) import of an undated tile: silent.
        upsert_imported_history(&mut c, &[base.clone()]).unwrap();
        let first = get_title_history(&c, 1, 1396, "tv").unwrap()[0].clone();
        c.execute("UPDATE watch_history SET last_watched_at = '2025-01-01 10:00:00'", []).unwrap();
        assert!(continue_watching(&c, 1, 20).unwrap().is_empty());

        // A background sync sees the same tile unchanged: nothing moves (and nothing counts as new).
        assert_eq!(upsert_imported_history_tracked(&mut c, &[HistoryImport { live: true, ..base.clone() }]).unwrap(), (1, 0));
        let row = get_title_history(&c, 1, 1396, "tv").unwrap()[0].clone();
        assert_eq!(row.last_watched_at, "2025-01-01 10:00:00");
        assert!(continue_watching(&c, 1, 20).unwrap().is_empty());
        assert_eq!(row.id, first.id);

        // Watched further on a phone: progress moved, so it is new activity (now, live).
        assert_eq!(upsert_imported_history_tracked(&mut c, &[HistoryImport { live: true, progress_seconds: 1800.0, ..base.clone() }]).unwrap(), (1, 1));
        let row = get_title_history(&c, 1, 1396, "tv").unwrap()[0].clone();
        assert!(row.last_watched_at.as_str() > "2025-01-02");
        assert_eq!(continue_watching(&c, 1, 20).unwrap().len(), 1);

        // A dated entry newer than what we have is live too.
        let dated = HistoryImport { tmdb_id: 603, media_type: "movie".into(), season_number: 0, episode_number: 0, watched_at: Some("2026-11-15T20:00:00Z".into()), live: true, ..base.clone() };
        upsert_imported_history(&mut c, &[dated]).unwrap();
        assert_eq!(continue_watching(&c, 1, 20).unwrap().len(), 2);

        // Sync state bookkeeping.
        record_sync_result(&c, 1, 122, "2026-11-16 08:00:00", Ok(2)).unwrap();
        record_sync_result(&c, 1, 122, "2026-11-16 09:00:00", Err("signed out")).unwrap();
        let st = get_sync_state(&c, 1, 122).unwrap().unwrap();
        assert_eq!(st.last_success_at.as_deref(), Some("2026-11-16 08:00:00"));
        assert_eq!(st.last_error.as_deref(), Some("signed out"));
        assert_eq!(st.last_new_rows, 2);
        // Newest stored activity for the service (the phone-watched row was stamped now).
        let latest = latest_provider_activity(&c, 1, &["JioHotstar".into()]).unwrap().unwrap();
        assert!(latest.as_str() >= "2026-11-15 20:00:00", "{latest}");
        assert!(latest_provider_activity(&c, 1, &["Netflix".into()]).unwrap().is_none());
    }
}
