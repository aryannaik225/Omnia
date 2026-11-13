//! Omnia native backend: app state, command registration and global shortcut initialisation.

pub mod db;

pub mod resolver {
    pub mod justwatch;
}

pub mod player {
    pub mod window_manager;
}

pub mod sync {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(
        tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .build(),
    );

    #[cfg(desktop)]
    let builder = builder.plugin(global_shortcut_plugin());

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
            // Recommendations
            recommender::get_recommendations,
            recommender::get_taste_summary,
            recommender::get_embedding_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Omnia");
}
