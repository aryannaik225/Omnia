//! Zero-friction past watch-history importer.
//!
//! Sources:
//!   * **Netflix** — reads the WebView2 cookie store locally, copies the session into a private
//!     in-memory `reqwest` cookie jar, switches *that jar* to the mapped Netflix profile and pulls
//!     the Shakti `viewingactivity` feed. The active profile is verified before anything is read.
//!   * **Prime Video / Hotstar / Zee5 / SonyLIV / Disney+ / ...** — a hidden WebView2 window
//!     renders the provider's watch-history or Continue-Watching page and the injected script
//!     scrapes it (see `telemetry_injector.js`, import mode).
//!   * **Manual files** — Netflix "Download viewing activity" CSV, or an Omnia JSON export.
//!
//! Profile isolation: imports run *for an `ott_profile_mappings` row*. Without a mapping there is
//! no import; when the provider session's active profile can't be verified as the mapped one,
//! the import is aborted instead of risking another family member's history.
//!
//! Privacy: cookies are only held in memory for the duration of the request, sent only to the
//! provider's own origin, and never logged. Title matching goes to TMDB (title strings only, no
//! identifiers), after first trying the local catalog cache.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::{oneshot, Semaphore};
use tokio::task::JoinSet;

use crate::db::queries::{self, HistoryImport, MediaCatalogEntry, OttProfileMapping};
use crate::db::Database;
use crate::player::window_manager::{self as wm, DetectedOttProfile, OttProvider};
use crate::resolver::justwatch::normalize_title;
use crate::{AppError, AppResult, AppState};

pub const EVT_IMPORT_PROGRESS: &str = "omnia://history-import-progress";
pub const EVT_IMPORT_FINISHED: &str = "omnia://history-import-finished";

const IMPORTER_LABEL_PREFIX: &str = "importer-";
const SCRAPE_TIMEOUT: Duration = Duration::from_secs(50);
const TMDB_CONCURRENCY: usize = 4;
const MAX_UNIQUE_TITLES: usize = 1500;
const MAX_SEASON_LOOKUPS: usize = 400;
const NETFLIX_MAX_PAGES: usize = 60;
const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;
/// Netflix serves its full web app (and the Shakti API) to evergreen Chromium; WebView2 is Edge.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

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
        OttProvider::Netflix => fetch_netflix_history(app, &mapping, provider_name).await?,
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
// Netflix (cookie-authenticated Shakti API)
// ---------------------------------------------------------------------------------------------

/// Cookie fields copied out of WebView2. Deliberately no `Debug` impl: values must never be logged.
struct CookieParts {
    name: String,
    value: String,
    domain: Option<String>,
    path: Option<String>,
    secure: bool,
}

/// Reads cookies for `url` from the shared WebView2 cookie store. Runs on a blocking thread:
/// WebView2's cookie manager deadlocks if awaited on the main thread.
async fn read_cookies(app: &AppHandle, url: &str) -> AppResult<Vec<CookieParts>> {
    let window = app
        .get_webview_window(wm::MAIN_LABEL)
        .ok_or_else(|| msg("main window unavailable"))?;
    let url = tauri::Url::parse(url).map_err(|e| msg(e.to_string()))?;
    let cookies = tauri::async_runtime::spawn_blocking(move || window.cookies_for_url(url)).await??;
    Ok(cookies
        .into_iter()
        .map(|c| CookieParts {
            name: c.name().to_string(),
            value: c.value().to_string(),
            domain: c.domain().map(str::to_string),
            path: c.path().map(str::to_string),
            secure: c.secure().unwrap_or(false),
        })
        .collect())
}

/// A one-off HTTPS client whose cookie jar exists only in memory for this import.
fn cookie_client(origin: &str, cookies: &[CookieParts]) -> AppResult<reqwest::Client> {
    let base = reqwest::Url::parse(origin).map_err(|e| msg(e.to_string()))?;
    let host = base.host_str().unwrap_or_default().to_string();
    let jar = Arc::new(reqwest::cookie::Jar::default());
    for c in cookies {
        let domain = c.domain.clone().unwrap_or_else(|| host.clone());
        let mut line = format!("{}={}; Domain={}; Path={}", c.name, c.value, domain, c.path.as_deref().unwrap_or("/"));
        if c.secure {
            line.push_str("; Secure");
        }
        jar.add_cookie_str(&line, &base);
    }
    Ok(reqwest::Client::builder()
        .cookie_provider(jar)
        .user_agent(BROWSER_UA)
        .https_only(true)
        .gzip(true)
        .brotli(true)
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .build()?)
}

#[derive(Debug, Default, PartialEq)]
struct NetflixContext {
    build_identifier: Option<String>,
    profile_guid: Option<String>,
    profile_name: Option<String>,
}

fn char_floor(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// Decodes JS string escapes used in Netflix's inline `reactContext` (`\x20`, `é`, `\"`...).
fn unescape_js(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let hex = |slice: &[char]| -> Option<u32> { u32::from_str_radix(&slice.iter().collect::<String>(), 16).ok() };
    while i < chars.len() {
        let c = chars[i];
        if c != '\\' || i + 1 >= chars.len() {
            out.push(c);
            i += 1;
            continue;
        }
        let next = chars[i + 1];
        match next {
            'x' if i + 4 <= chars.len() => {
                match hex(&chars[i + 2..i + 4]).and_then(char::from_u32) {
                    Some(ch) => out.push(ch),
                    None => out.extend(&chars[i..i + 4]),
                }
                i += 4;
            }
            'u' if i + 6 <= chars.len() => {
                let code = hex(&chars[i + 2..i + 6]).unwrap_or(0xFFFD);
                if (0xD800..0xDC00).contains(&code)
                    && i + 12 <= chars.len()
                    && chars[i + 6] == '\\'
                    && chars[i + 7] == 'u'
                {
                    let low = hex(&chars[i + 8..i + 12]).unwrap_or(0);
                    let combined = 0x10000 + ((code - 0xD800) << 10) + (low.wrapping_sub(0xDC00) & 0x3FF);
                    out.push(char::from_u32(combined).unwrap_or('\u{FFFD}'));
                    i += 12;
                } else {
                    out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                    i += 6;
                }
            }
            'n' => {
                out.push('\n');
                i += 2;
            }
            't' => {
                out.push('\t');
                i += 2;
            }
            'r' => {
                i += 2;
            }
            other => {
                out.push(other);
                i += 2;
            }
        }
    }
    out
}

/// Finds `"key":"value"` in inline script text and returns the unescaped value.
fn find_js_string(hay: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let start = hay.find(&needle)? + needle.len();
    let bytes = hay.as_bytes();
    let mut i = start;
    let mut escaped = false;
    while i < bytes.len() {
        let b = bytes[i];
        if escaped {
            escaped = false;
        } else if b == b'\\' {
            escaped = true;
        } else if b == b'"' {
            return Some(unescape_js(&hay[start..i]));
        }
        i += 1;
    }
    None
}

fn parse_netflix_context(html: &str) -> Option<NetflixContext> {
    let build_identifier = find_js_string(html, "BUILD_IDENTIFIER");
    let (profile_guid, profile_name) = match html.find("\"userInfo\"") {
        Some(i) => {
            let window = &html[i..char_floor(html, i + 6000)];
            (find_js_string(window, "guid"), find_js_string(window, "name"))
        }
        None => (None, None),
    };
    if build_identifier.is_none() && profile_guid.is_none() {
        return None;
    }
    Some(NetflixContext { build_identifier, profile_guid, profile_name })
}

fn first_number(s: &str) -> Option<i64> {
    let digits: String = s
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn netflix_item(v: &Value) -> Option<RawItem> {
    let series_title = v["seriesTitle"].as_str().filter(|s| !s.trim().is_empty());
    let is_tv = series_title.is_some() || !v["series"].is_null();
    let title = if is_tv { series_title.or_else(|| v["title"].as_str()) } else { v["title"].as_str() }?;
    let watched_at = v["date"]
        .as_i64()
        .and_then(|ms| Utc.timestamp_millis_opt(ms).single());
    Some(RawItem {
        title: title.trim().to_string(),
        is_tv: Some(is_tv),
        season: if is_tv {
            Some(v["seasonDescriptor"].as_str().and_then(first_number).unwrap_or(1))
        } else {
            None
        },
        episode: None,
        episode_title: v["episodeTitle"].as_str().map(str::to_string).filter(|s| !s.is_empty()),
        watched_at,
        has_time_of_day: true,
        progress_seconds: v["bookmark"].as_f64(),
        duration_seconds: v["duration"].as_f64(),
        progress_ratio: None,
        assume_completed: false,
    })
}

async fn fetch_netflix_history(app: &AppHandle, mapping: &OttProfileMapping, provider_name: &str) -> AppResult<Vec<RawItem>> {
    let cookies = read_cookies(app, "https://www.netflix.com/").await?;
    if !cookies.iter().any(|c| c.name == "NetflixId" || c.name == "SecureNetflixId") {
        return Err(msg("You're not signed in to Netflix inside Omnia. Use Connect Accounts to sign in first."));
    }
    let client = cookie_client("https://www.netflix.com/", &cookies)?;
    drop(cookies);

    // Point this private session at the mapped profile. The WebView2 session is untouched.
    let switch_url = format!(
        "https://www.netflix.com/SwitchProfile?tkn={}",
        url::form_urlencoded::byte_serialize(mapping.ott_native_profile_id.as_bytes()).collect::<String>()
    );
    let _ = client.get(switch_url).send().await;

    let html = client.get("https://www.netflix.com/viewingactivity").send().await?.text().await?;
    let ctx = parse_netflix_context(&html)
        .ok_or_else(|| msg("Couldn't read your Netflix session. Sign in again via Connect Accounts."))?;
    match ctx.profile_guid.as_deref() {
        Some(guid) if guid == mapping.ott_native_profile_id => {}
        Some(_) => {
            return Err(msg(format!(
                "Netflix didn't switch to the linked profile{}; import aborted to keep profiles separate.",
                ctx.profile_name.map(|n| format!(" (active: {n})")).unwrap_or_default()
            )))
        }
        None => return Err(msg("Couldn't verify the active Netflix profile; import aborted to keep profiles separate.")),
    }
    let build = ctx
        .build_identifier
        .ok_or_else(|| msg("Netflix page format changed (no build identifier)."))?;

    let mut items = Vec::new();
    for page in 0..NETFLIX_MAX_PAGES {
        let url = format!("https://www.netflix.com/api/shakti/{build}/viewingactivity?pg={page}&pgSize=100");
        let resp = client.get(&url).header(reqwest::header::ACCEPT, "application/json").send().await?;
        if !resp.status().is_success() {
            if page == 0 {
                return Err(msg(format!("Netflix viewing activity request failed (HTTP {}).", resp.status())));
            }
            break;
        }
        let body: Value = resp.json().await?;
        let viewed = body["viewedItems"].as_array().cloned().unwrap_or_default();
        if viewed.is_empty() {
            break;
        }
        items.extend(viewed.iter().filter_map(netflix_item));
        let total = body["vhSize"].as_u64().unwrap_or(0) as usize;
        emit_progress(app, mapping.app_profile_id, provider_name, "fetching", items.len(), total);
        if total > 0 && (page + 1) * 100 >= total {
            break;
        }
    }
    Ok(items)
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

async fn scrape_with_hidden_window(
    app: &AppHandle,
    provider: OttProvider,
    provider_name: &str,
    url: &str,
    scraper: &str,
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
        "scrapeTimeoutMs": 30000,
    });
    let window = match wm::build_ott_window(app, &label, parsed, "Omnia — importing history", wm::build_injection(&config), false) {
        Ok(w) => w,
        Err(e) => {
            state.importer.pending().remove(&label);
            return Err(e);
        }
    };
    let outcome = tokio::time::timeout(SCRAPE_TIMEOUT, rx).await;
    state.importer.pending().remove(&label);
    let _ = window.destroy();
    match outcome {
        Ok(Ok(payload)) => Ok(payload),
        Ok(Err(_)) => Err(msg("The history window closed before finishing.")),
        Err(_) => Err(msg(format!("Timed out reading {provider_name} history. Are you signed in?"))),
    }
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
    let payload = scrape_with_hidden_window(app, provider, provider_name, &url, scraper).await?;

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
    Ok(payload
        .items
        .into_iter()
        .filter(|i| !i.title.trim().is_empty())
        .map(|i| {
            let ratio = i.progress_ratio.filter(|r| r.is_finite()).map(|r| r.clamp(0.0, 1.0));
            RawItem {
                title: i.title.trim().to_string(),
                is_tv: if i.is_tv || i.episode_number.is_some() { Some(true) } else { None },
                season: i.season_number,
                episode: i.episode_number,
                episode_title: i.episode_title,
                watched_at: i.watched_at.as_deref().and_then(parse_loose_date),
                has_time_of_day: false,
                progress_seconds: None,
                duration_seconds: None,
                progress_ratio: ratio,
                assume_completed: history_page && ratio.is_none(),
            }
        })
        .collect())
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

fn pick_hit(hits: &[TmdbHit], wanted: &str) -> Option<(i32, TmdbHit)> {
    let w = normalize_title(wanted);
    if w.is_empty() {
        return None;
    }
    hits.iter()
        .enumerate()
        .filter_map(|(idx, h)| {
            let names = std::iter::once(h.title.as_str()).chain(h.original_title.as_deref());
            let mut best = 0;
            for n in names {
                let n = normalize_title(n);
                if n == w {
                    best = best.max(100);
                } else if idx == 0 && !n.is_empty() && (n.contains(&w) || w.contains(&n)) {
                    best = best.max(50);
                }
            }
            (best > 0).then(|| (best - idx as i32, h.clone()))
        })
        .max_by_key(|(score, _)| *score)
}

async fn resolve_title(db: &Database, tmdb: &TmdbClient, title: &str, is_tv: Option<bool>) -> AppResult<Option<Matched>> {
    let cleaned = clean_search_title(title);
    if cleaned.is_empty() {
        return Ok(None);
    }
    let type_filter = is_tv.map(|t| if t { "tv".to_string() } else { "movie".to_string() });
    let (q, tf) = (cleaned.clone(), type_filter.clone());
    if let Some(local) = db.run(move |c| queries::find_media_by_title(c, &q, tf.as_deref())).await? {
        return Ok(Some(Matched {
            tmdb_id: local.tmdb_id,
            media_type: local.media_type,
            runtime_mins: local.runtime_mins,
            catalog: None,
        }));
    }

    let types: &[&'static str] = match is_tv {
        Some(true) => &["tv"],
        Some(false) => &["movie"],
        None => &["movie", "tv"],
    };
    let mut best: Option<(i32, TmdbHit)> = None;
    for &media_type in types {
        let hits = tmdb.search(media_type, &cleaned).await?;
        if let Some(candidate) = pick_hit(&hits, &cleaned) {
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
    let mut groups: Vec<(String, Option<bool>)> = Vec::new();
    let mut index: HashMap<(String, Option<bool>), usize> = HashMap::new();
    for item in &raw {
        let key = (normalize_title(&clean_search_title(&item.title)), item.is_tv);
        let gi = *index.entry(key).or_insert_with(|| {
            groups.push((item.title.clone(), item.is_tv));
            groups.len() - 1
        });
        group_of.push(gi);
    }
    groups.truncate(MAX_UNIQUE_TITLES);

    let total = groups.len();
    let sem = Arc::new(Semaphore::new(TMDB_CONCURRENCY));
    let mut set = JoinSet::new();
    for (gi, (title, is_tv)) in groups.iter().cloned().enumerate() {
        let (db, tmdb, sem) = (db.clone(), tmdb.clone(), sem.clone());
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            (gi, resolve_title(&db, &tmdb, &title, is_tv).await)
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
    fn parses_netflix_context_with_escapes() {
        let html = r#"<script>netflix.reactContext = {"models":{"serverDefs":{"data":{"BUILD_IDENTIFIER":"vb4b9a1c2"}},"userInfo":{"data":{"name":"Ary\x20an","guid":"ABCDEF123","userGuid":"ZZZ"}}}};</script>"#;
        let ctx = parse_netflix_context(html).unwrap();
        assert_eq!(ctx.build_identifier.as_deref(), Some("vb4b9a1c2"));
        assert_eq!(ctx.profile_guid.as_deref(), Some("ABCDEF123"));
        assert_eq!(ctx.profile_name.as_deref(), Some("Ary an"));
    }

    #[test]
    fn unescapes_js() {
        // Inputs are built at runtime (b = backslash) so the escapes reach unescape_js verbatim.
        let input = format!("Am{b}u00e9lie {b}x26 co {b}\"x{b}\"", b = '\\');
        assert_eq!(unescape_js(&input), "Am\u{e9}lie & co \"x\"");
        let surrogates = format!("{b}ud83c{b}udfac", b = '\\');
        assert_eq!(unescape_js(&surrogates), "\u{1F3AC}");
    }

    #[test]
    fn netflix_viewing_item() {
        let v = json!({
            "title": "Stranger Things: Season 4: Chapter One",
            "seriesTitle": "Stranger Things",
            "series": 80057281,
            "seasonDescriptor": "Season 4",
            "episodeTitle": "Chapter One: The Hellfire Club",
            "date": 1_700_000_000_000i64,
            "bookmark": 4500,
            "duration": 4680
        });
        let item = netflix_item(&v).unwrap();
        assert_eq!(item.title, "Stranger Things");
        assert_eq!(item.is_tv, Some(true));
        assert_eq!(item.season, Some(4));
        assert_eq!(item.progress_seconds, Some(4500.0));
        let movie = netflix_item(&json!({ "title": "Glass Onion", "date": 1_700_000_000_000i64 })).unwrap();
        assert_eq!(movie.is_tv, Some(false));
        assert_eq!(movie.season, None);
    }

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
        assert_eq!(pick_hit(&hits, "The Matrix").unwrap().1.id, 2);
        assert!(pick_hit(&[hit(3, "Something Else")], "The Matrix").is_none());
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
