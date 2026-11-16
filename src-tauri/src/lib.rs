//! Omnia native backend: app state, command registration and global shortcut initialisation.

pub mod db;

pub mod resolver {
    pub mod justwatch;
}

pub mod player {
    pub mod window_manager;
}

pub mod sync {
    pub mod airing;
    pub mod background;
    pub mod history_importer;
}

pub mod ml {
    pub mod embeddings;
    pub mod recommender;
}

use std::collections::HashMap;
use std::time::Duration;

use serde::Serializer;
use tauri::{Manager, State};

use db::queries::{
    self, AppProfile, ContinueWatchingItem, CustomHub, HistoryImport, HistoryWithMedia, MediaCatalogEntry,
    OttProfileMapping, PlaybackEvent, PreferredProvider, ProgressUpdate, SubscribedProvider,
    WatchHistoryEntry, WatchlistItem,
};
use db::Database;
use ml::embeddings::EmbeddingService;
use ml::recommender::{self, Recommender};
use player::window_manager::{self, PlayerManager};
use resolver::justwatch::{JustWatchResolver, ResolveRequest, ResolveResponse, ResolvedLink};
use sync::history_importer::{self, HistoryImporter};

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] tokio_rusqlite::Error),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("tauri error: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("{0}")]
    Message(String),
}

/// Commands surface errors to the frontend as plain strings.
impl serde::Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::Message(msg.into())
}

fn check_media_type(media_type: &str) -> AppResult<()> {
    match media_type {
        "movie" | "tv" => Ok(()),
        other => Err(invalid(format!("invalid media_type '{other}' (expected 'movie' or 'tv')"))),
    }
}

fn check_region(region_code: &str) -> AppResult<String> {
    let r = region_code.trim().to_ascii_uppercase();
    if r.len() == 2 && r.chars().all(|c| c.is_ascii_alphabetic()) {
        Ok(r)
    } else {
        Err(invalid(format!("invalid ISO 3166-1 region code '{region_code}'")))
    }
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

pub struct AppState {
    pub db: Database,
    pub http: reqwest::Client,
    pub resolver: JustWatchResolver,
    pub player: PlayerManager,
    pub importer: HistoryImporter,
    pub recommender: Recommender,
}

// ---------------------------------------------------------------------------------------------
// Profile commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn list_profiles(state: State<'_, AppState>) -> AppResult<Vec<AppProfile>> {
    state.db.run(|c| queries::list_profiles(c)).await
}

/// Largest image accepted from a pasted avatar URL.
const MAX_AVATAR_DOWNLOAD: usize = 10 * 1024 * 1024;

fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Public web hosts only: a pasted avatar URL must not reach into the local network.
fn is_public_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d.contains('.') && d != "localhost" && !d.ends_with(".localhost") && !d.ends_with(".local") && !d.ends_with(".internal")
        }
        Some(url::Host::Ipv4(ip)) => !(ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast()),
        Some(url::Host::Ipv6(ip)) => !(ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80),
        None => false,
    }
}

/// "Paste an image URL" for a profile picture: downloads the image once (no cookies, nothing
/// about the profile is sent) and returns it as a data URL; the UI crops it to 256 px and stores
/// it locally, so the picture never loads from that site again.
#[tauri::command]
async fn fetch_avatar_image(url: String) -> AppResult<String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| invalid("That doesn't look like a web address."))?;
    if !matches!(parsed.scheme(), "https" | "http") || !is_public_host(&parsed) {
        return Err(invalid("Use an http(s) link to an image on the web."));
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("Omnia/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !is_public_host(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()?;
    let mut resp = client.get(parsed).header("Accept", "image/*").send().await?;
    if !resp.status().is_success() {
        return Err(invalid(format!("The image couldn't be downloaded (HTTP {}).", resp.status().as_u16())));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/jpg" | "image/webp" | "image/gif" | "image/avif" | "image/bmp") {
        return Err(invalid("That link isn't a PNG, JPEG, WebP or GIF image. Copy the image address itself (right-click → Copy image address)."));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_AVATAR_DOWNLOAD) {
        return Err(invalid("That image is larger than 10 MB."));
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_AVATAR_DOWNLOAD {
            return Err(invalid("That image is larger than 10 MB."));
        }
    }
    let mime = if mime == "image/jpg" { "image/jpeg".to_string() } else { mime };
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// `avatar_asset`: a short id (`char:fox`, a palette), a TMDB image URL, or an uploaded image as
/// a small `data:image/(png|jpeg|webp);base64,…` URL (center-cropped to 256 px in the UI).
fn validate_avatar(avatar: Option<String>) -> AppResult<Option<String>> {
    let Some(a) = avatar.map(|a| a.trim().to_string()).filter(|a| !a.is_empty()) else {
        return Ok(None);
    };
    let ok = if let Some(rest) = a.strip_prefix("data:") {
        a.len() <= 400_000
            && ["image/png;base64,", "image/jpeg;base64,", "image/webp;base64,"]
                .iter()
                .any(|p| rest.strip_prefix(p).is_some_and(|b64| b64.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'='))))
    } else if a.starts_with("https://") {
        a.starts_with("https://image.tmdb.org/t/p/") && a.len() <= 200
    } else {
        a.len() <= 64
    };
    if ok {
        Ok(Some(a))
    } else {
        Err(invalid("unsupported avatar image"))
    }
}

#[tauri::command]
async fn create_profile(
    state: State<'_, AppState>,
    profile_name: String,
    avatar_asset: Option<String>,
    is_kids_profile: bool,
) -> AppResult<AppProfile> {
    let name = profile_name.trim().to_string();
    if name.is_empty() {
        return Err(invalid("profile name cannot be empty"));
    }
    let avatar_asset = validate_avatar(avatar_asset)?;
    state
        .db
        .run(move |c| queries::create_profile(c, &name, avatar_asset.as_deref(), is_kids_profile))
        .await
}

#[tauri::command]
async fn update_profile(
    state: State<'_, AppState>,
    profile_id: i64,
    profile_name: String,
    avatar_asset: Option<String>,
    is_kids_profile: bool,
) -> AppResult<AppProfile> {
    let name = profile_name.trim().to_string();
    if name.is_empty() {
        return Err(invalid("profile name cannot be empty"));
    }
    let avatar_asset = validate_avatar(avatar_asset)?;
    state
        .db
        .run(move |c| queries::update_profile(c, profile_id, &name, avatar_asset.as_deref(), is_kids_profile))
        .await?
        .ok_or_else(|| invalid(format!("profile {profile_id} not found")))
}

/// Deletes the profile and everything scoped to it: rows cascade in SQLite, and its isolated
/// browser session (OTT cookies, cache, storage) is wiped from disk.
#[tauri::command]
async fn delete_profile(app: tauri::AppHandle, state: State<'_, AppState>, profile_id: i64) -> AppResult<bool> {
    let removed = state.db.run(move |c| queries::delete_profile(c, profile_id)).await?;
    if removed {
        window_manager::close_player_for_profile(&app, profile_id).await;
        tauri::async_runtime::spawn(async move {
            window_manager::purge_profile_data(&app, profile_id).await;
        });
    }
    Ok(removed)
}

// ---------------------------------------------------------------------------------------------
// Settings commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn get_setting(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    state.db.run(move |c| queries::get_setting(c, &key)).await
}

#[tauri::command]
async fn set_setting(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    if key.trim().is_empty() {
        return Err(invalid("setting key cannot be empty"));
    }
    if key == queries::keys::REGION_CODE {
        let region = check_region(&value)?;
        return state
            .db
            .run(move |c| queries::set_setting(c, queries::keys::REGION_CODE, &region))
            .await;
    }
    state.db.run(move |c| queries::set_setting(c, &key, &value)).await
}

#[tauri::command]
async fn get_all_settings(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    state.db.run(|c| queries::get_all_settings(c)).await
}

#[tauri::command]
async fn delete_setting(state: State<'_, AppState>, key: String) -> AppResult<bool> {
    state.db.run(move |c| queries::delete_setting(c, &key)).await
}

// ---------------------------------------------------------------------------------------------
// OTT profile mapping commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn list_ott_profile_mappings(
    state: State<'_, AppState>,
    app_profile_id: i64,
) -> AppResult<Vec<OttProfileMapping>> {
    state.db.run(move |c| queries::list_ott_mappings(c, app_profile_id)).await
}

#[tauri::command]
async fn upsert_ott_profile_mapping(state: State<'_, AppState>, mapping: OttProfileMapping) -> AppResult<()> {
    if mapping.ott_native_profile_id.trim().is_empty() {
        return Err(invalid("OTT native profile id cannot be empty"));
    }
    state.db.run(move |c| queries::upsert_ott_mapping(c, &mapping)).await
}

#[tauri::command]
async fn delete_ott_profile_mapping(
    state: State<'_, AppState>,
    app_profile_id: i64,
    provider_id: i64,
) -> AppResult<bool> {
    state
        .db
        .run(move |c| queries::delete_ott_mapping(c, app_profile_id, provider_id))
        .await
}

// ---------------------------------------------------------------------------------------------
// Subscription commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn list_subscribed_providers(
    state: State<'_, AppState>,
    region_code: String,
    active_only: bool,
) -> AppResult<Vec<SubscribedProvider>> {
    let region = check_region(&region_code)?;
    state
        .db
        .run(move |c| queries::list_subscribed_providers(c, &region, active_only))
        .await
}

#[tauri::command]
async fn set_subscribed_providers(
    state: State<'_, AppState>,
    region_code: String,
    providers: Vec<SubscribedProvider>,
) -> AppResult<Vec<SubscribedProvider>> {
    let region = check_region(&region_code)?;
    state
        .db
        .run(move |c| {
            queries::replace_region_subscriptions(c, &region, &providers)?;
            queries::list_subscribed_providers(c, &region, true)
        })
        .await
}

#[tauri::command]
async fn set_provider_active(
    state: State<'_, AppState>,
    provider_id: i64,
    region_code: String,
    is_active: bool,
) -> AppResult<bool> {
    let region = check_region(&region_code)?;
    state
        .db
        .run(move |c| queries::set_provider_active(c, provider_id, &region, is_active))
        .await
}

// ---------------------------------------------------------------------------------------------
// Media catalog commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn cache_media_metadata(state: State<'_, AppState>, entries: Vec<MediaCatalogEntry>) -> AppResult<usize> {
    for e in &entries {
        check_media_type(&e.media_type)?;
    }
    state.db.run(move |c| queries::upsert_media_batch(c, &entries)).await
}

#[tauri::command]
async fn get_cached_media(
    state: State<'_, AppState>,
    tmdb_id: i64,
    media_type: String,
) -> AppResult<Option<MediaCatalogEntry>> {
    check_media_type(&media_type)?;
    state.db.run(move |c| queries::get_media(c, tmdb_id, &media_type)).await
}

/// "Remove from Continue Watching": hides the title from the row; its history is kept.
#[tauri::command]
async fn hide_from_continue_watching(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
) -> AppResult<()> {
    check_media_type(&media_type)?;
    state
        .db
        .run(move |c| queries::hide_from_continue_watching(c, app_profile_id, tmdb_id, &media_type))
        .await
}

#[tauri::command]
async fn unhide_from_continue_watching(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
) -> AppResult<bool> {
    check_media_type(&media_type)?;
    state
        .db
        .run(move |c| queries::unhide_from_continue_watching(c, app_profile_id, tmdb_id, &media_type))
        .await
}

// ---------------------------------------------------------------------------------------------
// Preferred provider per title ("Where do you want to watch this?")
// ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn get_preferred_provider(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
) -> AppResult<Option<PreferredProvider>> {
    check_media_type(&media_type)?;
    state
        .db
        .run(move |c| queries::get_preferred_provider(c, app_profile_id, tmdb_id, &media_type))
        .await
}

/// Remembers the profile's OTT choice for a title. Stored under the canonical provider id so a
/// "Prime Video" choice also covers its "with Ads" / store variants.
#[tauri::command]
async fn set_preferred_provider(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
    provider_id: i64,
    provider_name: String,
) -> AppResult<PreferredProvider> {
    check_media_type(&media_type)?;
    let name = provider_name.trim().to_string();
    if name.is_empty() {
        return Err(invalid("provider name cannot be empty"));
    }
    let canonical = window_manager::canonical_provider_id(provider_id, &name);
    state
        .db
        .run(move |c| {
            if queries::get_profile(c, app_profile_id)?.is_none() {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            queries::set_preferred_provider(c, app_profile_id, tmdb_id, &media_type, canonical, &name)
        })
        .await
}

#[tauri::command]
async fn clear_preferred_provider(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
) -> AppResult<bool> {
    check_media_type(&media_type)?;
    state
        .db
        .run(move |c| queries::clear_preferred_provider(c, app_profile_id, tmdb_id, &media_type))
        .await
}

// ---------------------------------------------------------------------------------------------
// Deep-link commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn resolve_deep_links(state: State<'_, AppState>, request: ResolveRequest) -> AppResult<ResolveResponse> {
    check_media_type(&request.media_type)?;
    if request.title.trim().is_empty() {
        return Err(invalid("title is required to resolve deep links"));
    }
    state.resolver.resolve(&state.db, request).await
}

#[tauri::command]
async fn get_cached_deep_links(
    state: State<'_, AppState>,
    tmdb_id: i64,
    media_type: String,
    region_code: String,
) -> AppResult<Vec<ResolvedLink>> {
    check_media_type(&media_type)?;
    let region = check_region(&region_code)?;
    let links = state
        .db
        .run(move |c| queries::get_valid_deep_links(c, tmdb_id, &media_type, &region))
        .await?;
    Ok(links.into_iter().map(ResolvedLink::from).collect())
}

// ---------------------------------------------------------------------------------------------
// Watch history commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn record_watch_progress(state: State<'_, AppState>, update: ProgressUpdate) -> AppResult<WatchHistoryEntry> {
    check_media_type(&update.media_type)?;
    state.db.run(move |c| queries::record_progress(c, &update)).await
}

#[tauri::command]
async fn mark_title_completed(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
    season_number: i64,
    episode_number: i64,
) -> AppResult<bool> {
    check_media_type(&media_type)?;
    state
        .db
        .run(move |c| {
            queries::mark_completed(c, app_profile_id, tmdb_id, &media_type, season_number, episode_number)
        })
        .await
}

#[tauri::command]
async fn get_continue_watching(
    state: State<'_, AppState>,
    app_profile_id: i64,
    limit: Option<i64>,
) -> AppResult<Vec<ContinueWatchingItem>> {
    state
        .db
        .run(move |c| queries::continue_watching(c, app_profile_id, limit.unwrap_or(20)))
        .await
}

#[tauri::command]
async fn get_watch_history(
    state: State<'_, AppState>,
    app_profile_id: i64,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<Vec<HistoryWithMedia>> {
    state
        .db
        .run(move |c| queries::list_history_with_media(c, app_profile_id, limit.unwrap_or(100), offset.unwrap_or(0)))
        .await
}

#[tauri::command]
async fn get_title_progress(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
) -> AppResult<Vec<WatchHistoryEntry>> {
    check_media_type(&media_type)?;
    state
        .db
        .run(move |c| queries::get_title_history(c, app_profile_id, tmdb_id, &media_type))
        .await
}

#[tauri::command]
async fn delete_watch_history_entry(state: State<'_, AppState>, app_profile_id: i64, id: i64) -> AppResult<bool> {
    state
        .db
        .run(move |c| queries::delete_history_entry(c, app_profile_id, id))
        .await
}

/// "Recently watched": one row per title (latest entry + episode count), paged by title.
#[tauri::command]
async fn get_history_titles(
    state: State<'_, AppState>,
    app_profile_id: i64,
    limit: Option<i64>,
    offset: Option<i64>,
    provider_id: Option<i64>,
) -> AppResult<Vec<queries::HistoryTitle>> {
    state
        .db
        .run(move |c| {
            // Platform filter: one provider family, or 0 = "Offline / Manual" (no / unknown provider).
            let filter = match provider_id {
                None => None,
                Some(wanted) => {
                    let mut f = queries::HistoryProviderFilter { names: Vec::new(), include_unattributed: wanted == 0 };
                    for (name, _) in queries::history_provider_names(c, app_profile_id)? {
                        if !name.is_empty() && window_manager::canonical_provider_id(0, &name).max(0) == wanted.max(0) {
                            f.names.push(name);
                        }
                    }
                    Some(f)
                }
            };
            queries::list_history_titles_filtered(c, app_profile_id, limit.unwrap_or(60), offset.unwrap_or(0), filter.as_ref())
        })
        .await
}

/// Removes a whole title (every episode) from one profile's history.
#[tauri::command]
async fn delete_title_history(state: State<'_, AppState>, app_profile_id: i64, tmdb_id: i64, media_type: String) -> AppResult<usize> {
    check_media_type(&media_type)?;
    let removed = state
        .db
        .run(move |c| queries::delete_title_history(c, app_profile_id, tmdb_id, &media_type))
        .await?;
    state.recommender.invalidate(app_profile_id);
    Ok(removed)
}

/// History rows per provider family (canonical provider id), for "Clear by provider".
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderHistoryCount {
    provider_id: i64,
    rows: i64,
}

#[tauri::command]
async fn get_history_provider_counts(state: State<'_, AppState>, app_profile_id: i64) -> AppResult<Vec<ProviderHistoryCount>> {
    let names = state.db.run(move |c| queries::history_provider_names(c, app_profile_id)).await?;
    let mut by_id: std::collections::BTreeMap<i64, i64> = std::collections::BTreeMap::new();
    for (name, rows) in names {
        // Rows without a recognised provider (Mark as Watched, file imports) are reported as 0:
        // "Offline / Manual" in the Watch History filter (never offered for "Clear by provider").
        let id = if name.is_empty() { 0 } else { window_manager::canonical_provider_id(0, &name).max(0) };
        *by_id.entry(id).or_default() += rows;
    }
    Ok(by_id.into_iter().map(|(provider_id, rows)| ProviderHistoryCount { provider_id, rows }).collect())
}

/// "Clear by provider": deletes only the profile's history recorded on one provider family
/// (e.g. a wrongly imported Prime Video history), keeping every other service's rows.
#[tauri::command]
async fn clear_provider_history(app: tauri::AppHandle, state: State<'_, AppState>, app_profile_id: i64, provider_id: i64) -> AppResult<usize> {
    if state.importer.has_running_for(app_profile_id) {
        return Err(AppError::Message("A history import is running for this profile. Wait for it to finish, then clear.".into()));
    }
    window_manager::close_player_for_profile(&app, app_profile_id).await;
    let canonical = window_manager::canonical_provider_id(provider_id, "");
    if canonical <= 0 {
        return Err(AppError::Message("Unknown provider.".into()));
    }
    let removed = state
        .db
        .run(move |c| {
            let names: Vec<String> = queries::history_provider_names(c, app_profile_id)?
                .into_iter()
                .map(|(name, _)| name)
                .filter(|name| window_manager::canonical_provider_id(0, name) == canonical)
                .collect();
            queries::clear_provider_history(c, app_profile_id, &names)
        })
        .await?;
    state.recommender.invalidate(app_profile_id);
    log::info!("cleared provider {canonical} history of profile {app_profile_id}: {removed} rows");
    Ok(removed)
}

// ---------------------------------------------------------------------------------------------
// Manual tracking, favorites, collections, airing shows
// ---------------------------------------------------------------------------------------------

/// "Mark as Watched" (cinema, a local file, another device): a completed history row with no
/// provider. It shows in Watch History and on Continue Watching, and feeds the recommender.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn mark_watched(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
    season_number: Option<i64>,
    episode_number: Option<i64>,
    episode_title: Option<String>,
    duration_seconds: Option<f64>,
) -> AppResult<queries::WatchHistoryEntry> {
    check_media_type(&media_type)?;
    let (s, e) = (season_number.unwrap_or(0), episode_number.unwrap_or(0));
    if media_type == "tv" && (s <= 0 || e <= 0) {
        return Err(AppError::Message("Pick an episode to mark as watched.".into()));
    }
    let row = state
        .db
        .run(move |c| queries::mark_watched_manually(c, app_profile_id, tmdb_id, &media_type, s, e, episode_title.as_deref(), duration_seconds))
        .await?;
    state.recommender.invalidate(app_profile_id);
    Ok(row)
}

/// "Mark season as watched": every listed episode in one transaction.
#[tauri::command]
async fn mark_episodes_watched(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    episodes: Vec<queries::EpisodeMark>,
) -> AppResult<usize> {
    if episodes.is_empty() {
        return Ok(0);
    }
    let n = state
        .db
        .run(move |c| queries::mark_episodes_watched_manually(c, app_profile_id, tmdb_id, &episodes))
        .await?;
    state.recommender.invalidate(app_profile_id);
    Ok(n)
}

#[tauri::command]
async fn unmark_watched(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
    season_number: Option<i64>,
    episode_number: Option<i64>,
) -> AppResult<bool> {
    check_media_type(&media_type)?;
    let (s, e) = (season_number.unwrap_or(0), episode_number.unwrap_or(0));
    let changed = state
        .db
        .run(move |c| queries::unmark_watched_manually(c, app_profile_id, tmdb_id, &media_type, s, e))
        .await?;
    state.recommender.invalidate(app_profile_id);
    Ok(changed)
}

/// "Love" toggle; returns the new state.
#[tauri::command]
async fn set_favorite(state: State<'_, AppState>, app_profile_id: i64, tmdb_id: i64, media_type: String, favorite: bool) -> AppResult<bool> {
    check_media_type(&media_type)?;
    state
        .db
        .run(move |c| {
            if favorite {
                queries::add_favorite(c, app_profile_id, tmdb_id, &media_type)?;
            } else {
                queries::remove_favorite(c, app_profile_id, tmdb_id, &media_type)?;
            }
            Ok(())
        })
        .await?;
    state.recommender.invalidate(app_profile_id);
    Ok(favorite)
}

#[tauri::command]
async fn is_favorite(state: State<'_, AppState>, app_profile_id: i64, tmdb_id: i64, media_type: String) -> AppResult<bool> {
    state.db.run(move |c| queries::is_favorite(c, app_profile_id, tmdb_id, &media_type)).await
}

#[tauri::command]
async fn get_favorites(state: State<'_, AppState>, app_profile_id: i64) -> AppResult<Vec<queries::WatchlistItem>> {
    state.db.run(move |c| queries::list_favorites(c, app_profile_id)).await
}

#[tauri::command]
async fn get_collections(state: State<'_, AppState>, app_profile_id: i64) -> AppResult<Vec<queries::Collection>> {
    state.db.run(move |c| queries::list_collections(c, app_profile_id)).await
}

#[tauri::command]
async fn create_collection(state: State<'_, AppState>, app_profile_id: i64, name: String) -> AppResult<queries::Collection> {
    state
        .db
        .run(move |c| queries::create_collection(c, app_profile_id, &name))
        .await?
        .ok_or_else(|| AppError::Message("Give the collection a name.".into()))
}

#[tauri::command]
async fn rename_collection(state: State<'_, AppState>, app_profile_id: i64, collection_id: i64, name: String) -> AppResult<()> {
    let ok = state
        .db
        .run(move |c| queries::rename_collection(c, app_profile_id, collection_id, &name))
        .await?;
    if ok {
        Ok(())
    } else {
        Err(AppError::Message("That name is empty or already used by another collection.".into()))
    }
}

#[tauri::command]
async fn delete_collection(state: State<'_, AppState>, app_profile_id: i64, collection_id: i64) -> AppResult<bool> {
    state.db.run(move |c| queries::delete_collection(c, app_profile_id, collection_id)).await
}

#[tauri::command]
async fn add_to_collection(state: State<'_, AppState>, app_profile_id: i64, collection_id: i64, tmdb_id: i64, media_type: String) -> AppResult<bool> {
    check_media_type(&media_type)?;
    state
        .db
        .run(move |c| queries::add_to_collection(c, app_profile_id, collection_id, tmdb_id, &media_type))
        .await
}

#[tauri::command]
async fn remove_from_collection(state: State<'_, AppState>, app_profile_id: i64, collection_id: i64, tmdb_id: i64, media_type: String) -> AppResult<bool> {
    state
        .db
        .run(move |c| queries::remove_from_collection(c, app_profile_id, collection_id, tmdb_id, &media_type))
        .await
}

#[tauri::command]
async fn get_collection_items(state: State<'_, AppState>, app_profile_id: i64, collection_id: i64) -> AppResult<Vec<queries::WatchlistItem>> {
    state.db.run(move |c| queries::list_collection_items(c, app_profile_id, collection_id)).await
}

#[tauri::command]
async fn get_title_collections(state: State<'_, AppState>, app_profile_id: i64, tmdb_id: i64, media_type: String) -> AppResult<Vec<i64>> {
    state
        .db
        .run(move |c| queries::collections_with_title(c, app_profile_id, tmdb_id, &media_type))
        .await
}

/// "Sync now" in Connect Accounts: a delta sync of every linked account of the profile, now.
/// `None` when a background sync is already running.
#[tauri::command]
async fn sync_accounts_now(app: tauri::AppHandle, app_profile_id: i64) -> AppResult<Option<usize>> {
    sync::background::sync_now(&app, app_profile_id).await
}

/// Per-account background sync status for Connect Accounts.
#[tauri::command]
async fn get_sync_states(state: State<'_, AppState>, app_profile_id: i64) -> AppResult<Vec<queries::OttSyncState>> {
    state.db.run(move |c| queries::list_sync_states(c, app_profile_id)).await
}

/// Home load: brings caught-up airing series with a new episode back to Continue Watching.
#[tauri::command]
async fn check_airing_shows(state: State<'_, AppState>, app_profile_id: i64) -> AppResult<usize> {
    sync::airing::check_airing_shows(&state, app_profile_id).await
}

/// "Clear Watch History" (Settings → Connect Accounts): wipes the profile's watch history and
/// playback events so a clean re-import can follow. Refused while that profile is importing.
#[tauri::command]
async fn clear_watch_history(app: tauri::AppHandle, state: State<'_, AppState>, app_profile_id: i64) -> AppResult<queries::ClearedHistory> {
    if state.importer.has_running_for(app_profile_id) {
        return Err(AppError::Message("A history import is running for this profile. Wait for it to finish, then clear.".into()));
    }
    // A live player session would keep writing progress for the old episode; end it first.
    window_manager::close_player_for_profile(&app, app_profile_id).await;
    let cleared = state.db.run(move |c| queries::clear_profile_history(c, app_profile_id)).await?;
    state.recommender.invalidate(app_profile_id);
    log::info!(
        "cleared watch history of profile {app_profile_id}: {} rows, {} events",
        cleared.history_rows,
        cleared.playback_events
    );
    Ok(cleared)
}

/// Identifies a title the user switched to inside the player (strict TMDB type + year match).
#[tauri::command]
async fn identify_title(
    state: State<'_, AppState>,
    title: String,
    media_type: String,
    release_year: Option<i64>,
) -> AppResult<Option<history_importer::IdentifiedTitle>> {
    check_media_type(&media_type)?;
    history_importer::identify_title(&state, &title, media_type == "tv", release_year).await
}

/// Manual CSV/JSON import (parsed on the frontend into typed rows).
#[tauri::command]
async fn import_watch_history(state: State<'_, AppState>, rows: Vec<HistoryImport>) -> AppResult<usize> {
    for r in &rows {
        check_media_type(&r.media_type)?;
    }
    state.db.run(move |c| queries::upsert_imported_history(c, &rows)).await
}

/// Full local export for the offline backup feature.
#[tauri::command]
async fn export_watch_history(state: State<'_, AppState>, app_profile_id: i64) -> AppResult<Vec<WatchHistoryEntry>> {
    state
        .db
        .run(move |c| queries::list_history(c, app_profile_id, i64::MAX, 0))
        .await
}

// ---------------------------------------------------------------------------------------------
// Playback event commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn log_playback_event(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
    event_type: String,
    session_watch_duration_sec: Option<f64>,
) -> AppResult<i64> {
    check_media_type(&media_type)?;
    if event_type.trim().is_empty() {
        return Err(invalid("event_type cannot be empty"));
    }
    state
        .db
        .run(move |c| {
            queries::insert_playback_event(
                c,
                app_profile_id,
                tmdb_id,
                &media_type,
                &event_type,
                session_watch_duration_sec.unwrap_or(0.0),
            )
        })
        .await
}

#[tauri::command]
async fn list_playback_events(
    state: State<'_, AppState>,
    app_profile_id: i64,
    since: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<PlaybackEvent>> {
    state
        .db
        .run(move |c| queries::list_playback_events(c, app_profile_id, since.as_deref(), limit.unwrap_or(500)))
        .await
}

// ---------------------------------------------------------------------------------------------
// Hub registry commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn list_custom_hubs(state: State<'_, AppState>, category_type: Option<String>) -> AppResult<Vec<CustomHub>> {
    state
        .db
        .run(move |c| queries::list_hubs(c, category_type.as_deref()))
        .await
}

#[tauri::command]
async fn upsert_custom_hubs(state: State<'_, AppState>, hubs: Vec<CustomHub>) -> AppResult<usize> {
    for h in &hubs {
        if h.hub_slug.trim().is_empty() || h.display_name.trim().is_empty() {
            return Err(invalid("hub slug and display name are required"));
        }
        if !h.tmdb_filter_rule.is_object() {
            return Err(invalid(format!("hub '{}' filter rule must be a JSON object", h.hub_slug)));
        }
    }
    state.db.run(move |c| queries::upsert_hubs_batch(c, &hubs)).await
}

#[tauri::command]
async fn delete_custom_hub(state: State<'_, AppState>, hub_slug: String) -> AppResult<bool> {
    state.db.run(move |c| queries::delete_hub(c, &hub_slug)).await
}

// ---------------------------------------------------------------------------------------------
// Watchlist commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
async fn add_to_watchlist(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
) -> AppResult<()> {
    check_media_type(&media_type)?;
    state
        .db
        .run(move |c| queries::add_to_watchlist(c, app_profile_id, tmdb_id, &media_type))
        .await
}

#[tauri::command]
async fn remove_from_watchlist(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
) -> AppResult<bool> {
    check_media_type(&media_type)?;
    state
        .db
        .run(move |c| queries::remove_from_watchlist(c, app_profile_id, tmdb_id, &media_type))
        .await
}

#[tauri::command]
async fn get_watchlist(state: State<'_, AppState>, app_profile_id: i64) -> AppResult<Vec<WatchlistItem>> {
    state.db.run(move |c| queries::list_watchlist(c, app_profile_id)).await
}

#[tauri::command]
async fn is_in_watchlist(
    state: State<'_, AppState>,
    app_profile_id: i64,
    tmdb_id: i64,
    media_type: String,
) -> AppResult<bool> {
    check_media_type(&media_type)?;
    state
        .db
        .run(move |c| queries::is_in_watchlist(c, app_profile_id, tmdb_id, &media_type))
        .await
}

// ---------------------------------------------------------------------------------------------
// Global shortcuts ("Back to Hub")
// ---------------------------------------------------------------------------------------------

#[cfg(desktop)]
fn back_to_hub_shortcuts() -> [tauri_plugin_global_shortcut::Shortcut; 2] {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
    [
        // Primary: Ctrl+Shift+O (Overlay / Omnia). Secondary: Ctrl+Shift+H (Hub).
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyO),
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyH),
    ]
}

/// Either hotkey flushes the player's final position to SQLite, destroys the player window and
/// restores the catalog window (which re-reads Continue Watching on the back-to-hub event).
#[cfg(desktop)]
fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_global_shortcut::ShortcutState;
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if matches!(event.state(), ShortcutState::Pressed) && back_to_hub_shortcuts().contains(shortcut) {
                tauri::async_runtime::spawn(window_manager::back_to_hub(app.clone()));
            }
        })
        .build()
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Desktop shell: system tray, close-to-tray, window state, single instance
// ---------------------------------------------------------------------------------------------

#[cfg(desktop)]
const TRAY_ID: &str = "omnia-tray";
#[cfg(desktop)]
const TRAY_OPEN: &str = "tray-open";
#[cfg(desktop)]
const TRAY_QUIT: &str = "tray-quit";

/// Tray icon (Omnia's ring, from the generated icon set) with "Open Omnia" / "Quit Omnia".
/// Left click opens the hub; right click shows the menu.
#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, TRAY_OPEN, "Open Omnia", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit Omnia", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    // Tray uses the transparent mark (no dark square) so it sits cleanly on the taskbar.
    // icons/tray-icon.png is assets/app-icon-transparent.png with its background-removal
    // speckles stripped, at 64 px: crisp on 150-200% scaling, downscaled by Windows at 100%.
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Omnia")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN => wake_main_window(app),
            TRAY_QUIT => quit_app(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                wake_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Real exit (tray "Quit"): flush the open player's final position to SQLite first, then exit.
/// The window-state plugin saves the main window's size / position on exit.
#[cfg(desktop)]
/// Back from the tray (or a second launch): show the hub and catch up on other devices' viewing.
fn wake_main_window(app: &tauri::AppHandle) {
    window_manager::focus_main_window(app);
    sync::background::on_wake(app);
}

fn quit_app(app: tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static QUITTING: AtomicBool = AtomicBool::new(false);
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        window_manager::close_active_player(&app, "quit").await;
        app.exit(0);
    });
}

/// Main window size, position and maximized state across restarts. Player and importer
/// windows are never tracked: they are per-title / hidden.
#[cfg(desktop)]
fn window_state_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_window_state::StateFlags;
    tauri_plugin_window_state::Builder::new()
        .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
        .with_filter(|label| label == window_manager::MAIN_LABEL)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Must be the first plugin: a second launch (e.g. from the Start menu while Omnia sits in
    // the tray) focuses the running hub instead of opening the database twice.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        wake_main_window(app);
    }));

    let builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .build(),
    );

    #[cfg(desktop)]
    let builder = builder
        .plugin(global_shortcut_plugin())
        .plugin(window_state_plugin())
        // Close-to-tray: the main window's X hides it; the process keeps the embedding model,
        // recommender cache and isolated WebView2 sessions warm. "Quit Omnia" in the tray exits.
        .on_window_event(|window, event| {
            if window.label() == window_manager::MAIN_LABEL {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    // Coming back to Omnia (alt-tab, click): catch up (debounced, throttled).
                    tauri::WindowEvent::Focused(true) => sync::background::on_wake(window.app_handle()),
                    _ => {}
                }
            }
        });

    builder
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let db = tauri::async_runtime::block_on(Database::open(data_dir.join("omnia.db")))?;

            let http = reqwest::Client::builder()
                .user_agent(concat!("Omnia/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(6))
                .timeout(Duration::from_secs(15))
                .gzip(true)
                .brotli(true)
                .https_only(true)
                .build()?;

            let resolver = JustWatchResolver::new(http.clone());

            // Cross-device viewing: a quiet delta sync of every linked account shortly after start.
            sync::background::spawn_after(app.handle().clone(), sync::background::STARTUP_DELAY);

            // Startup maintenance: canonicalise OTT links, drop stale deep links and apply the
            // early-abandonment rule.
            let maintenance_db = db.clone();
            let maintenance_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Browser data of profiles deleted while it was still locked.
                match maintenance_db.run(|c| queries::list_profiles(c)).await {
                    Ok(list) => {
                        let ids: Vec<i64> = list.iter().map(|p| p.profile_id).collect();
                        window_manager::sweep_orphan_profile_data(&maintenance_app, &ids);
                    }
                    Err(e) => log::warn!("profile data sweep skipped: {e}"),
                }
                let rekey = maintenance_db
                    .run(|c| {
                        let mut moved = 0;
                        for m in queries::list_all_ott_mappings(c)? {
                            let canonical = window_manager::canonical_provider_id(m.provider_id, "");
                            // Legacy Netflix links stored a bare guid, which can match every
                            // profile of an account; they must be re-linked (guid::name).
                            if canonical == 8 && !m.ott_native_profile_id.contains("::") {
                                queries::delete_ott_mapping(c, m.app_profile_id, m.provider_id)?;
                                log::warn!("removed a legacy Netflix link for Omnia profile {}; re-link it in Connect Accounts", m.app_profile_id);
                                continue;
                            }
                            if canonical != m.provider_id {
                                queries::rekey_ott_mapping(c, m.app_profile_id, m.provider_id, canonical)?;
                                moved += 1;
                            }
                        }
                        Ok(moved)
                    })
                    .await;
                match rekey {
                    Ok(n) if n > 0 => log::info!("canonicalised {n} OTT profile links"),
                    Ok(_) => {}
                    Err(e) => log::warn!("OTT link canonicalisation failed: {e}"),
                }
                match maintenance_db.run(|c| queries::purge_expired_deep_links(c)).await {
                    Ok(n) if n > 0 => log::info!("purged {n} expired deep links"),
                    Ok(_) => {}
                    Err(e) => log::warn!("deep link purge failed: {e}"),
                }
                match maintenance_db.run(|c| queries::sweep_abandoned(c)).await {
                    Ok(n) if n > 0 => log::info!("flagged {n} abandoned titles"),
                    Ok(_) => {}
                    Err(e) => log::warn!("abandonment sweep failed: {e}"),
                }
            });

            app.manage(AppState {
                db,
                http,
                resolver,
                player: PlayerManager::default(),
                importer: HistoryImporter::default(),
                recommender: Recommender::new(EmbeddingService::new(data_dir.join("models"))),
            });

            // Warm up the local embedding model in the background (first run: verified download).
            let warm_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = warm_handle.state::<AppState>();
                let embedder = state.recommender.embeddings.get().await;
                log::info!("embedding backend: {}", embedder.model_id());
            });

            #[cfg(desktop)]
            setup_tray(app)?;

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                for shortcut in back_to_hub_shortcuts() {
                    let label = format!("{shortcut:?}");
                    if let Err(e) = app.global_shortcut().register(shortcut) {
                        // Another app may own the combo; the other hotkey and the in-player pill still work.
                        log::warn!("could not register global shortcut {label}: {e}");
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            create_profile,
            update_profile,
            delete_profile,
            get_setting,
            set_setting,
            get_all_settings,
            delete_setting,
            list_ott_profile_mappings,
            upsert_ott_profile_mapping,
            delete_ott_profile_mapping,
            list_subscribed_providers,
            set_subscribed_providers,
            set_provider_active,
            cache_media_metadata,
            get_cached_media,
            resolve_deep_links,
            get_cached_deep_links,
            record_watch_progress,
            mark_title_completed,
            get_continue_watching,
            get_watch_history,
            get_title_progress,
            delete_watch_history_entry,
            clear_watch_history,
            get_history_titles,
            delete_title_history,
            get_history_provider_counts,
            clear_provider_history,
            mark_watched,
            unmark_watched,
            mark_episodes_watched,
            set_favorite,
            is_favorite,
            get_favorites,
            get_collections,
            create_collection,
            rename_collection,
            delete_collection,
            add_to_collection,
            remove_from_collection,
            get_collection_items,
            get_title_collections,
            check_airing_shows,
            fetch_avatar_image,
            get_sync_states,
            sync_accounts_now,
            identify_title,
            import_watch_history,
            export_watch_history,
            log_playback_event,
            list_playback_events,
            list_custom_hubs,
            upsert_custom_hubs,
            delete_custom_hub,
            add_to_watchlist,
            remove_from_watchlist,
            get_watchlist,
            is_in_watchlist,
            get_preferred_provider,
            set_preferred_provider,
            clear_preferred_provider,
            hide_from_continue_watching,
            unhide_from_continue_watching,
            // Player (catalog window)
            window_manager::open_player,
            window_manager::close_player,
            window_manager::get_player_status,
            window_manager::player_rebind_title,
            // Player (injected script, remote OTT origins, token-gated)
            window_manager::sync_playback_telemetry,
            window_manager::player_back_to_hub,
            window_manager::report_ott_profile,
            // History import
            history_importer::import_ott_history,
            history_importer::import_history_file,
            history_importer::submit_scraped_history,
            history_importer::report_scrape_progress,
            // Recommendations
            recommender::get_recommendations,
            recommender::get_taste_summary,
            recommender::get_embedding_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Omnia");
}

#[cfg(test)]
mod avatar_url_tests {
    use super::*;

    #[test]
    fn avatar_urls_are_public_only_and_base64_is_standard() {
        let ok = |u: &str| is_public_host(&url::Url::parse(u).unwrap());
        assert!(ok("https://i.redd.it/abc.png"));
        assert!(!ok("http://localhost:8080/x.png"));
        assert!(!ok("http://192.168.1.10/x.png"));
        assert!(!ok("http://127.0.0.1/x.png"));
        assert!(!ok("http://[::1]/x.png"));
        assert!(!ok("http://printer.local/x.png"));
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"M"), "TQ==");
        assert!(validate_avatar(Some(format!("data:image/png;base64,{}", base64_encode(b"png")))).is_ok());
        assert!(validate_avatar(Some("https://evil.example/x.png".into())).is_err());
    }
}
