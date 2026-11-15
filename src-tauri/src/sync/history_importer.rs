//! Zero-friction past watch-history importer.
//!
//! Sources:
//!   * **Netflix** — entirely inside a hidden WebView2 window in the profile's own (already
//!     signed-in) browser session, so Netflix only ever sees its genuine web client; no Rust HTTP
//!     client and no cookie copying is involved. The injected script switches to the mapped
//!     profile, calls the Shakti `viewingactivity` API with `fetch()` from the page, and if that
//!     is refused reads the viewing-activity page: the JSON Netflix's own app fetches (fetch/XHR
//!     capture), its embedded state, then — after hydration — the rendered rows. The active
//!     profile is verified before anything is read.
//!   * **Prime Video / Hotstar / Zee5 / SonyLIV / Disney+ / ...** — a hidden WebView2 window
//!     renders the provider's watch-history or Continue-Watching page and the injected script
//!     scrapes it (see `telemetry_injector.js`, import mode).
//!   * **Manual files** — Netflix "Download viewing activity" CSV, or an Omnia JSON export.
//!
//! Session isolation: every webview used here (the hidden import windows) is created in
//! the browser profile of the Omnia profile being imported (`wm::profile_webview_builder`), so an
//! import only ever sees the cookies that person signed in with.
//!
//! Profile isolation: imports run *for an `ott_profile_mappings` row*. Without a mapping there is
//! no import; when the provider session's active profile can't be verified as the mapped one,
//! the import is aborted instead of risking another family member's history.
//!
//! Privacy: provider cookies never leave WebView2 — Rust never reads them. Title matching goes to
//! TMDB (title strings only, no identifiers), after first trying the local catalog cache.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::{oneshot, Semaphore};
use tokio::task::JoinSet;

use crate::db::queries::{self, HistoryImport, MediaCatalogEntry, OttProfileMapping};
use crate::db::Database;
use crate::player::window_manager::{self as wm, canonical_provider_id, DetectedOttProfile, OttProvider};
use crate::resolver::justwatch::normalize_title;
use crate::{AppError, AppResult, AppState};

pub const EVT_IMPORT_PROGRESS: &str = "omnia://history-import-progress";
pub const EVT_IMPORT_FINISHED: &str = "omnia://history-import-finished";

const IMPORTER_LABEL_PREFIX: &str = "importer-";
const SCRAPE_TIMEOUT: Duration = Duration::from_secs(50);
/// Lifetime Netflix activity is paged in-page (100 entries a page, paced, with retries): years
/// of history can take several minutes. The script reports what it has before this ceiling.
const NETFLIX_SCRAPE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const TMDB_CONCURRENCY: usize = 4;
/// Distinct titles (a series counts once) — sized for a lifetime of viewing activity.
const MAX_UNIQUE_TITLES: usize = 5000;
const MAX_SEASON_LOOKUPS: usize = 2000;
/// Series scanned season-by-season to place episodes whose season couldn't be parsed.
const MAX_FULL_SERIES_LOOKUPS: usize = 60;
const MAX_SEASONS_PER_SHOW: usize = 40;
const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;
fn msg(m: impl Into<String>) -> AppError {
    AppError::Message(m.into())
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

struct PendingScrape {
    token: String,
    tx: oneshot::Sender<ScrapePayload>,
    app_profile_id: i64,
    provider_name: String,
}

#[derive(Default)]
pub struct HistoryImporter {
    pending: Mutex<HashMap<String, PendingScrape>>,
    running: Mutex<HashSet<(i64, i64)>>,
}

impl HistoryImporter {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingScrape>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn running(&self) -> std::sync::MutexGuard<'_, HashSet<(i64, i64)>> {
        self.running.lock().unwrap_or_else(|p| p.into_inner())
    }
    /// Is an import for this Omnia profile in progress (its browser data is in use)?
    pub fn has_running_for(&self, app_profile_id: i64) -> bool {
        self.running().iter().any(|(profile, _)| *profile == app_profile_id)
    }
}

/// Prevents two concurrent imports for the same (profile, provider).
struct RunGuard<'a> {
    importer: &'a HistoryImporter,
    key: (i64, i64),
}

impl<'a> RunGuard<'a> {
    fn acquire(importer: &'a HistoryImporter, key: (i64, i64)) -> AppResult<Self> {
        if !importer.running().insert(key) {
            return Err(msg("An import for this account is already running."));
        }
        Ok(Self { importer, key })
    }
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.importer.running().remove(&self.key);
    }
}

// ---------------------------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrapedItem {
    pub title: String,
    #[serde(default)]
    pub season_number: Option<i64>,
    #[serde(default)]
    pub episode_number: Option<i64>,
    #[serde(default)]
    pub episode_title: Option<String>,
    /// The provider's raw season label ("Season 2", "Part 3", "Volume II", "Limited Series").
    #[serde(default)]
    pub season_label: Option<String>,
    /// The provider's id of the watched video (Netflix `movieID`: the episode itself).
    #[serde(default)]
    pub ott_video_id: Option<String>,
    #[serde(default)]
    pub is_tv: bool,
    #[serde(default)]
    pub progress_ratio: Option<f64>,
    #[serde(default)]
    pub progress_seconds: Option<f64>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub watched_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrapePayload {
    pub token: String,
    #[serde(default)]
    pub items: Vec<ScrapedItem>,
    #[serde(default)]
    pub ott_profile: Option<DetectedOttProfile>,
    #[serde(default)]
    pub page_url: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// How the scrape went (statuses, page counts, totals; never titles), for the local log.
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub app_profile_id: i64,
    pub provider_name: String,
    pub ott_profile_id: Option<String>,
    /// Raw entries read from the source.
    pub fetched: usize,
    /// watch_history rows written (after merging repeat viewings).
    pub imported: usize,
    pub matched_titles: usize,
    /// Titles TMDB couldn't identify (first 50).
    pub unmatched_titles: Vec<String>,
}

/// Normalised history entry before TMDB entity resolution.
#[derive(Debug, Clone, Default)]
struct RawItem {
    title: String,
    /// `None` = unknown (try movie, then series).
    is_tv: Option<bool>,
    season: Option<i64>,
    episode: Option<i64>,
    episode_title: Option<String>,
    watched_at: Option<DateTime<Utc>>,
    /// Whether `watched_at` carries a real time of day (for time-of-day buckets).
    has_time_of_day: bool,
    progress_seconds: Option<f64>,
    duration_seconds: Option<f64>,
    progress_ratio: Option<f64>,
    /// History pages without progress info list titles the user watched: treat as completed.
    assume_completed: bool,
    /// Provider URL that reopens exactly this item (Netflix `/watch/<episode id>`).
    direct_url: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

fn emit_progress(app: &AppHandle, app_profile_id: i64, provider_name: &str, stage: &str, done: usize, total: usize) {
    let _ = app.emit_to(
        wm::MAIN_LABEL,
        EVT_IMPORT_PROGRESS,
        json!({ "appProfileId": app_profile_id, "providerName": provider_name, "stage": stage, "done": done, "total": total }),
    );
}

/// Fire-and-forget import (used right after the profile handshake). Emits `EVT_IMPORT_FINISHED`.
pub fn spawn_import(app: AppHandle, app_profile_id: i64, provider_id: i64, provider_name: String) {
    tauri::async_runtime::spawn(async move {
        let result = import_ott_history_inner(&app, app_profile_id, provider_id, &provider_name).await;
        let body = match result {
            Ok(report) => json!({ "ok": true, "report": report }),
            Err(e) => {
                log::warn!("history import for provider {provider_id} failed: {e}");
                json!({ "ok": false, "appProfileId": app_profile_id, "providerId": provider_id, "providerName": provider_name, "error": e.to_string() })
            }
        };
        let _ = app.emit_to(wm::MAIN_LABEL, EVT_IMPORT_FINISHED, body);
    });
}

async fn import_ott_history_inner(
    app: &AppHandle,
    app_profile_id: i64,
    provider_id: i64,
    provider_name: &str,
) -> AppResult<ImportReport> {
    let state = app.state::<AppState>();
    // Links are stored per provider family ("Prime Video with Ads" == "Prime Video").
    let provider_id = canonical_provider_id(provider_id, provider_name);
    let _guard = RunGuard::acquire(&state.importer, (app_profile_id, provider_id))?;

    let mapping = state
        .db
        .run(move |c| queries::get_ott_mapping(c, app_profile_id, provider_id))
        .await?
        .ok_or_else(|| msg(format!("Link your {provider_name} profile to this Omnia profile before importing.")))?;
    let tmdb = TmdbClient::from_settings(&state).await?;
    let region = state
        .db
        .run(|c| queries::get_setting(c, queries::keys::REGION_CODE))
        .await?
        .unwrap_or_else(|| "US".into());

    emit_progress(app, app_profile_id, provider_name, "fetching", 0, 0);
    let provider = OttProvider::detect(provider_id, provider_name);
    let raw = match provider {
        OttProvider::Netflix => scrape_netflix_in_page(app, &mapping, provider_name).await?,
        OttProvider::Generic => {
            return Err(msg(format!(
                "Automatic import isn't available for {provider_name}. Use a CSV/JSON file import instead."
            )))
        }
        other => scrape_provider_history(app, other, provider_name, &mapping, &region).await?,
    };

    resolve_and_store(app, &state.db, &tmdb, app_profile_id, provider_name, Some(mapping.ott_native_profile_id), raw).await
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/// Imports history for one linked OTT account into the Omnia profile it is mapped to.
#[tauri::command]
pub async fn import_ott_history(
    app: AppHandle,
    app_profile_id: i64,
    provider_id: i64,
    provider_name: String,
) -> AppResult<ImportReport> {
    let report = import_ott_history_inner(&app, app_profile_id, provider_id, &provider_name).await?;
    let _ = app.emit_to(wm::MAIN_LABEL, EVT_IMPORT_FINISHED, json!({ "ok": true, "report": report }));
    Ok(report)
}

/// Manual drag-and-drop import: Netflix viewing-activity CSV or an Omnia JSON export.
/// Rows always land in `app_profile_id`, regardless of profile ids inside the file.
#[tauri::command]
pub async fn import_history_file(
    app: AppHandle,
    state: State<'_, AppState>,
    app_profile_id: i64,
    provider_name: Option<String>,
    file_name: String,
    contents: String,
) -> AppResult<ImportReport> {
    if contents.len() > MAX_FILE_BYTES {
        return Err(msg("File is too large (20 MB max)."));
    }
    state
        .db
        .run(move |c| queries::get_profile(c, app_profile_id))
        .await?
        .ok_or_else(|| msg(format!("profile {app_profile_id} not found")))?;

    let text = contents.trim_start_matches('\u{feff}').trim_start();
    let is_json = file_name.to_lowercase().ends_with(".json") || text.starts_with('[') || text.starts_with('{');

    if is_json {
        let rows = parse_omnia_json(text, app_profile_id)?;
        let count = rows.len();
        state.db.run(move |c| queries::upsert_imported_history(c, &rows)).await?;
        let report = ImportReport {
            app_profile_id,
            provider_name: provider_name.unwrap_or_else(|| "Omnia backup".into()),
            fetched: count,
            imported: count,
            matched_titles: count,
            ..Default::default()
        };
        let _ = app.emit_to(wm::MAIN_LABEL, EVT_IMPORT_FINISHED, json!({ "ok": true, "report": report }));
        return Ok(report);
    }

    let provider_name = provider_name.unwrap_or_else(|| "Netflix".into());
    let raw = parse_viewing_activity_csv(text)?;
    let tmdb = TmdbClient::from_settings(&state).await?;
    let report = resolve_and_store(&app, &state.db, &tmdb, app_profile_id, &provider_name, None, raw).await?;
    let _ = app.emit_to(wm::MAIN_LABEL, EVT_IMPORT_FINISHED, json!({ "ok": true, "report": report }));
    Ok(report)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeProgress {
    pub token: String,
    /// Entries read so far.
    pub fetched: usize,
    /// Size of the whole history, when the provider reports it.
    #[serde(default)]
    pub total: Option<usize>,
}

/// Live "entries read so far" from a hidden importer window (remote origin, token-gated), so
/// a multi-minute lifetime import visibly advances in Connect Accounts.
#[tauri::command]
pub fn report_scrape_progress(window: WebviewWindow, app: AppHandle, state: State<'_, AppState>, payload: ScrapeProgress) -> AppResult<()> {
    let target = {
        let map = state.importer.pending();
        match map.get(window.label()) {
            Some(p) if wm::tokens_equal(&p.token, &payload.token) => Some((p.app_profile_id, p.provider_name.clone())),
            _ => None,
        }
    };
    let (app_profile_id, provider_name) = target.ok_or_else(|| msg("unauthorized importer session"))?;
    let total = payload.total.unwrap_or(0).max(payload.fetched);
    emit_progress(&app, app_profile_id, &provider_name, "fetching", payload.fetched, if payload.total.is_some() { total } else { 0 });
    Ok(())
}

/// Called by the injected script inside a hidden importer window (remote origin, token-gated).
#[tauri::command]
pub async fn submit_scraped_history(window: WebviewWindow, state: State<'_, AppState>, payload: ScrapePayload) -> AppResult<()> {
    let pending = {
        let mut map = state.importer.pending();
        match map.get(window.label()) {
            Some(p) if wm::tokens_equal(&p.token, &payload.token) => map.remove(window.label()),
            _ => None,
        }
    }
    .ok_or_else(|| msg("unauthorized importer session"))?;
    let _ = pending.tx.send(payload);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Netflix (hidden WebView2 only)
// ---------------------------------------------------------------------------------------------

/// Netflix identities are `guid::profile name` (links created before this format store the bare
/// guid). Both the guid and, when present, the name must match.
fn netflix_identity_matches(mapped: &str, guid: &str, name: Option<&str>) -> bool {
    match mapped.split_once("::") {
        Some((mapped_guid, mapped_name)) => {
            mapped_guid.trim() == guid.trim() && name.is_some_and(|n| n.trim() == mapped_name.trim())
        }
        None => mapped.trim() == guid.trim(),
    }
}

/// Netflix history is read *only* inside a hidden WebView2 window in the Omnia profile's own
/// browser session: Netflix sees its genuine web client (TLS stack, cookies, headers), never a
/// Rust HTTP client, and session cookies never leave WebView2. The window starts on the profile
/// switch URL; the injected script calls the Shakti API in-page and, if that is refused, reads
/// the viewing-activity page (captured app requests, embedded state, then hydrated rows).
async fn scrape_netflix_in_page(app: &AppHandle, mapping: &OttProfileMapping, provider_name: &str) -> AppResult<Vec<RawItem>> {
    let start = OttProvider::Netflix
        .profile_switch_url(&mapping.ott_native_profile_id)
        .unwrap_or_else(|| "https://www.netflix.com/browse".to_string());
    let payload = scrape_with_hidden_window(
        app,
        mapping.app_profile_id,
        OttProvider::Netflix,
        provider_name,
        &start,
        "netflix_history",
        Some(&mapping.ott_native_profile_id),
        NETFLIX_SCRAPE_TIMEOUT,
    )
    .await?;
    // Netflix exposes the active profile reliably, so verification is mandatory here.
    match payload.ott_profile.as_ref().map(|p| p.id.as_str()) {
        Some(id) if id == mapping.ott_native_profile_id || netflix_identity_matches(&mapping.ott_native_profile_id, wm::netflix_guid(id), id.split_once("::").map(|(_, n)| n)) => {}
        Some(_) => return Err(msg("Netflix is on a different profile than the linked one; import aborted to keep profiles separate.")),
        None => return Err(msg("Couldn't verify the active Netflix profile; import aborted to keep profiles separate.")),
    }
    if let Some(notes) = payload.notes.as_deref() {
        log::info!("Netflix history read: {} entries ({notes})", payload.items.len());
    }
    if payload.items.is_empty() {
        return Err(msg(payload.error.unwrap_or_else(|| "No Netflix history was found.".into())));
    }
    Ok(scraped_to_raw(payload.items, true, true))
}

// ---------------------------------------------------------------------------------------------
// Hidden-WebView2 scraping (Prime Video history, Continue-Watching trays)
// ---------------------------------------------------------------------------------------------

/// Decides whether a scrape can be attributed to the mapped profile.
fn verify_scraped_profile(mapped_id: &str, observed: Option<&str>, mappings_for_provider: i64) -> Result<(), String> {
    match observed {
        Some(o) if o == mapped_id => Ok(()),
        Some(_) => Err("The provider is signed in to a different profile than the one linked to this Omnia profile. Switch profiles in Connect Accounts and retry.".into()),
        None if mappings_for_provider <= 1 => Ok(()),
        None => Err("Couldn't verify which provider profile is active, and several Omnia profiles are linked to it — import aborted to keep histories separate.".into()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn scrape_with_hidden_window(
    app: &AppHandle,
    app_profile_id: i64,
    provider: OttProvider,
    provider_name: &str,
    url: &str,
    scraper: &str,
    expected_profile: Option<&str>,
    timeout: Duration,
) -> AppResult<ScrapePayload> {
    let state = app.state::<AppState>();
    let parsed = tauri::Url::parse(url).map_err(|e| msg(e.to_string()))?;
    let label = wm::next_window_label(IMPORTER_LABEL_PREFIX);
    let token = wm::random_token();
    let (tx, rx) = oneshot::channel();
    state.importer.pending().insert(
        label.clone(),
        PendingScrape { token: token.clone(), tx, app_profile_id, provider_name: provider_name.to_string() },
    );

    let config = json!({
        "token": token,
        "mode": "import",
        "provider": provider.key(),
        "providerName": provider_name,
        "appProfileName": "",
        "title": null,
        "resumeAtSeconds": 0,
        "syncIntervalMs": 3000,
        "scraper": scraper,
        "expectedOttProfileId": expected_profile,
        // Leave headroom so the script reports what it has before Rust gives up.
        "scrapeTimeoutMs": timeout.saturating_sub(Duration::from_secs(20)).as_millis() as u64,
    });
    let window = match wm::build_ott_window(app, &label, parsed, "Omnia — importing history", wm::build_injection(&config), false, app_profile_id) {
        Ok(w) => w,
        Err(e) => {
            state.importer.pending().remove(&label);
            return Err(e);
        }
    };
    let outcome = tokio::time::timeout(timeout, rx).await;
    state.importer.pending().remove(&label);
    let _ = window.destroy();
    match outcome {
        Ok(Ok(payload)) => Ok(payload),
        Ok(Err(_)) => Err(msg("The history window closed before finishing.")),
        Err(_) => Err(msg(format!("Timed out reading {provider_name} history. Are you signed in?"))),
    }
}

/// Converts scraped rows into raw history. Netflix activity titles ("Series: Season 2: Episode")
/// are split into series / season / episode title.
fn scraped_to_raw(items: Vec<ScrapedItem>, history_page: bool, netflix: bool) -> Vec<RawItem> {
    items
        .into_iter()
        .filter(|i| !i.title.trim().is_empty())
        .map(|i| {
            let ratio = i.progress_ratio.filter(|r| r.is_finite()).map(|r| r.clamp(0.0, 1.0));
            let has_seconds = i.progress_seconds.is_some_and(|p| p.is_finite()) && i.duration_seconds.is_some_and(|d| d > 1.0);
            let (title, mut is_tv, mut season, mut episode_title) = (
                i.title.trim().to_string(),
                if i.is_tv || i.episode_number.is_some() { Some(true) } else { None },
                i.season_number,
                i.episode_title.clone(),
            );
            let mut episode = i.episode_number;
            if season.is_none() {
                season = i.season_label.as_deref().and_then(season_segment).map(|(s, _)| s);
            }
            // An episode "title" that is only a marker ("Episode 4", "E04: Title") carries the number.
            if episode.is_none() {
                if let Some((n, rest)) = episode_title.as_deref().and_then(episode_marker) {
                    episode = Some(n);
                    episode_title = rest;
                }
            }
            let title = if netflix && season.is_none() && episode_title.is_none() {
                let parsed = parse_netflix_title(&title);
                is_tv = is_tv.or(parsed.is_tv);
                season = parsed.season;
                episode = episode.or(parsed.episode);
                episode_title = parsed.episode_title;
                parsed.series
            } else {
                title
            };
            RawItem {
                title,
                is_tv,
                season,
                episode,
                episode_title,
                watched_at: i.watched_at.as_deref().and_then(parse_loose_date),
                has_time_of_day: false,
                progress_seconds: if has_seconds { i.progress_seconds } else { None },
                duration_seconds: if has_seconds { i.duration_seconds } else { None },
                progress_ratio: ratio,
                assume_completed: history_page && ratio.is_none() && !has_seconds,
                direct_url: if netflix { netflix_watch_url(i.ott_video_id.as_deref()) } else { None },
            }
        })
        .collect()
}

/// `https://www.netflix.com/watch/<id>` for a numeric Netflix video id. Opening it starts that
/// exact episode (or film) in the player, unlike the series' `/title/<id>` landing page.
pub(crate) fn netflix_watch_url(video_id: Option<&str>) -> Option<String> {
    let id = video_id?.trim();
    (id.len() >= 3 && id.len() <= 12 && id.chars().all(|c| c.is_ascii_digit())).then(|| format!("https://www.netflix.com/watch/{id}"))
}

async fn scrape_provider_history(
    app: &AppHandle,
    provider: OttProvider,
    provider_name: &str,
    mapping: &OttProfileMapping,
    region: &str,
) -> AppResult<Vec<RawItem>> {
    let (url, scraper, history_page) = match provider {
        OttProvider::PrimeVideo => ("https://www.primevideo.com/settings/watch-history/".to_string(), "primevideo_history", true),
        other => (
            other.home_url(region).ok_or_else(|| msg(format!("No importer for {provider_name}.")))?,
            "continue_watching",
            false,
        ),
    };
    let payload = scrape_with_hidden_window(app, mapping.app_profile_id, provider, provider_name, &url, scraper, Some(&mapping.ott_native_profile_id), SCRAPE_TIMEOUT).await?;

    let state = app.state::<AppState>();
    let provider_id = mapping.provider_id;
    let linked = state
        .db
        .run(move |c| queries::count_mappings_for_provider(c, provider_id))
        .await?;
    verify_scraped_profile(
        &mapping.ott_native_profile_id,
        payload.ott_profile.as_ref().map(|p| p.id.as_str()),
        linked,
    )
    .map_err(msg)?;

    if payload.items.is_empty() {
        return Err(msg(payload.error.unwrap_or_else(|| format!("No {provider_name} history was found."))));
    }
    Ok(scraped_to_raw(payload.items, history_page, false))
}

// ---------------------------------------------------------------------------------------------
// File formats
// ---------------------------------------------------------------------------------------------

fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' => in_quotes = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                if row.iter().any(|f| !f.trim().is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        if row.iter().any(|f| !f.trim().is_empty()) {
            rows.push(row);
        }
    }
    rows
}

pub(crate) fn parse_loose_date(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    for f in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(s, f) {
            return Some(Utc.from_utc_datetime(&d));
        }
    }
    for f in ["%Y-%m-%d", "%m/%d/%y", "%m/%d/%Y", "%d/%m/%Y", "%d/%m/%y", "%d.%m.%Y", "%B %d, %Y", "%d %B %Y"] {
        if let Ok(d) = NaiveDate::parse_from_str(s, f) {
            return d.and_hms_opt(12, 0, 0).map(|dt| Utc.from_utc_datetime(&dt));
        }
    }
    None
}

/// A Netflix activity title split into its parts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct NetflixTitle {
    series: String,
    is_tv: Option<bool>,
    season: Option<i64>,
    episode: Option<i64>,
    episode_title: Option<String>,
}

/// Words Netflix (and other providers) use for a season-like unit.
const SEASON_WORDS: &[&str] = &["season", "series", "part", "volume", "book", "collection", "chapter", "temporada", "staffel", "saison"];
const EPISODE_WORDS: &[&str] = &["episode", "ep", "e", "épisode", "episodio", "folge"];

/// A season/episode number written as digits, a word ("Two") or a roman numeral ("II").
fn number_token(token: &str) -> Option<i64> {
    let t = token.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    if t.is_empty() {
        return None;
    }
    if t.chars().all(|c| c.is_ascii_digit()) {
        return t.parse().ok().filter(|n| (0..=2000).contains(n));
    }
    const WORDS: &[&str] = &[
        "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
        "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
    ];
    if let Some(i) = WORDS.iter().position(|w| *w == t) {
        return Some(i as i64 + 1);
    }
    const ROMAN: &[&str] = &["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv"];
    ROMAN.iter().position(|r| *r == t).map(|i| i as i64 + 1)
}

/// `S2E3`, `S02E03`, `S2:E3`, `S2.E3`, `S2 E3` → (2, 3).
fn compact_se(token: &str) -> Option<(i64, Option<i64>)> {
    let t = token.to_lowercase();
    let rest = t.strip_prefix('s')?;
    let season_len = rest.chars().take_while(char::is_ascii_digit).count();
    if season_len == 0 || season_len > 3 {
        return None;
    }
    let season: i64 = rest[..season_len].parse().ok()?;
    let after = rest[season_len..].trim_start_matches([':', '.', ' ', '-', '|', '·']);
    if after.is_empty() {
        return Some((season, None));
    }
    let ep = after.strip_prefix('e')?;
    let ep = ep.strip_prefix("p.").or_else(|| ep.strip_prefix("p")).unwrap_or(ep).trim_start();
    let ep_len = ep.chars().take_while(char::is_ascii_digit).count();
    (ep_len > 0 && ep_len == ep.len()).then(|| Some((season, ep.parse().ok())))?
}

/// Reads a season marker segment: "Season 2", "Series 3", "Part II", "Volume Two", "Vol. 1",
/// "Limited Series", "S2", "S2E3", "Season 2 Episode 3", "Season 2, Ep. 3" …
/// Returns (season, episode-if-present).
fn season_segment(segment: &str) -> Option<(i64, Option<i64>)> {
    let seg = segment.trim();
    let lower = seg.to_lowercase();
    if matches!(lower.as_str(), "limited series" | "miniseries" | "mini-series" | "the complete series") {
        return Some((1, None));
    }
    if let Some(se) = compact_se(&lower.replace(' ', "")) {
        return Some(se);
    }
    let tokens: Vec<&str> = lower
        .split(|c: char| c.is_whitespace() || c == ',' || c == '(' || c == ')' || c == '-' || c == '|' || c == '·')
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.len() < 2 || tokens.len() > 5 {
        return None;
    }
    let word = tokens[0].trim_end_matches('.');
    if !SEASON_WORDS.contains(&word) {
        return None;
    }
    let season = number_token(tokens[1])?;
    let episode = match &tokens[2..] {
        [] => None,
        [w, n] if EPISODE_WORDS.contains(&w.trim_end_matches('.')) => Some(number_token(n)?),
        [t] => compact_episode(t),
        _ => return None,
    };
    Some((season, episode))
}

/// `E3`, `Ep3`, `Ep.3` → 3.
fn compact_episode(token: &str) -> Option<i64> {
    let t = token.to_lowercase();
    let t = t.strip_prefix("ep.").or_else(|| t.strip_prefix("ep")).or_else(|| t.strip_prefix('e'))?;
    t.parse().ok()
}

/// An explicit episode marker at the start of an episode segment: "Episode 3", "Ep. 3",
/// "E03", "Episode Three". Returns (episode, the title text after it if any).
fn episode_marker(segment: &str) -> Option<(i64, Option<String>)> {
    let seg = segment.trim();
    let mut words = seg.splitn(3, char::is_whitespace);
    let first = words.next()?.to_lowercase();
    let first_clean = first.trim_end_matches(['.', ':', ',']);
    let (number, rest) = if EPISODE_WORDS.contains(&first_clean) && first_clean != "e" {
        (number_token(words.next()?)?, words.next())
    } else {
        let after_first = seg[first.len()..].trim_start();
        (compact_episode(first_clean)?, Some(after_first).filter(|r| !r.is_empty()))
    };
    let rest = rest
        .map(|r| r.trim_start_matches([':', '-', '–', '—', '.', ',', ' ']).trim().trim_matches('"').to_string())
        .filter(|r| !r.is_empty());
    Some((number, rest))
}

/// Splits Netflix's activity titles. Handles "Series: Season 1: Episode Title" and the variants
/// Netflix uses per show and region: "Series 2", "Part 3", "Volume 1", "Vol. 2", "Book Two",
/// "Collection 1", "Limited Series", "S2:E3", "Season 2 Episode 3", "Season 2: Episode 3",
/// "Season 2: Episode 3: Title" and roman / spelled-out numbers.
fn parse_netflix_title(full: &str) -> NetflixTitle {
    let full = full.trim();
    // Netflix separates with ": "; a few regions/exports use " - " around the season marker.
    let normalized = full.replace(" - Season ", ": Season ").replace(" - Part ", ": Part ").replace(" - Volume ", ": Volume ");
    let parts: Vec<&str> = normalized.split(": ").collect();
    for i in 1..parts.len() {
        let Some((season, mut episode)) = season_segment(parts[i]) else { continue };
        let mut rest: Vec<&str> = parts[i + 1..].to_vec();
        // A trailing marker with nothing after it is a movie sequel ("Deathly Hallows: Part 1",
        // "Kill Bill: Volume 1"): Netflix always follows a season with the episode.
        if rest.is_empty() && episode.is_none() {
            continue;
        }
        let mut episode_title = None;
        if let Some(first) = rest.first().copied() {
            if episode.is_none() {
                if let Some((n, tail)) = episode_marker(first) {
                    episode = Some(n);
                    rest.remove(0);
                    episode_title = tail;
                }
            }
        }
        if episode_title.is_none() {
            episode_title = Some(rest.join(": ").trim().trim_matches('"').to_string()).filter(|t| !t.is_empty());
        }
        return NetflixTitle {
            series: parts[..i].join(": ").trim().to_string(),
            is_tv: Some(true),
            season: Some(season),
            episode,
            episode_title,
        };
    }
    // No season marker, but an explicit episode marker: "Show: Episode 4" / "Show: E4: Title".
    for i in 1..parts.len() {
        if let Some((n, tail)) = episode_marker(parts[i]) {
            let mut title = parts[i + 1..].join(": ");
            if let Some(t) = tail {
                title = if title.is_empty() { t } else { format!("{t}: {title}") };
            }
            return NetflixTitle {
                series: parts[..i].join(": ").trim().to_string(),
                is_tv: Some(true),
                season: None,
                episode: Some(n),
                episode_title: Some(title.trim().trim_matches('"').to_string()).filter(|t| !t.is_empty()),
            };
        }
    }
    NetflixTitle { series: full.to_string(), ..Default::default() }
}

/// Netflix "Download viewing activity" CSV. It only has `Title` and `Date` columns (no profile
/// column: each profile downloads its own file), so every row is imported into the Omnia profile
/// that dropped the file.
///
/// Media type is decided strictly from the title: rows with a season/episode marker are series
/// (TMDB `/search/tv` only); a bare title is a film (`/search/movie` only) unless the same title
/// also appears with episodes in this file.
fn parse_viewing_activity_csv(text: &str) -> AppResult<Vec<RawItem>> {
    let rows = parse_csv(text);
    let header = rows.first().ok_or_else(|| msg("The CSV file is empty."))?;
    let find = |name: &str| header.iter().position(|h| h.trim().trim_start_matches('\u{feff}').eq_ignore_ascii_case(name));
    let title_col = find("Title").ok_or_else(|| msg("CSV needs a 'Title' column (Netflix viewing activity format)."))?;
    let date_col = find("Date");
    let mut items: Vec<RawItem> = rows
        .iter()
        .skip(1)
        .filter_map(|r| {
            let full = r.get(title_col)?.trim();
            if full.is_empty() {
                return None;
            }
            let parsed = parse_netflix_title(full);
            Some(RawItem {
                title: parsed.series,
                is_tv: parsed.is_tv,
                season: parsed.season,
                episode: parsed.episode,
                episode_title: parsed.episode_title,
                watched_at: date_col.and_then(|c| r.get(c)).and_then(|d| parse_loose_date(d)),
                has_time_of_day: false,
                assume_completed: true,
                ..Default::default()
            })
        })
        .collect();
    let series: HashSet<String> = items
        .iter()
        .filter(|i| i.is_tv == Some(true))
        .map(|i| normalize_title(&clean_search_title(&i.title)))
        .collect();
    for item in &mut items {
        if item.is_tv.is_none() {
            item.is_tv = Some(series.contains(&normalize_title(&clean_search_title(&item.title))));
        }
    }
    Ok(items)
}

/// Omnia JSON export (array of watch-history entries, or `{ "history": [...] }`).
fn parse_omnia_json(text: &str, app_profile_id: i64) -> AppResult<Vec<HistoryImport>> {
    let v: Value = serde_json::from_str(text)?;
    let arr = v
        .as_array()
        .or_else(|| v["history"].as_array())
        .ok_or_else(|| msg("Unrecognised JSON: expected an Omnia history export."))?;
    let rows: Vec<HistoryImport> = arr
        .iter()
        .filter_map(|o| {
            let media_type = o["mediaType"].as_str()?;
            if media_type != "movie" && media_type != "tv" {
                return None;
            }
            Some(HistoryImport {
                app_profile_id,
                tmdb_id: o["tmdbId"].as_i64()?,
                media_type: media_type.to_string(),
                season_number: o["seasonNumber"].as_i64().unwrap_or(0),
                episode_number: o["episodeNumber"].as_i64().unwrap_or(0),
                episode_title: o["episodeTitle"].as_str().map(str::to_string),
                provider_name: o["providerName"].as_str().map(str::to_string),
                direct_url: o["directUrl"].as_str().filter(|u| u.starts_with("https://")).map(str::to_string),
                progress_seconds: o["progressSeconds"].as_f64().unwrap_or(0.0),
                duration_seconds: o["durationSeconds"].as_f64().unwrap_or(0.0),
                is_completed: o["isCompleted"].as_bool().unwrap_or(false),
                watched_at: o["lastWatchedAt"].as_str().or_else(|| o["watchedAt"].as_str()).map(str::to_string),
                time_of_day_bucket: o["timeOfDayBucket"].as_str().map(str::to_string),
                watch_count: o["watchCount"].as_i64(),
            })
        })
        .collect();
    if rows.is_empty() {
        return Err(msg("No valid history entries were found in the JSON file."));
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------------------------
// TMDB entity resolution
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
pub(crate) struct TmdbClient {
    http: reqwest::Client,
    credential: Arc<str>,
    bearer: bool,
}

#[derive(Debug, Clone)]
struct TmdbHit {
    id: i64,
    media_type: &'static str,
    title: String,
    original_title: Option<String>,
    year: Option<i64>,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    overview: Option<String>,
    vote_average: Option<f64>,
    genre_ids: Value,
    /// TMDB popularity and vote count: tie-breakers so obscure same-name titles never win.
    popularity: f64,
    vote_count: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct Matched {
    pub(crate) tmdb_id: i64,
    pub(crate) media_type: String,
    runtime_mins: Option<i64>,
    pub(crate) catalog: Option<MediaCatalogEntry>,
}

#[derive(Debug, Clone)]
pub(crate) struct EpisodeInfo {
    pub(crate) number: i64,
    pub(crate) name: String,
    pub(crate) runtime_mins: Option<i64>,
}

/// Finds an episode by name: exact (normalised) match first, then a unique containment match
/// ("The One with the Thumb" vs "The One With The Thumb (Part 1)"). Regular seasons win over
/// specials when names repeat.
pub(crate) fn match_episode_name<'a, T>(episodes: &'a [T], wanted: &str, name_of: impl Fn(&T) -> &str) -> Option<&'a T> {
    let wanted = normalize_title(wanted);
    if wanted.is_empty() {
        return None;
    }
    if let Some(e) = episodes.iter().find(|e| normalize_title(name_of(e)) == wanted) {
        return Some(e);
    }
    if wanted.chars().count() < 8 {
        return None;
    }
    let mut hits = episodes.iter().filter(|e| {
        let name = normalize_title(name_of(e));
        name.chars().count() >= 8 && (name.contains(&wanted) || wanted.contains(&name))
    });
    let first = hits.next()?;
    hits.next().is_none().then_some(first)
}

impl TmdbClient {
    pub(crate) async fn from_settings(state: &AppState) -> AppResult<Self> {
        let key = state
            .db
            .run(|c| queries::get_setting(c, queries::keys::TMDB_API_KEY))
            .await?
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .ok_or_else(|| msg("A TMDB API key is required to match imported titles. Add it in Settings."))?;
        Ok(Self { http: state.http.clone(), bearer: key.starts_with("eyJ"), credential: key.into() })
    }

    pub(crate) async fn get(&self, path: &str, params: &[(&str, String)]) -> AppResult<Value> {
        let url = format!("https://api.themoviedb.org/3{path}");
        for attempt in 0..3u64 {
            let mut req = self.http.get(&url).query(params);
            req = if self.bearer {
                req.bearer_auth(&*self.credential)
            } else {
                req.query(&[("api_key", &*self.credential)])
            };
            let resp = req.send().await?;
            let status = resp.status();
            if status.as_u16() == 429 {
                tokio::time::sleep(Duration::from_millis(800 * (attempt + 1))).await;
                continue;
            }
            if status.as_u16() == 401 {
                return Err(msg("TMDB rejected the API key. Check it in Settings."));
            }
            if !status.is_success() {
                return Err(msg(format!("TMDB request failed (HTTP {status})")));
            }
            return Ok(resp.json().await?);
        }
        Err(msg("TMDB rate limit exceeded; try again shortly."))
    }

    /// `/search/tv` or `/search/movie` only (never `/search/multi`), optionally filtered by year
    /// (`first_air_date_year` / `primary_release_year`).
    async fn search(&self, media_type: &'static str, query: &str, year: Option<i64>) -> AppResult<Vec<TmdbHit>> {
        let mut params = vec![("query", query.to_string()), ("include_adult", "false".into()), ("page", "1".into())];
        if let Some(y) = year {
            params.push((if media_type == "tv" { "first_air_date_year" } else { "primary_release_year" }, y.to_string()));
        }
        let body = self.get(&format!("/search/{media_type}"), &params).await?;
        let (t, ot, date) = if media_type == "movie" {
            ("title", "original_title", "release_date")
        } else {
            ("name", "original_name", "first_air_date")
        };
        Ok(body["results"]
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or_default()
            .iter()
            .filter_map(|r| {
                Some(TmdbHit {
                    id: r["id"].as_i64()?,
                    media_type,
                    title: r[t].as_str()?.to_string(),
                    original_title: r[ot].as_str().map(str::to_string),
                    year: r[date].as_str().and_then(|d| d.get(0..4)).and_then(|y| y.parse().ok()),
                    poster_path: r["poster_path"].as_str().map(str::to_string),
                    backdrop_path: r["backdrop_path"].as_str().map(str::to_string),
                    overview: r["overview"].as_str().map(str::to_string),
                    vote_average: r["vote_average"].as_f64(),
                    genre_ids: r["genre_ids"].clone(),
                    popularity: r["popularity"].as_f64().unwrap_or(0.0),
                    vote_count: r["vote_count"].as_i64().unwrap_or(0),
                })
            })
            .collect())
    }

    pub(crate) async fn season_episodes(&self, tv_id: i64, season: i64) -> AppResult<Vec<EpisodeInfo>> {
        let body = self.get(&format!("/tv/{tv_id}/season/{season}"), &[]).await?;
        Ok(body["episodes"]
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or_default()
            .iter()
            .filter_map(|e| {
                Some(EpisodeInfo {
                    number: e["episode_number"].as_i64()?,
                    name: e["name"].as_str().unwrap_or_default().to_string(),
                    runtime_mins: e["runtime"].as_i64(),
                })
            })
            .collect())
    }

    /// Season numbers of a series, regular seasons first and specials (season 0) last.
    async fn season_numbers(&self, tv_id: i64) -> AppResult<Vec<i64>> {
        let body = self.get(&format!("/tv/{tv_id}"), &[]).await?;
        let mut seasons: Vec<i64> = body["seasons"]
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or_default()
            .iter()
            .filter_map(|s| s["season_number"].as_i64())
            .collect();
        seasons.sort_by_key(|n| (*n == 0, *n));
        seasons.dedup();
        Ok(seasons)
    }

    /// Every episode of a series as (season, episode), for matching by episode name.
    pub(crate) async fn series_episodes(&self, tv_id: i64) -> AppResult<Vec<(i64, EpisodeInfo)>> {
        let mut out = Vec::new();
        for season in self.season_numbers(tv_id).await?.into_iter().take(MAX_SEASONS_PER_SHOW) {
            match self.season_episodes(tv_id, season).await {
                Ok(eps) => out.extend(eps.into_iter().map(|e| (season, e))),
                Err(e) if e.to_string().contains("API key") => return Err(e),
                Err(e) => log::debug!("TMDB season {season} of {tv_id} failed: {e}"),
            }
        }
        Ok(out)
    }

    async fn runtime_mins(&self, tmdb_id: i64, media_type: &str) -> AppResult<Option<i64>> {
        let body = self.get(&format!("/{media_type}/{tmdb_id}"), &[]).await?;
        Ok(if media_type == "movie" {
            body["runtime"].as_i64()
        } else {
            body["episode_run_time"].as_array().and_then(|a| a.first()).and_then(Value::as_i64)
        })
    }
}

/// Strips platform decorations TMDB doesn't know: "RRR (Hindi)", "Dark - Season 1", trailing years.
fn clean_search_title(title: &str) -> String {
    let mut t = title.trim().to_string();
    loop {
        let trimmed = t.trim_end();
        if trimmed.ends_with(')') {
            if let Some(open) = trimmed.rfind(" (") {
                t = trimmed[..open].to_string();
                continue;
            }
        }
        break;
    }
    if let Some(idx) = t.to_lowercase().find(" - season ") {
        t.truncate(idx);
    }
    t.trim().to_string()
}

/// A release year written into the source title ("Dune (2021)", "The Office (US) (2005)").
fn title_year_hint(title: &str) -> Option<i64> {
    let mut rest = title.trim();
    while let Some(open) = rest.rfind(" (") {
        let inner = rest[open + 2..].trim_end_matches(')').trim();
        if inner.len() == 4 && inner.chars().all(|c| c.is_ascii_digit()) {
            return inner.parse().ok().filter(|y| (1900..=2100).contains(y));
        }
        rest = &rest[..open];
    }
    None
}

/// The main title before a subtitle ("Glass Onion: A Knives Out Mystery" → "glass onion").
fn main_title(normalized_source: &str) -> Option<String> {
    let cut = normalized_source.find([':', '|']).or_else(|| normalized_source.find(" - "))?;
    let head = normalize_title(&normalized_source[..cut]);
    // Single short words ("It", "Up") are too ambiguous to match on a prefix alone.
    ((head.len() >= 4 && head.contains(' ')) || head.len() >= 6).then_some(head)
}

/// How well a TMDB candidate fits: (title match, year agreement, popularity). Compared
/// lexicographically, so an exact title always beats a subtitle match, a matching year beats a
/// different one, and only then does popularity decide ("Gladiator" 2000 over 1992 when no
/// year is known; the TV show "Friends" over an obscure film of the same name).
pub(crate) type HitRank = (i32, i32, i64);

/// Strict match of a title against TMDB search hits (ghost-history guard).
///
/// * Titles must match exactly (title or original title, normalised), or by main title before a
///   subtitle, and the latter only among the top three results. No substring matching:
///   "Friends" must never resolve to "Friends with Benefits".
/// * `year_hint` (a year written in the source title) must agree within one year.
/// * `soft_year` (a release year the provider reported) ranks closer years first.
/// * `released_by` (the earliest year the user watched it) rejects anything released later:
///   you can't have watched a 2024 remake in 2019.
fn pick_hit(
    hits: &[TmdbHit],
    wanted: &str,
    year_hint: Option<i64>,
    soft_year: Option<i64>,
    released_by: Option<i64>,
) -> Option<(HitRank, TmdbHit)> {
    let w = normalize_title(wanted);
    if w.is_empty() {
        return None;
    }
    let w_main = main_title(wanted);
    hits.iter()
        .enumerate()
        .filter_map(|(idx, h)| {
            if let (Some(by), Some(year)) = (released_by, h.year) {
                if year > by {
                    return None;
                }
            }
            let mut score = 0;
            for raw in std::iter::once(h.title.as_str()).chain(h.original_title.as_deref()) {
                let n = normalize_title(raw);
                if n.is_empty() {
                    continue;
                }
                if n == w {
                    score = score.max(100);
                } else if idx < 3 && (w_main.as_deref() == Some(n.as_str()) || main_title(raw).as_deref() == Some(w.as_str())) {
                    score = score.max(60);
                }
            }
            if score == 0 {
                return None;
            }
            let year_rank = match (year_hint.or(soft_year), h.year) {
                (Some(y), Some(hy)) if year_hint.is_some() && (y - hy).abs() > 1 => return None,
                (Some(y), Some(hy)) if y == hy => 3,
                (Some(y), Some(hy)) if (y - hy).abs() == 1 => 2,
                (Some(y), Some(hy)) => -((y - hy).abs().min(200) as i32),
                (Some(_), None) => -1,
                (None, _) => 0,
            };
            let popularity = (h.popularity.max(0.0) * 1000.0) as i64 + h.vote_count.max(0);
            Some(((score, year_rank, popularity), h.clone()))
        })
        .max_by_key(|(rank, _)| *rank)
}

/// Resolves a provider title to a TMDB id.
///
/// `is_tv` decides the endpoint: `Some(true)` searches `/search/tv` only, `Some(false)`
/// `/search/movie` only; `None` (type genuinely unknown) searches both and the strict ranking
/// decides. `release_year` (reported by the provider) is sent to TMDB as a year filter first,
/// then used to rank an unfiltered search if the filtered one has no exact match.
pub(crate) async fn resolve_title(
    db: &Database,
    tmdb: &TmdbClient,
    title: &str,
    is_tv: Option<bool>,
    released_by: Option<i64>,
    release_year: Option<i64>,
) -> AppResult<Option<Matched>> {
    let cleaned = clean_search_title(title);
    if cleaned.is_empty() {
        return Ok(None);
    }
    let year_hint = title_year_hint(title);
    let release_year = release_year.filter(|y| (1880..=2100).contains(y));
    // The local cache is only trusted when the media type is known: an exact-title row of the
    // other type ("The Mentalist" film vs series) must not short-circuit the search.
    if let Some(tv) = is_tv {
        let q = cleaned.clone();
        let tf = if tv { "tv" } else { "movie" };
        if let Some(local) = db.run(move |c| queries::find_media_by_title(c, &q, Some(tf))).await? {
            // The local cache is exact-title only; it must also satisfy the year rules. A series'
            // provider year can be its latest season, so it only bounds the premiere from above.
            let year_ok = match local.release_year {
                Some(y) => {
                    year_hint.is_none_or(|h| (h - y).abs() <= 1)
                        && released_by.is_none_or(|by| y <= by)
                        && release_year.is_none_or(|r| if tv { y <= r + 1 } else { (r - y).abs() <= 1 })
                }
                None => year_hint.is_none(),
            };
            if year_ok {
                return Ok(Some(Matched {
                    tmdb_id: local.tmdb_id,
                    media_type: local.media_type,
                    runtime_mins: local.runtime_mins,
                    catalog: None,
                }));
            }
        }
    }

    let types: &[&'static str] = match is_tv {
        Some(true) => &["tv"],
        Some(false) => &["movie"],
        None => &["tv", "movie"],
    };
    let mut best: Option<(HitRank, TmdbHit)> = None;
    for &media_type in types {
        let mut candidate = None;
        if let Some(year) = release_year.or(year_hint) {
            let hits = tmdb.search(media_type, &cleaned, Some(year)).await?;
            candidate = pick_hit(&hits, &cleaned, year_hint, release_year, released_by).filter(|(rank, _)| rank.0 == 100);
        }
        if candidate.is_none() {
            let hits = tmdb.search(media_type, &cleaned, None).await?;
            candidate = pick_hit(&hits, &cleaned, year_hint, release_year, released_by);
        }
        if let Some(candidate) = candidate {
            if best.as_ref().is_none_or(|(rank, _)| candidate.0 > *rank) {
                best = Some(candidate);
            }
        }
    }
    Ok(best.map(|(_, h)| Matched {
        tmdb_id: h.id,
        media_type: h.media_type.to_string(),
        runtime_mins: None,
        catalog: Some(MediaCatalogEntry {
            tmdb_id: h.id,
            media_type: h.media_type.to_string(),
            title: h.title,
            original_title: h.original_title,
            overview: h.overview.filter(|o| !o.is_empty()),
            poster_path: h.poster_path,
            backdrop_path: h.backdrop_path,
            release_year: h.year,
            runtime_mins: None,
            genres: Some(json!({ "ids": h.genre_ids })),
            keywords: None,
            credits: None,
            vote_average: h.vote_average,
            certification: None,
            updated_at: None,
        }),
    }))
}

/// A title playing in the player window, identified on TMDB.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentifiedTitle {
    pub tmdb_id: i64,
    pub media_type: String,
    pub title: String,
    pub original_title: Option<String>,
    pub release_year: Option<i64>,
}

/// Identifies the title the user switched to inside the OTT player. The media type is strict
/// (`/search/tv` for anything with season/episode data, `/search/movie` otherwise) and the
/// provider's release year is passed to TMDB; the matched entry is cached locally.
pub async fn identify_title(state: &AppState, title: &str, is_tv: bool, release_year: Option<i64>) -> AppResult<Option<IdentifiedTitle>> {
    let tmdb = TmdbClient::from_settings(state).await?;
    let Some(m) = resolve_title(&state.db, &tmdb, title, Some(is_tv), None, release_year).await? else {
        return Ok(None);
    };
    let (tmdb_id, mt) = (m.tmdb_id, m.media_type.clone());
    let entry = match m.catalog {
        Some(entry) => {
            let cached = entry.clone();
            state.db.run(move |c| queries::upsert_media(c, &cached)).await?;
            Some(entry)
        }
        None => state.db.run(move |c| queries::get_media(c, tmdb_id, &mt)).await?,
    };
    Ok(Some(IdentifiedTitle {
        tmdb_id: m.tmdb_id,
        media_type: m.media_type,
        title: entry.as_ref().map_or_else(|| title.trim().to_string(), |e| e.title.clone()),
        original_title: entry.as_ref().and_then(|e| e.original_title.clone()),
        release_year: entry.and_then(|e| e.release_year),
    }))
}

async fn resolve_and_store(
    app: &AppHandle,
    db: &Database,
    tmdb: &TmdbClient,
    app_profile_id: i64,
    provider_name: &str,
    ott_profile_id: Option<String>,
    raw: Vec<RawItem>,
) -> AppResult<ImportReport> {
    let fetched = raw.len();
    let mut report = ImportReport {
        app_profile_id,
        provider_name: provider_name.to_string(),
        ott_profile_id,
        fetched,
        ..Default::default()
    };
    if raw.is_empty() {
        return Ok(report);
    }

    // Validate the TMDB credential once before fanning out.
    tmdb.get("/configuration", &[]).await?;

    // 1. Unique titles -> TMDB ids (local cache first, bounded concurrency).
    let mut group_of: Vec<usize> = Vec::with_capacity(raw.len());
    // Each group also carries the earliest year it was watched: a title can't be a match if it
    // was released after that (ghost-history guard, see `pick_hit`).
    let mut groups: Vec<(String, Option<bool>, Option<i64>)> = Vec::new();
    let mut index: HashMap<(String, Option<bool>), usize> = HashMap::new();
    for item in &raw {
        let key = (normalize_title(&clean_search_title(&item.title)), item.is_tv);
        let gi = *index.entry(key).or_insert_with(|| {
            groups.push((item.title.clone(), item.is_tv, None));
            groups.len() - 1
        });
        if let Some(year) = item.watched_at.map(|d| i64::from(d.year())) {
            let earliest = &mut groups[gi].2;
            *earliest = Some(earliest.map_or(year, |e| e.min(year)));
        }
        group_of.push(gi);
    }
    groups.truncate(MAX_UNIQUE_TITLES);

    let total = groups.len();
    let sem = Arc::new(Semaphore::new(TMDB_CONCURRENCY));
    let mut set = JoinSet::new();
    for (gi, (title, is_tv, released_by)) in groups.iter().cloned().enumerate() {
        let (db, tmdb, sem) = (db.clone(), tmdb.clone(), sem.clone());
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            (gi, resolve_title(&db, &tmdb, &title, is_tv, released_by, None).await)
        });
    }
    let mut matches: Vec<Option<Matched>> = vec![None; total];
    let mut done = 0;
    while let Some(joined) = set.join_next().await {
        let (gi, result) = joined.map_err(|e| msg(e.to_string()))?;
        match result {
            Ok(m) => matches[gi] = m,
            // A rejected key aborts everything; a per-title failure just leaves it unmatched.
            Err(e) if e.to_string().contains("API key") => return Err(e),
            Err(e) => log::debug!("TMDB lookup failed: {e}"),
        }
        done += 1;
        if done % 10 == 0 || done == total {
            emit_progress(app, app_profile_id, provider_name, "matching", done, total);
        }
    }

    // 2. Episode numbers & runtimes from TMDB season data where the source only gave titles.
    let mut season_keys: HashSet<(i64, i64)> = HashSet::new();
    for (item, &gi) in raw.iter().zip(&group_of) {
        if let Some(Some(m)) = matches.get(gi) {
            if m.media_type == "tv" && item.episode.is_none() && (item.episode_title.is_some() || item.progress_ratio.is_some()) {
                season_keys.insert((m.tmdb_id, item.season.unwrap_or(1)));
            }
        }
    }
    let mut seasons: HashMap<(i64, i64), Vec<EpisodeInfo>> = HashMap::new();
    let mut set = JoinSet::new();
    for key in season_keys.into_iter().take(MAX_SEASON_LOOKUPS) {
        let (tmdb, sem) = (tmdb.clone(), sem.clone());
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            (key, tmdb.season_episodes(key.0, key.1).await)
        });
    }
    while let Some(joined) = set.join_next().await {
        if let Ok((key, Ok(eps))) = joined {
            seasons.insert(key, eps);
        }
    }

    // 2b. Episode-name fallback: when the season couldn't be parsed (or Netflix's "Part"/"Volume"
    // numbering differs from TMDB's seasons), look the episode title up across the whole series.
    let in_hinted_season = |item: &RawItem, tmdb_id: i64| -> bool {
        let Some(name) = item.episode_title.as_deref() else { return false };
        seasons
            .get(&(tmdb_id, item.season.unwrap_or(1)))
            .is_some_and(|eps| match_episode_name(eps, name, |e| e.name.as_str()).is_some())
    };
    let mut full_scan: HashSet<i64> = HashSet::new();
    for (item, &gi) in raw.iter().zip(&group_of) {
        if let Some(Some(m)) = matches.get(gi) {
            if m.media_type == "tv" && item.episode.is_none() && item.episode_title.is_some() && !in_hinted_season(item, m.tmdb_id) {
                full_scan.insert(m.tmdb_id);
            }
        }
    }
    let mut whole_series: HashMap<i64, Vec<(i64, EpisodeInfo)>> = HashMap::new();
    let mut set = JoinSet::new();
    for tv_id in full_scan.into_iter().take(MAX_FULL_SERIES_LOOKUPS) {
        let (tmdb, sem) = (tmdb.clone(), sem.clone());
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            (tv_id, tmdb.series_episodes(tv_id).await)
        });
    }
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((tv_id, Ok(eps))) => {
                whole_series.insert(tv_id, eps);
            }
            Ok((_, Err(e))) if e.to_string().contains("API key") => return Err(e),
            _ => {}
        }
    }

    // Movie runtimes for percent-only entries (Continue-Watching trays).
    let mut runtime_needed: HashSet<usize> = HashSet::new();
    for (item, &gi) in raw.iter().zip(&group_of) {
        if item.progress_ratio.is_some() && item.duration_seconds.is_none() {
            if let Some(Some(m)) = matches.get(gi) {
                if m.media_type == "movie" && m.runtime_mins.is_none() {
                    runtime_needed.insert(gi);
                }
            }
        }
    }
    let mut set = JoinSet::new();
    for gi in runtime_needed {
        let Some(Some(m)) = matches.get(gi) else { continue };
        let (tmdb, sem, id) = (tmdb.clone(), sem.clone(), m.tmdb_id);
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            (gi, tmdb.runtime_mins(id, "movie").await)
        });
    }
    while let Some(joined) = set.join_next().await {
        if let Ok((gi, Ok(Some(rt)))) = joined {
            if let Some(Some(m)) = matches.get_mut(gi) {
                m.runtime_mins = Some(rt);
                if let Some(c) = m.catalog.as_mut() {
                    c.runtime_mins = Some(rt);
                }
            }
        }
    }

    // 3. Build rows, merging repeat viewings of the same item into one row with a watch count.
    struct Agg {
        row: HistoryImport,
        days: HashSet<String>,
    }
    let mut merged: HashMap<(i64, String, i64, i64), Agg> = HashMap::new();
    let mut unmatched: Vec<String> = Vec::new();
    let mut matched_groups: HashSet<usize> = HashSet::new();
    let mut built: Vec<((i64, String, i64, i64), HistoryImport, String, bool)> = Vec::new();

    for (item, &gi) in raw.iter().zip(&group_of) {
        let Some(Some(m)) = matches.get(gi) else {
            if unmatched.len() < 50 && !unmatched.contains(&item.title) {
                unmatched.push(item.title.clone());
            }
            continue;
        };
        matched_groups.insert(gi);
        let is_tv = m.media_type == "tv";
        let mut season = if is_tv { item.season.unwrap_or(1) } else { 0 };
        let mut season_eps = seasons.get(&(m.tmdb_id, season));
        let mut ep_info = if is_tv && item.episode.is_none() {
            item.episode_title
                .as_deref()
                .and_then(|name| season_eps.and_then(|eps| match_episode_name(eps, name, |e| e.name.as_str())))
        } else {
            None
        };
        if is_tv && item.episode.is_none() && ep_info.is_none() {
            // Whole-series lookup by episode name fixes the season too.
            let found = item.episode_title.as_deref().and_then(|name| {
                let all = whole_series.get(&m.tmdb_id)?;
                match_episode_name(all, name, |(_, e)| e.name.as_str())
            });
            if let Some((s, e)) = found {
                season = *s;
                season_eps = None;
                ep_info = Some(e);
            }
        }
        let episode = if is_tv { item.episode.or(ep_info.map(|e| e.number)).unwrap_or(0) } else { 0 };
        // Known to be an episode, but no number and no TMDB episode of that name.
        let unplaced = is_tv && episode == 0 && item.episode_title.is_some();
        let runtime = ep_info
            .and_then(|e| e.runtime_mins)
            .or_else(|| season_eps.and_then(|eps| eps.iter().find(|e| e.number == episode)).and_then(|e| e.runtime_mins))
            .or(m.runtime_mins);
        let duration = item
            .duration_seconds
            .filter(|d| *d > 1.0)
            .or(runtime.map(|r| r as f64 * 60.0))
            .unwrap_or(if is_tv { 2700.0 } else { 6000.0 });
        let progress = item
            .progress_seconds
            .or(item.progress_ratio.map(|r| r * duration))
            .unwrap_or(if item.assume_completed { duration } else { 0.0 });
        let completed = queries::is_completion(progress, duration)
            || (item.assume_completed && item.progress_seconds.is_none() && item.progress_ratio.is_none());
        let watched_at = item.watched_at.map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string());
        let bucket = item
            .watched_at
            .filter(|_| item.has_time_of_day)
            .map(|d| queries::time_of_day_bucket(d.with_timezone(&Local).hour()).to_string());

        let row = HistoryImport {
            app_profile_id,
            tmdb_id: m.tmdb_id,
            media_type: m.media_type.clone(),
            season_number: season,
            episode_number: episode,
            episode_title: item.episode_title.clone(),
            provider_name: Some(provider_name.to_string()),
            direct_url: item.direct_url.clone(),
            progress_seconds: progress,
            duration_seconds: duration,
            is_completed: completed,
            watched_at: watched_at.clone(),
            time_of_day_bucket: bucket,
            watch_count: None,
        };
        let key = (m.tmdb_id, m.media_type.clone(), season, episode);
        let day = watched_at.as_deref().map(|w| w[..10.min(w.len())].to_string()).unwrap_or_default();
        built.push((key, row, day, unplaced));
    }

    // Unplaced episodes would all collapse into one "episode 0" row that can outrank the real
    // latest episode; only keep them for series where nothing else was placed.
    let placed_series: HashSet<i64> = built
        .iter()
        .filter(|(key, _, _, unplaced)| !unplaced && key.3 > 0)
        .map(|(key, ..)| key.0)
        .collect();
    let mut unplaced_dropped = 0usize;
    for (key, row, day, unplaced) in built {
        if unplaced && placed_series.contains(&key.0) {
            unplaced_dropped += 1;
            continue;
        }
        match merged.get_mut(&key) {
            Some(agg) => {
                agg.days.insert(day);
                agg.row.is_completed |= row.is_completed;
                if row.watched_at > agg.row.watched_at {
                    let completed = agg.row.is_completed;
                    agg.row = row;
                    agg.row.is_completed = completed;
                }
            }
            None => {
                merged.insert(key, Agg { row, days: HashSet::from([day]) });
            }
        }
    }
    if unplaced_dropped > 0 {
        log::info!("{unplaced_dropped} imported episodes had no matching TMDB episode name and were skipped");
    }

    let rows: Vec<HistoryImport> = merged
        .into_values()
        .map(|mut agg| {
            agg.row.watch_count = Some(agg.days.len().max(1) as i64);
            agg.row
        })
        .collect();
    let catalog: Vec<MediaCatalogEntry> = matched_groups
        .iter()
        .filter_map(|gi| matches[*gi].as_ref().and_then(|m| m.catalog.clone()))
        .collect();

    emit_progress(app, app_profile_id, provider_name, "saving", rows.len(), rows.len());
    let imported = rows.len();
    db.run(move |c| {
        queries::upsert_media_batch(c, &catalog)?;
        queries::upsert_imported_history(c, &rows)
    })
    .await?;

    app.state::<AppState>().recommender.invalidate(app_profile_id);
    report.imported = imported;
    report.matched_titles = matched_groups.len();
    report.unmatched_titles = unmatched;
    Ok(report)
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn nt(series: &str, season: Option<i64>, episode: Option<i64>, title: Option<&str>) -> NetflixTitle {
        NetflixTitle {
            series: series.into(),
            is_tv: Some(true),
            season,
            episode,
            episode_title: title.map(str::to_string),
        }
    }

    #[test]
    fn netflix_csv_titles() {
        assert_eq!(
            parse_netflix_title("Stranger Things: Season 1: Chapter One: The Vanishing of Will Byers"),
            nt("Stranger Things", Some(1), None, Some("Chapter One: The Vanishing of Will Byers"))
        );
        assert_eq!(parse_netflix_title("The Queen's Gambit: Limited Series: Openings"), nt("The Queen's Gambit", Some(1), None, Some("Openings")));
        assert_eq!(parse_netflix_title("Spider-Man: No Way Home"), NetflixTitle { series: "Spider-Man: No Way Home".into(), ..Default::default() });
    }

    #[test]
    fn csv_rows_are_typed_strictly() {
        let csv = "Title,Date\n\"Friends: Season 2: The One with the Breast Milk\",11/12/26\nFriends,11/01/26\nGladiator,10/01/26\n\"The Mentalist: Season 1: Pilot\",09/01/26\n";
        let items = parse_viewing_activity_csv(csv).unwrap();
        assert_eq!(items.len(), 4);
        assert_eq!((items[0].title.as_str(), items[0].is_tv), ("Friends", Some(true)));
        assert_eq!(items[1].is_tv, Some(true), "a bare series title seen with episodes stays TV");
        assert_eq!(items[2].is_tv, Some(false), "a bare title is a movie");
        assert_eq!((items[3].title.as_str(), items[3].is_tv), ("The Mentalist", Some(true)));
    }

    #[test]
    fn netflix_watch_urls_open_the_episode() {
        assert_eq!(netflix_watch_url(Some("70274078")).as_deref(), Some("https://www.netflix.com/watch/70274078"));
        assert_eq!(netflix_watch_url(Some("../evil")), None);
        assert_eq!(netflix_watch_url(None), None);
    }

    #[test]
    fn netflix_title_variants() {
        let friends = Some("The One with Ross's New Girlfriend");
        assert_eq!(parse_netflix_title("Friends: Season 2: The One with Ross's New Girlfriend"), nt("Friends", Some(2), None, friends));
        assert_eq!(parse_netflix_title("Sherlock: Series 3: The Empty Hearse"), nt("Sherlock", Some(3), None, Some("The Empty Hearse")));
        assert_eq!(parse_netflix_title("Money Heist: Part 3: Episode 1"), nt("Money Heist", Some(3), Some(1), None));
        assert_eq!(parse_netflix_title("Love, Death & Robots: Volume 2: Snow in the Desert"), nt("Love, Death & Robots", Some(2), None, Some("Snow in the Desert")));
        assert_eq!(parse_netflix_title("Avatar: The Last Airbender: Book Two: The Avatar State"), nt("Avatar: The Last Airbender", Some(2), None, Some("The Avatar State")));
        assert_eq!(parse_netflix_title("Narcos: Season II: Free at Last"), nt("Narcos", Some(2), None, Some("Free at Last")));
        assert_eq!(parse_netflix_title("Friends: S2:E2: The One with the Breast Milk"), nt("Friends", Some(2), Some(2), Some("The One with the Breast Milk")));
        assert_eq!(parse_netflix_title("Friends: S02E02"), nt("Friends", Some(2), Some(2), None));
        assert_eq!(parse_netflix_title("Dark: Season 1 Episode 4: Double Lives"), nt("Dark", Some(1), Some(4), Some("Double Lives")));
        assert_eq!(parse_netflix_title("Dark: Season 1: Episode 4: Double Lives"), nt("Dark", Some(1), Some(4), Some("Double Lives")));
        assert_eq!(parse_netflix_title("Dark - Season 2: Lost and Found"), nt("Dark", Some(2), None, Some("Lost and Found")));
        assert_eq!(parse_netflix_title("Wednesday: Episode 3: Friend or Woe"), nt("Wednesday", None, Some(3), Some("Friend or Woe")));
        // Movie sequels with a trailing "Part"/"Volume" stay movies.
        for movie in ["Harry Potter and the Deathly Hallows: Part 1", "Kill Bill: Volume 1", "Mission: Impossible - Dead Reckoning Part One"] {
            assert_eq!(parse_netflix_title(movie).is_tv, None, "{movie}");
        }
    }

    #[test]
    fn episode_names_match_exactly_then_uniquely() {
        let eps: Vec<(i64, String)> = [(1, "The One Where Monica Gets a Roommate"), (2, "The One with the Sonogram at the End"), (3, "The One with the Thumb")]
            .into_iter()
            .map(|(n, t)| (n, t.to_string()))
            .collect();
        fn name(e: &(i64, String)) -> &str {
            &e.1
        }
        assert_eq!(match_episode_name(&eps, "the one with the thumb", name).map(|e| e.0), Some(3));
        assert_eq!(match_episode_name(&eps, "The One with the Sonogram", name).map(|e| e.0), Some(2));
        // Ambiguous containment ("The One") and short names don't match.
        assert_eq!(match_episode_name(&eps, "The One", name), None);
        assert_eq!(match_episode_name(&eps, "Pilot", name), None);
    }

    #[test]
    fn csv_parser_handles_quotes() {
        let rows = parse_csv("\u{feff}Title,Date\r\n\"Dark: Season 1: Secrets, Lies\",\"1/10/25\"\n\nRRR (Hindi),2024-03-02\n");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1][0], "Dark: Season 1: Secrets, Lies");
        let items = parse_viewing_activity_csv("Title,Date\n\"Dark: Season 1: Secrets, Lies\",1/10/25\n").unwrap();
        assert_eq!(items[0].title, "Dark");
        assert_eq!(items[0].watched_at.unwrap().format("%Y-%m-%d").to_string(), "2025-01-10");
        assert!(items[0].assume_completed);
    }

    #[test]
    fn netflix_identity_matching() {
        assert!(netflix_identity_matches("G1::Clara", "G1", Some("Clara")));
        assert!(!netflix_identity_matches("G1::Clara", "G1", Some("Aryan")), "same account guid, other profile");
        assert!(!netflix_identity_matches("G1::Clara", "G2", Some("Clara")));
        assert!(netflix_identity_matches("G1", "G1", Some("Anyone")), "legacy bare-guid links");
    }

    #[test]
    fn netflix_scraped_rows_are_split_into_series_and_season() {
        let rows = scraped_to_raw(
            vec![ScrapedItem {
                title: "Friends: Season 2: The One with Ross's New Girlfriend".into(),
                season_number: None,
                episode_number: None,
                episode_title: None,
                season_label: None,
                ott_video_id: Some("70274077".into()),
                is_tv: false,
                progress_ratio: None,
                progress_seconds: Some(600.0),
                duration_seconds: Some(1320.0),
                watched_at: Some("2026-11-11T21:00:00Z".into()),
            }],
            true,
            true,
        );
        assert_eq!(rows[0].title, "Friends");
        assert_eq!(rows[0].season, Some(2));
        assert_eq!(rows[0].episode_title.as_deref(), Some("The One with Ross's New Girlfriend"));
        assert_eq!(rows[0].progress_seconds, Some(600.0));
        assert_eq!(rows[0].direct_url.as_deref(), Some("https://www.netflix.com/watch/70274077"));
        assert!(!rows[0].assume_completed);
    }

    #[test]
    fn scrape_isolation_rules() {
        assert!(verify_scraped_profile("A", Some("A"), 3).is_ok());
        assert!(verify_scraped_profile("A", Some("B"), 1).is_err());
        assert!(verify_scraped_profile("A", None, 1).is_ok());
        assert!(verify_scraped_profile("A", None, 2).is_err());
    }

    #[test]
    fn search_title_cleanup_and_matching() {
        assert_eq!(clean_search_title("RRR (Hindi)"), "RRR");
        assert_eq!(clean_search_title("Dark - Season 1"), "Dark");
        let hit = |id, title: &str| TmdbHit {
            id,
            media_type: "movie",
            title: title.into(),
            original_title: None,
            year: None,
            poster_path: None,
            backdrop_path: None,
            overview: None,
            vote_average: None,
            genre_ids: Value::Null,
            popularity: 0.0,
            vote_count: 0,
        };
        let hits = vec![hit(1, "The Matrix Reloaded"), hit(2, "The Matrix")];
        assert_eq!(pick_hit(&hits, "The Matrix", None, None, None).unwrap().1.id, 2);
        assert!(pick_hit(&[hit(3, "Something Else")], "The Matrix", None, None, None).is_none());

        // Ghost-history guards.
        let dated = |id, title: &str, year| TmdbHit { year: Some(year), ..hit(id, title) };
        // No substring matches, even on the top result.
        assert!(pick_hit(&[dated(10, "Friends with Benefits", 2011)], "Friends", None, None, None).is_none());
        // Subtitle-tolerant main-title match, top results only.
        let onion = [dated(11, "Glass Onion: A Knives Out Mystery", 2022)];
        assert_eq!(pick_hit(&onion, "Glass Onion", None, None, None).unwrap().1.id, 11);
        let buried = [dated(1, "A", 2000), dated(2, "B", 2000), dated(3, "C", 2000), dated(12, "Glass Onion: A Knives Out Mystery", 2022)];
        assert!(pick_hit(&buried, "Glass Onion", None, None, None).is_none());
        // Released after it was watched => not the title the user saw (remakes, reboots).
        let remakes = [dated(20, "The Office", 2025), dated(21, "The Office", 2005)];
        assert_eq!(pick_hit(&remakes, "The Office", None, None, Some(2019)).unwrap().1.id, 21);
        assert!(pick_hit(&[dated(22, "Dune", 2021)], "Dune", None, None, Some(2019)).is_none());
        // A year in the source title is strict (±1).
        let dunes = [dated(30, "Dune", 2021), dated(31, "Dune", 1984)];
        assert_eq!(pick_hit(&dunes, "Dune", Some(1984), None, None).unwrap().1.id, 31);
        assert!(pick_hit(&[dated(30, "Dune", 2021)], "Dune", Some(1984), None, None).is_none());
        // Same name, different titles: the reported year decides, then popularity.
        let popular = |id, title: &str, year, popularity: f64| TmdbHit { popularity, vote_count: (popularity * 100.0) as i64, ..dated(id, title, year) };
        let gladiators = [popular(40, "Gladiator", 1992, 4.0), popular(41, "Gladiator", 2000, 90.0)];
        assert_eq!(pick_hit(&gladiators, "Gladiator", None, Some(1992), None).unwrap().1.id, 40);
        assert_eq!(pick_hit(&gladiators, "Gladiator", None, Some(2000), None).unwrap().1.id, 41);
        assert_eq!(pick_hit(&gladiators, "Gladiator", None, None, None).unwrap().1.id, 41, "unknown year: the popular one");
        let crashes = [popular(50, "Crash", 2004, 30.0), popular(51, "Crash", 1996, 20.0)];
        assert_eq!(pick_hit(&crashes, "Crash", None, Some(1996), None).unwrap().1.id, 51);
        // An obscure exact-title film never outranks the popular series of the same name.
        let film = popular(60, "The Mentalist", 2012, 0.6);
        let series = TmdbHit { media_type: "tv", ..popular(61, "The Mentalist", 2008, 120.0) };
        assert!(pick_hit(&[series], "The Mentalist", None, None, None).unwrap().0 > pick_hit(&[film], "The Mentalist", None, None, None).unwrap().0);
        // An exact title beats a more popular subtitle match.
        let mixed = [popular(70, "Friends: The Reunion", 2021, 300.0), popular(71, "Friends", 1994, 200.0)];
        assert_eq!(pick_hit(&mixed, "Friends", None, None, None).unwrap().1.id, 71);
        assert_eq!(title_year_hint("Dune (1984)"), Some(1984));
        assert_eq!(title_year_hint("The Office (US) (2005)"), Some(2005));
        assert_eq!(title_year_hint("RRR (Hindi)"), None);
    }

    #[test]
    fn omnia_json_rows_are_forced_into_target_profile() {
        let rows = parse_omnia_json(
            r#"[{"appProfileId":99,"tmdbId":603,"mediaType":"movie","progressSeconds":10,"durationSeconds":8160,"lastWatchedAt":"2025-01-01 10:00:00"}]"#,
            1,
        )
        .unwrap();
        assert_eq!(rows[0].app_profile_id, 1);
    }
}
