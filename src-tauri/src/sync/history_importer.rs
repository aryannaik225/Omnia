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
/// The Netflix fallback may page through years of activity inside the page.
const NETFLIX_SCRAPE_TIMEOUT: Duration = Duration::from_secs(150);
const TMDB_CONCURRENCY: usize = 4;
const MAX_UNIQUE_TITLES: usize = 1500;
const MAX_SEASON_LOOKUPS: usize = 400;
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

fn first_number(s: &str) -> Option<i64> {
    let digits: String = s
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
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
    state.importer.pending().insert(label.clone(), PendingScrape { token: token.clone(), tx });

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
        "scrapeTimeoutMs": timeout.saturating_sub(Duration::from_secs(10)).as_millis() as u64,
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
            let title = if netflix && season.is_none() && episode_title.is_none() {
                let (series, tv, s, ep) = parse_netflix_title(&title);
                is_tv = is_tv.or(tv);
                season = s;
                episode_title = ep;
                series
            } else {
                title
            };
            RawItem {
                title,
                is_tv,
                season,
                episode: i.episode_number,
                episode_title,
                watched_at: i.watched_at.as_deref().and_then(parse_loose_date),
                has_time_of_day: false,
                progress_seconds: if has_seconds { i.progress_seconds } else { None },
                duration_seconds: if has_seconds { i.duration_seconds } else { None },
                progress_ratio: ratio,
                assume_completed: history_page && ratio.is_none() && !has_seconds,
            }
        })
        .collect()
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

/// Splits Netflix's "Series: Season 1: Episode Title" naming.
fn parse_netflix_title(full: &str) -> (String, Option<bool>, Option<i64>, Option<String>) {
    let parts: Vec<&str> = full.split(": ").collect();
    for i in 1..parts.len() {
        let p = parts[i].trim();
        let lower = p.to_lowercase();
        let numbered = ["season", "series", "part", "volume", "book", "collection", "chapter"]
            .iter()
            .any(|w| lower.starts_with(w))
            && first_number(&lower).is_some()
            && p.split_whitespace().count() <= 3;
        if numbered || lower == "limited series" || lower == "miniseries" {
            let episode_title = parts[i + 1..].join(": ");
            return (
                parts[..i].join(": ").trim().to_string(),
                Some(true),
                Some(first_number(&lower).unwrap_or(1)),
                Some(episode_title).filter(|t| !t.trim().is_empty()),
            );
        }
    }
    (full.trim().to_string(), None, None, None)
}

fn parse_viewing_activity_csv(text: &str) -> AppResult<Vec<RawItem>> {
    let rows = parse_csv(text);
    let header = rows.first().ok_or_else(|| msg("The CSV file is empty."))?;
    let find = |name: &str| header.iter().position(|h| h.trim().eq_ignore_ascii_case(name));
    let title_col = find("Title").ok_or_else(|| msg("CSV needs a 'Title' column (Netflix viewing activity format)."))?;
    let date_col = find("Date");
    Ok(rows
        .iter()
        .skip(1)
        .filter_map(|r| {
            let full = r.get(title_col)?.trim();
            if full.is_empty() {
                return None;
            }
            let (title, is_tv, season, episode_title) = parse_netflix_title(full);
            Some(RawItem {
                title,
                is_tv,
                season,
                episode: None,
                episode_title,
                watched_at: date_col.and_then(|c| r.get(c)).and_then(|d| parse_loose_date(d)),
                has_time_of_day: false,
                assume_completed: true,
                ..Default::default()
            })
        })
        .collect())
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
}

#[derive(Debug, Clone)]
struct Matched {
    tmdb_id: i64,
    media_type: String,
    runtime_mins: Option<i64>,
    catalog: Option<MediaCatalogEntry>,
}

#[derive(Debug, Clone)]
struct EpisodeInfo {
    number: i64,
    name: String,
    runtime_mins: Option<i64>,
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

    async fn search(&self, media_type: &'static str, query: &str) -> AppResult<Vec<TmdbHit>> {
        let body = self
            .get(
                &format!("/search/{media_type}"),
                &[("query", query.to_string()), ("include_adult", "false".into()), ("page", "1".into())],
            )
            .await?;
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
                })
            })
            .collect())
    }

    async fn season_episodes(&self, tv_id: i64, season: i64) -> AppResult<Vec<EpisodeInfo>> {
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

/// Strict match of a history title against TMDB search hits (ghost-history guard).
///
/// * Titles must match exactly (title or original title, normalised), or by main title before a
///   subtitle — and the latter only among the top three results. No substring matching:
///   "Friends" must never resolve to "Friends with Benefits".
/// * `year_hint` (a year in the source title) must agree within ±1 year.
/// * `released_by` (the earliest year the user watched it) rejects anything released later —
///   you can't have watched a 2024 remake in 2019.
fn pick_hit(hits: &[TmdbHit], wanted: &str, year_hint: Option<i64>, released_by: Option<i64>) -> Option<(i32, TmdbHit)> {
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
            match (year_hint, h.year) {
                (Some(y), Some(hy)) if (y - hy).abs() > 1 => return None,
                (Some(y), Some(hy)) => score += if y == hy { 20 } else { 10 },
                (Some(_), None) => score -= 15,
                _ => {}
            }
            Some((score - idx as i32, h.clone()))
        })
        .max_by_key(|(score, _)| *score)
}

async fn resolve_title(
    db: &Database,
    tmdb: &TmdbClient,
    title: &str,
    is_tv: Option<bool>,
    released_by: Option<i64>,
) -> AppResult<Option<Matched>> {
    let cleaned = clean_search_title(title);
    if cleaned.is_empty() {
        return Ok(None);
    }
    let year_hint = title_year_hint(title);
    let type_filter = is_tv.map(|t| if t { "tv".to_string() } else { "movie".to_string() });
    let (q, tf) = (cleaned.clone(), type_filter.clone());
    if let Some(local) = db.run(move |c| queries::find_media_by_title(c, &q, tf.as_deref())).await? {
        // The local cache is exact-title only; it must also satisfy the year rules.
        let year_ok = match local.release_year {
            Some(y) => year_hint.is_none_or(|h| (h - y).abs() <= 1) && released_by.is_none_or(|by| y <= by),
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

    let types: &[&'static str] = match is_tv {
        Some(true) => &["tv"],
        Some(false) => &["movie"],
        None => &["movie", "tv"],
    };
    let mut best: Option<(i32, TmdbHit)> = None;
    for &media_type in types {
        let hits = tmdb.search(media_type, &cleaned).await?;
        if let Some(candidate) = pick_hit(&hits, &cleaned, year_hint, released_by) {
            if best.as_ref().is_none_or(|(s, _)| candidate.0 > *s) {
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
            (gi, resolve_title(&db, &tmdb, &title, is_tv, released_by).await)
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

    for (item, &gi) in raw.iter().zip(&group_of) {
        let Some(Some(m)) = matches.get(gi) else {
            if unmatched.len() < 50 && !unmatched.contains(&item.title) {
                unmatched.push(item.title.clone());
            }
            continue;
        };
        matched_groups.insert(gi);
        let is_tv = m.media_type == "tv";
        let season = if is_tv { item.season.unwrap_or(1) } else { 0 };
        let season_eps = seasons.get(&(m.tmdb_id, season));
        let by_title = || {
            let wanted = normalize_title(item.episode_title.as_deref()?);
            season_eps?.iter().find(|e| normalize_title(&e.name) == wanted)
        };
        let ep_info = by_title();
        let episode = if is_tv { item.episode.or(ep_info.map(|e| e.number)).unwrap_or(0) } else { 0 };
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
            direct_url: None,
            progress_seconds: progress,
            duration_seconds: duration,
            is_completed: completed,
            watched_at: watched_at.clone(),
            time_of_day_bucket: bucket,
            watch_count: None,
        };
        let key = (m.tmdb_id, m.media_type.clone(), season, episode);
        let day = watched_at.as_deref().map(|w| w[..10.min(w.len())].to_string()).unwrap_or_default();
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

    #[test]
    fn netflix_csv_titles() {
        assert_eq!(
            parse_netflix_title("Stranger Things: Season 1: Chapter One: The Vanishing of Will Byers"),
            ("Stranger Things".into(), Some(true), Some(1), Some("Chapter One: The Vanishing of Will Byers".into()))
        );
        assert_eq!(
            parse_netflix_title("The Queen's Gambit: Limited Series: Openings"),
            ("The Queen's Gambit".into(), Some(true), Some(1), Some("Openings".into()))
        );
        assert_eq!(parse_netflix_title("Spider-Man: No Way Home"), ("Spider-Man: No Way Home".into(), None, None, None));
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
        };
        let hits = vec![hit(1, "The Matrix Reloaded"), hit(2, "The Matrix")];
        assert_eq!(pick_hit(&hits, "The Matrix", None, None).unwrap().1.id, 2);
        assert!(pick_hit(&[hit(3, "Something Else")], "The Matrix", None, None).is_none());

        // Ghost-history guards.
        let dated = |id, title: &str, year| TmdbHit { year: Some(year), ..hit(id, title) };
        // No substring matches, even on the top result.
        assert!(pick_hit(&[dated(10, "Friends with Benefits", 2011)], "Friends", None, None).is_none());
        // Subtitle-tolerant main-title match, top results only.
        let onion = [dated(11, "Glass Onion: A Knives Out Mystery", 2022)];
        assert_eq!(pick_hit(&onion, "Glass Onion", None, None).unwrap().1.id, 11);
        let buried = [dated(1, "A", 2000), dated(2, "B", 2000), dated(3, "C", 2000), dated(12, "Glass Onion: A Knives Out Mystery", 2022)];
        assert!(pick_hit(&buried, "Glass Onion", None, None).is_none());
        // Released after it was watched => not the title the user saw (remakes, reboots).
        let remakes = [dated(20, "The Office", 2025), dated(21, "The Office", 2005)];
        assert_eq!(pick_hit(&remakes, "The Office", None, Some(2019)).unwrap().1.id, 21);
        assert!(pick_hit(&[dated(22, "Dune", 2021)], "Dune", None, Some(2019)).is_none());
        // A year in the source title is strict (±1).
        let dunes = [dated(30, "Dune", 2021), dated(31, "Dune", 1984)];
        assert_eq!(pick_hit(&dunes, "Dune", Some(1984), None).unwrap().1.id, 31);
        assert!(pick_hit(&[dated(30, "Dune", 2021)], "Dune", Some(1984), None).is_none());
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
