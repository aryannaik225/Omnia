//! Headless background sync (cross-device viewing).
//!
//! When Omnia starts, every 10 minutes while it runs, when its window comes back from the tray
//! or regains focus, and on "Sync now", every linked OTT account of every
//! profile gets a quiet **delta** sync: a hidden WebView2 window in that profile's own browser
//! data reads only activity newer than the account's last successful sync (Netflix stops paging
//! at the first older entry; history pages scroll less; Continue Watching tiles count as new only
//! when their progress moved). Fresh activity is stored as live, so something watched on a phone
//! shows up in Continue Watching.
//!
//! Courtesy rules: one hidden window at a time; never while the player is open or an import is
//! running; each account at most every `MIN_INTERVAL`; nothing is shown unless something new
//! arrived. Privacy is the importer's: the provider's own pages in the profile's own session.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::queries;
use crate::player::window_manager::{self as wm, OttProvider};
use crate::sync::history_importer::{import_ott_history_inner, ImportMode};
use crate::AppState;

pub const EVT_BACKGROUND_SYNC: &str = "omnia://background-sync";

/// Disable with `app_settings.background_sync = "false"`.
pub const SETTING_KEY: &str = "background_sync";

/// An account is re-synced at most this often.
const MIN_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// Tray wake-ups closer together than this don't even look.
const WAKE_DEBOUNCE: Duration = Duration::from_secs(5 * 60);
/// Delay after app start, so the catalog loads first.
pub const STARTUP_DELAY: Duration = Duration::from_secs(25);
/// While Omnia runs (window open or in the tray), look again this often; accounts still obey
/// `MIN_INTERVAL`, so this only decides how soon after it expires a sync happens.
const PERIODIC: Duration = Duration::from_secs(10 * 60);
/// Accounts never synced before (linked before sync state existed, no history): look back this far.
const FIRST_DELTA_DAYS: i64 = 30;

static RUNNING: AtomicBool = AtomicBool::new(false);
static LAST_WAKE: Mutex<Option<Instant>> = Mutex::new(None);

fn parse_db_time(s: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(s.get(..19)?, "%Y-%m-%d %H:%M:%S").ok().map(|n| n.and_utc())
}

/// Starts a background sync unless one ran very recently (tray wake / second launch).
pub fn on_wake(app: &AppHandle) {
    {
        let mut last = LAST_WAKE.lock().unwrap_or_else(|p| p.into_inner());
        if last.is_some_and(|t| t.elapsed() < WAKE_DEBOUNCE) {
            return;
        }
        *last = Some(Instant::now());
    }
    spawn(app.clone(), "wake");
}

/// Starts a background sync after `delay` (app start), then every `PERIODIC` while Omnia runs.
pub fn spawn_after(app: AppHandle, delay: Duration) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        *LAST_WAKE.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        run(&app, "startup", false, None).await;
        loop {
            tokio::time::sleep(PERIODIC).await;
            run(&app, "periodic", false, None).await;
        }
    });
}

/// "Sync now": every linked account of `app_profile_id` immediately (ignores `MIN_INTERVAL`).
/// Returns rows new or changed, or `None` when a sync is already running.
pub async fn sync_now(app: &AppHandle, app_profile_id: i64) -> crate::AppResult<Option<usize>> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(None);
    }
    let result = run_inner(app, "sync now", true, Some(app_profile_id)).await;
    RUNNING.store(false, Ordering::SeqCst);
    result.map(Some)
}

fn spawn(app: AppHandle, trigger: &'static str) {
    tauri::async_runtime::spawn(async move { run(&app, trigger, false, None).await });
}

async fn run(app: &AppHandle, trigger: &str, force: bool, only_profile: Option<i64>) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let result = run_inner(app, trigger, force, only_profile).await;
    RUNNING.store(false, Ordering::SeqCst);
    if let Err(e) = result {
        log::warn!("background sync ({trigger}) stopped: {e}");
    }
}

async fn run_inner(app: &AppHandle, trigger: &str, force: bool, only_profile: Option<i64>) -> crate::AppResult<usize> {
    let state = app.state::<AppState>();
    let enabled = state
        .db
        .run(|c| queries::get_setting(c, SETTING_KEY))
        .await?
        .is_none_or(|v| v != "false");
    if !enabled && !force {
        return Ok(0);
    }
    let mappings = state.db.run(|c| queries::list_all_ott_mappings(c)).await?;
    let mut checked = 0usize;
    let mut new_total = 0usize;
    for m in mappings {
        let provider = OttProvider::detect(m.provider_id, "");
        if provider == OttProvider::Generic || only_profile.is_some_and(|p| p != m.app_profile_id) {
            continue;
        }
        // Don't compete with the user: the player (and its RAM) comes first.
        if wm::player_is_open(app) || state.importer.has_running_for(m.app_profile_id) {
            log::info!("background sync ({trigger}) paused: the player or an import is active");
            break;
        }
        let (profile_id, provider_id) = (m.app_profile_id, m.provider_id);
        // Rows already stored for this service (any spelling of its name) decide the name used
        // for new rows and, for accounts never synced before, where the delta starts.
        let (sync_state, latest, stored_name) = state
            .db
            .run(move |c| {
                let mut names: Vec<(String, i64)> = queries::history_provider_names(c, profile_id)?
                    .into_iter()
                    .filter(|(n, _)| !n.is_empty() && wm::canonical_provider_id(0, n) == provider_id)
                    .collect();
                names.sort_by_key(|(_, rows)| std::cmp::Reverse(*rows));
                let list: Vec<String> = names.iter().map(|(n, _)| n.clone()).collect();
                Ok((
                    queries::get_sync_state(c, profile_id, provider_id)?,
                    queries::latest_provider_activity(c, profile_id, &list)?,
                    list.into_iter().next(),
                ))
            })
            .await?;
        let provider_name = stored_name.unwrap_or_else(|| provider.display_name().to_string());
        let now = Utc::now();
        if let Some(attempt) = sync_state.as_ref().and_then(|s| s.last_attempt_at.as_deref()).and_then(parse_db_time) {
            if !force && (now - attempt).to_std().unwrap_or_default() < MIN_INTERVAL {
                continue;
            }
        }
        let since = sync_state
            .as_ref()
            .and_then(|s| s.last_success_at.as_deref())
            .and_then(parse_db_time)
            .or_else(|| latest.as_deref().and_then(parse_db_time))
            .unwrap_or(now - chrono::Duration::days(FIRST_DELTA_DAYS));
        checked += 1;
        let started = Instant::now();
        match import_ott_history_inner(app, profile_id, provider_id, &provider_name, ImportMode::Delta { since }).await {
            Ok(report) => {
                log::info!(
                    "background sync: {provider_name} for profile {profile_id}: {} entries read, {} rows new or changed in {:.1}s",
                    report.fetched,
                    report.changed,
                    started.elapsed().as_secs_f32()
                );
                if report.changed > 0 {
                    new_total += report.changed;
                    let _ = app.emit_to(
                        wm::MAIN_LABEL,
                        EVT_BACKGROUND_SYNC,
                        json!({ "appProfileId": profile_id, "providerName": provider_name, "updated": report.changed }),
                    );
                }
            }
            // Expired sessions etc. are recorded in ott_sync_state; the next wake retries.
            Err(e) => log::info!("background sync: {provider_name} for profile {profile_id} skipped: {e}"),
        }
    }
    if checked > 0 {
        log::info!("background sync ({trigger}) done: {checked} accounts checked, {new_total} rows new or changed");
    }
    Ok(new_total)
}
