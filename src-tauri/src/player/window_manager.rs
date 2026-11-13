//! Native WebView2 Smart Player manager.
//!
//! Spawns a dedicated player `WebviewWindow` pointed at the resolved OTT deep link, injects the
//! `<video>` telemetry observer, and turns its 3-second samples into `watch_history` /
//! `playback_events` rows **only for a verified Omnia profile**.
//!
//! Profile isolation (strict): every sample carries the OTT's native profile identity (Netflix
//! `guid::name`, Prime `profileId`, ...). A sample is written to the session's Omnia profile only
//! when that identity equals the OTT profile linked to it in `ott_profile_mappings`:
//!   * linked profile is active                       -> recorded
//!   * another OTT profile is active                  -> dropped ("mismatch")
//!   * no link yet, but an OTT profile is detected    -> dropped; the pill offers one-click linking
//!   * profile can't be determined while links exist  -> dropped ("unverified")
//!   * provider never linked by anyone & undetectable -> recorded (no isolation configured)
//! Nothing is ever rerouted to another family member's history.
//!
//! On launch, providers that support it are switched to the linked profile first (Netflix
//! `SwitchProfile`), then the deep link is opened.
//!
//! Session isolation: every OTT webview (player, hidden importer) runs in the
//! browser profile of one Omnia profile — its own WebView2 user-data folder under
//! `<local app data>/Profiles/<app_profile_id>` (a per-profile data store on macOS). Cookies,
//! cache and local storage are never shared between Omnia profiles, so each person signs in to
//! their own OTT accounts once and nobody else's session can leak into their player.
//!
//! Security: player windows load third-party pages. Their IPC is restricted by the `player`
//! capability (remote OTT origins only, four telemetry commands only), and every call must carry
//! the per-session random token that only the injected script knows.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::Notify;

use crate::db::queries::{self, ProgressUpdate};
use crate::db::Database;
use crate::resolver::justwatch::normalize_title;
use crate::sync::history_importer::{match_episode_name, TmdbClient};
use crate::{AppError, AppResult, AppState};

const TELEMETRY_SCRIPT: &str = include_str!("telemetry_injector.js");

pub const PLAYER_LABEL_PREFIX: &str = "player-";
/// Folder (under the OS local app-data dir) holding one browser profile per Omnia profile.
pub const PROFILES_DIR: &str = "Profiles";
pub const MAIN_LABEL: &str = "main";
const SYNC_INTERVAL_MS: u64 = 3000;
/// Samples from media shorter than this are treated as ads / trailers / bumpers and ignored.
const MIN_TRACKABLE_DURATION_SECS: f64 = 90.0;
/// An episode/movie counts as finished for hop-completion and binge counting at 85%.
const HOP_COMPLETION_RATIO: f64 = 0.85;
const FINAL_FLUSH_WAIT: Duration = Duration::from_millis(900);

pub const EVT_BACK_TO_HUB: &str = "omnia://back-to-hub";
pub const EVT_PLAYER_OPENED: &str = "omnia://player-opened";
pub const EVT_PLAYER_CLOSED: &str = "omnia://player-closed";
pub const EVT_PLAYBACK_PROGRESS: &str = "omnia://playback-progress";
pub const EVT_TITLE_CHANGED: &str = "omnia://player-title-changed";
pub const EVT_PROFILE_MISMATCH: &str = "omnia://ott-profile-mismatch";
pub const EVT_PROFILE_CONNECTED: &str = "omnia://ott-profile-connected";

static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

/// OTT families the player and importer know how to handle specially.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OttProvider {
    Netflix,
    PrimeVideo,
    Hotstar,
    Zee5,
    SonyLiv,
    AppleTv,
    DisneyPlus,
    HboMax,
    Hulu,
    Peacock,
    ParamountPlus,
    Crunchyroll,
    Generic,
}

impl OttProvider {
    /// Matches by TMDB/JustWatch provider id first, then by name. Monetisation variants
    /// ("with Ads", "Kids", the Amazon store…) all map to their parent family.
    pub fn detect(provider_id: i64, provider_name: &str) -> Self {
        use OttProvider::*;
        let lower = provider_name.trim().to_lowercase();
        // Channels resold through a store ("MUBI Amazon Channel") belong to their own brand.
        let channel_suffix = [" amazon channel", " apple tv channel", " roku premium channel"]
            .iter()
            .find(|sfx| lower.ends_with(**sfx));
        let n = match channel_suffix {
            Some(sfx) => lower[..lower.len() - sfx.len()].to_string(),
            None => lower,
        };
        let provider_id = if channel_suffix.is_some() { -1 } else { provider_id };
        let has = |s: &str| n.contains(s);
        if matches!(provider_id, 8 | 175 | 1796) || has("netflix") {
            Netflix
        } else if matches!(provider_id, 122 | 220 | 2336) || has("hotstar") || has("jiocinema") {
            Hotstar
        } else if matches!(provider_id, 9 | 10 | 119 | 2100 | 613) || has("prime video") || has("amazon") {
            PrimeVideo
        } else if provider_id == 337 || has("disney") {
            DisneyPlus
        } else if matches!(provider_id, 2 | 350) || has("apple tv") {
            AppleTv
        } else if provider_id == 232 || has("zee5") {
            Zee5
        } else if provider_id == 237 || has("sonyliv") || has("sony liv") {
            SonyLiv
        } else if matches!(provider_id, 1899 | 384) || has("hbo") || n == "max" || n.starts_with("max ") {
            HboMax
        } else if provider_id == 15 || has("hulu") {
            Hulu
        } else if matches!(provider_id, 386 | 387) || has("peacock") {
            Peacock
        } else if matches!(provider_id, 531 | 582 | 1853) || has("paramount") {
            ParamountPlus
        } else if matches!(provider_id, 283 | 1968) || has("crunchyroll") {
            Crunchyroll
        } else {
            Generic
        }
    }

    pub fn key(self) -> &'static str {
        use OttProvider::*;
        match self {
            Netflix => "netflix",
            PrimeVideo => "primevideo",
            Hotstar => "hotstar",
            Zee5 => "zee5",
            SonyLiv => "sonyliv",
            AppleTv => "appletv",
            DisneyPlus => "disneyplus",
            HboMax => "hbomax",
            Hulu => "hulu",
            Peacock => "peacock",
            ParamountPlus => "paramountplus",
            Crunchyroll => "crunchyroll",
            Generic => "generic",
        }
    }

    /// One stable id per family, so a link made on "Prime Video with Ads" (2100) also applies to
    /// "Amazon Prime Video" (9/119). Generic providers keep their own id.
    pub fn canonical_id(self) -> Option<i64> {
        use OttProvider::*;
        Some(match self {
            Netflix => 8,
            PrimeVideo => 9,
            Hotstar => 122,
            Zee5 => 232,
            SonyLiv => 237,
            AppleTv => 350,
            DisneyPlus => 337,
            HboMax => 1899,
            Hulu => 15,
            Peacock => 386,
            ParamountPlus => 531,
            Crunchyroll => 283,
            Generic => return None,
        })
    }

    /// Landing page for the "Connect account" handshake (login + "Who's watching?").
    pub fn home_url(self, region: &str) -> Option<String> {
        use OttProvider::*;
        let r = region.to_ascii_lowercase();
        Some(match self {
            Netflix => "https://www.netflix.com/browse".into(),
            PrimeVideo => "https://www.primevideo.com/".into(),
            Hotstar => format!("https://www.hotstar.com/{r}/home"),
            Zee5 => "https://www.zee5.com/".into(),
            SonyLiv => "https://www.sonyliv.com/".into(),
            AppleTv => format!("https://tv.apple.com/{r}"),
            DisneyPlus => "https://www.disneyplus.com/home".into(),
            HboMax => "https://play.hbomax.com/".into(),
            Hulu => "https://www.hulu.com/hub/home".into(),
            Peacock => "https://www.peacocktv.com/watch/home".into(),
            ParamountPlus => "https://www.paramountplus.com/home/".into(),
            Crunchyroll => "https://www.crunchyroll.com/".into(),
            Generic => return None,
        })
    }

    /// URL that makes the provider switch the browser session to a given native profile.
    pub fn profile_switch_url(self, native_profile_id: &str) -> Option<String> {
        match self {
            OttProvider::Netflix => {
                let guid = netflix_guid(native_profile_id);
                (!guid.is_empty()).then(|| {
                    format!(
                        "https://www.netflix.com/SwitchProfile?tkn={}",
                        url::form_urlencoded::byte_serialize(guid.as_bytes()).collect::<String>()
                    )
                })
            }
            _ => None,
        }
    }

    /// Providers whose player exposes reliable season/episode metadata: for these, series
    /// progress is only recorded once the episode is confirmed (never the launch-time guess).
    pub fn confirms_episodes(self) -> bool {
        matches!(self, OttProvider::Netflix | OttProvider::PrimeVideo)
    }
}

/// Netflix identities are stored as `guid::profile name`; the guid part drives `SwitchProfile`.
pub fn netflix_guid(native_profile_id: &str) -> &str {
    native_profile_id.split("::").next().unwrap_or_default().trim()
}

/// Canonical provider id used for every `ott_profile_mappings` read and write.
pub fn canonical_provider_id(provider_id: i64, provider_name: &str) -> i64 {
    OttProvider::detect(provider_id, provider_name).canonical_id().unwrap_or(provider_id)
}

// ---------------------------------------------------------------------------------------------
// Wire types (script <-> Rust <-> catalog window)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PlayerMode {
    #[default]
    Play,
    Connect,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPlayerRequest {
    pub app_profile_id: i64,
    pub provider_id: i64,
    pub provider_name: String,
    #[serde(default)]
    pub mode: PlayerMode,
    #[serde(default)]
    pub tmdb_id: Option<i64>,
    #[serde(default)]
    pub media_type: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub original_title: Option<String>,
    #[serde(default)]
    pub season_number: i64,
    #[serde(default)]
    pub episode_number: i64,
    #[serde(default)]
    pub episode_title: Option<String>,
    /// Required in play mode; optional override of the provider landing page in connect mode.
    #[serde(default)]
    pub direct_url: Option<String>,
    #[serde(default)]
    pub resume_at_seconds: Option<f64>,
    #[serde(default)]
    pub region: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerOpened {
    pub label: String,
    pub mode: PlayerMode,
    pub resume_at_seconds: Option<f64>,
    pub mapped_ott_profile_id: Option<String>,
    /// True when the window first switches the provider to the linked profile.
    pub switching_profile: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryKind {
    Progress,
    Play,
    Pause,
    Seek,
    Ended,
    Metadata,
    Final,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    #[default]
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DetectedMedia {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub season_number: Option<i64>,
    #[serde(default)]
    pub episode_number: Option<i64>,
    #[serde(default)]
    pub episode_title: Option<String>,
    #[serde(default)]
    pub ott_title_id: Option<String>,
    #[serde(default)]
    pub confidence: Confidence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedOttProfile {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryPayload {
    pub token: String,
    pub kind: TelemetryKind,
    #[serde(default)]
    pub current_time: f64,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub active_delta_seconds: f64,
    #[serde(default)]
    pub seek_from: Option<f64>,
    #[serde(default)]
    pub page_url: Option<String>,
    #[serde(default)]
    pub url_changed: bool,
    #[serde(default)]
    pub detected: Option<DetectedMedia>,
    #[serde(default)]
    pub ott_profile: Option<DetectedOttProfile>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryAck {
    pub accepted: bool,
    /// `recording` | `mismatch` | `unlinked` | `unverified` | `suspended`
    pub attribution: &'static str,
    /// Omnia profile that owns the observed OTT profile (mismatch only).
    pub owner_profile_name: Option<String>,
    pub observed_profile_name: Option<String>,
    pub message: Option<String>,
}

impl TelemetryAck {
    fn status(attribution: &'static str, message: Option<String>) -> Self {
        Self { accepted: false, attribution, owner_profile_name: None, observed_profile_name: None, message }
    }
}

impl Default for TelemetryAck {
    fn default() -> Self {
        Self::status("suspended", None)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPayload {
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportProfilePayload {
    pub token: String,
    pub profile: DetectedOttProfile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportProfileResult {
    pub linked: bool,
    pub message: Option<String>,
}

/// Sent by the catalog window after resolving an in-player title change via TMDB.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebindRequest {
    pub tmdb_id: i64,
    pub media_type: String,
    pub title: String,
    #[serde(default)]
    pub original_title: Option<String>,
    #[serde(default)]
    pub season_number: Option<i64>,
    #[serde(default)]
    pub episode_number: Option<i64>,
    #[serde(default)]
    pub episode_title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStatus {
    pub label: String,
    pub mode: PlayerMode,
    pub app_profile_id: i64,
    pub provider_id: i64,
    pub provider_name: String,
    pub tmdb_id: Option<i64>,
    pub media_type: Option<String>,
    pub title: Option<String>,
    pub season_number: i64,
    pub episode_number: i64,
    pub progress_seconds: f64,
    pub duration_seconds: f64,
    pub active_watch_seconds: f64,
    pub awaiting_rebind: bool,
    /// `recording` | `mismatch` | `unlinked` | `unverified` | `pending`
    pub tracking: &'static str,
}

// ---------------------------------------------------------------------------------------------
// Profile attribution (pure, unit-tested)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attribution {
    /// The linked OTT profile is active: record to this Omnia profile.
    Recording(i64),
    /// A different OTT profile than the linked one is active.
    Mismatch,
    /// No link for this Omnia profile; the active OTT profile belongs to another Omnia profile.
    OwnedByOther,
    /// No link yet and the active OTT profile is unclaimed: offer linking, record nothing.
    Unlinked,
    /// The active OTT profile can't be determined while links exist.
    Unverified,
}

impl Attribution {
    fn key(self) -> &'static str {
        match self {
            Attribution::Recording(_) => "recording",
            Attribution::Mismatch | Attribution::OwnedByOther => "mismatch",
            Attribution::Unlinked => "unlinked",
            Attribution::Unverified => "unverified",
        }
    }
}

/// Strict attribution. See the module docs; nothing is ever attributed to another profile.
pub fn attribute(
    session_profile: i64,
    session_mapping: Option<&str>,
    observed: Option<&str>,
    owner_of_observed: Option<i64>,
    provider_has_mappings: bool,
) -> Attribution {
    match (session_mapping, observed) {
        (Some(mapped), Some(seen)) if mapped == seen => Attribution::Recording(session_profile),
        (Some(_), Some(_)) => Attribution::Mismatch,
        (Some(_), None) => Attribution::Unverified,
        (None, Some(_)) => {
            if owner_of_observed.is_some() {
                Attribution::OwnedByOther
            } else {
                Attribution::Unlinked
            }
        }
        (None, None) => {
            if provider_has_mappings {
                Attribution::Unverified
            } else {
                Attribution::Recording(session_profile)
            }
        }
    }
}

/// Loose title equivalence used to tell an episode hop (same series) from a title hop.
pub fn titles_match(a: &str, b: &str) -> bool {
    let (a, b) = (normalize_title(a), normalize_title(b));
    if a.is_empty() || b.is_empty() {
        return true;
    }
    if a == b || a.contains(&b) || b.contains(&a) {
        return true;
    }
    let ta: HashSet<&str> = a.split(' ').collect();
    let tb: HashSet<&str> = b.split(' ').collect();
    let inter = ta.intersection(&tb).count() as f64;
    let union = ta.union(&tb).count() as f64;
    union > 0.0 && inter / union >= 0.5
}

// ---------------------------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct SessionItem {
    tmdb_id: i64,
    media_type: String,
    titles: Vec<String>,
    season_number: i64,
    episode_number: i64,
    episode_title: Option<String>,
    direct_url: String,
    last_progress: f64,
    last_duration: f64,
    /// Series only: season/episode confirmed by the provider (not the launch-time guess).
    episode_confirmed: bool,
}

impl SessionItem {
    fn ratio(&self) -> f64 {
        if self.last_duration > 1.0 {
            (self.last_progress / self.last_duration).clamp(0.0, 1.0)
        } else {
            0.0
        }
    }
}

#[derive(Debug, Clone)]
enum DbOp {
    Progress(ProgressUpdate),
    Complete { profile: i64, tmdb_id: i64, media_type: String, season: i64, episode: i64 },
    Event { profile: i64, tmdb_id: i64, media_type: String, event_type: &'static str, seconds: f64 },
}

#[derive(Debug, Default)]
struct Plan {
    ops: Vec<DbOp>,
    emits: Vec<(&'static str, Value)>,
    ack: TelemetryAck,
}

struct PlayerSession {
    label: String,
    token: String,
    mode: PlayerMode,
    app_profile_id: i64,
    app_profile_name: String,
    /// Canonical provider id (see `canonical_provider_id`).
    provider_id: i64,
    provider_name: String,
    provider: OttProvider,
    mapped_ott_profile_id: Option<String>,
    /// Whether any Omnia profile has linked this provider (strict mode when true).
    provider_has_mappings: bool,
    item: Option<SessionItem>,
    awaiting_metadata: bool,
    pending_title_change: Option<DetectedMedia>,
    active_watch_seconds: f64,
    episodes_finished: HashSet<(i64, i64)>,
    last_attribution: Option<Attribution>,
    last_notified: Option<&'static str>,
    /// `play_start` is logged on the first verified sample of each title (never before).
    play_start_logged: bool,
    last_progress_emit: Option<Instant>,
    final_flush: Arc<Notify>,
    /// Episode names resolved to (season, episode) via TMDB, for players that show the episode
    /// name but not its numbers. Keyed by (tmdb id, normalised name).
    episode_lookups: HashMap<(i64, String), EpisodeLookup>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EpisodeLookup {
    Pending,
    Found(i64, i64),
    Missing(Instant),
}

/// Retry a failed episode-name lookup after this long (network blips, TMDB rate limits).
const EPISODE_LOOKUP_RETRY: Duration = Duration::from_secs(60);

/// A season/episode-less detection of the series being played that carries an episode name.
fn episode_lookup_job(item: Option<&SessionItem>, d: Option<&DetectedMedia>) -> Option<(i64, String, Option<i64>)> {
    let (item, d) = (item?, d?);
    if item.media_type != "tv" || d.episode_number.is_some_and(|e| e > 0) {
        return None;
    }
    let name = d.episode_title.as_deref().map(str::trim).filter(|n| n.chars().count() >= 2)?;
    let detected_title = d.title.as_deref().unwrap_or_default();
    if !item.titles.iter().any(|t| titles_match(t, detected_title)) || item.titles.iter().any(|t| normalize_title(t) == normalize_title(name)) {
        return None;
    }
    Some((item.tmdb_id, normalize_title(name), d.season_number.filter(|s| *s > 0)))
}

impl PlayerSession {
    fn recording_profile(&self) -> Option<i64> {
        match self.last_attribution {
            Some(Attribution::Recording(p)) => Some(p),
            _ => None,
        }
    }

    fn status(&self) -> PlayerStatus {
        PlayerStatus {
            label: self.label.clone(),
            mode: self.mode,
            app_profile_id: self.app_profile_id,
            provider_id: self.provider_id,
            provider_name: self.provider_name.clone(),
            tmdb_id: self.item.as_ref().map(|i| i.tmdb_id),
            media_type: self.item.as_ref().map(|i| i.media_type.clone()),
            title: self.item.as_ref().and_then(|i| i.titles.first().cloned()),
            season_number: self.item.as_ref().map_or(0, |i| i.season_number),
            episode_number: self.item.as_ref().map_or(0, |i| i.episode_number),
            progress_seconds: self.item.as_ref().map_or(0.0, |i| i.last_progress),
            duration_seconds: self.item.as_ref().map_or(0.0, |i| i.last_duration),
            active_watch_seconds: self.active_watch_seconds,
            awaiting_rebind: self.pending_title_change.is_some(),
            tracking: self.last_attribution.map_or("pending", Attribution::key),
        }
    }

    /// Applies one telemetry sample and returns the DB writes / UI events it implies.
    /// Metadata (episode/title hops) is always tracked so state stays correct, but writes are
    /// only produced while the linked OTT profile is verified.
    fn apply(&mut self, p: &TelemetryPayload, attribution: Attribution) -> Plan {
        let mut plan = Plan::default();
        if self.mode != PlayerMode::Play {
            return plan;
        }
        let verified = matches!(attribution, Attribution::Recording(_));
        let target = self.app_profile_id;
        self.last_attribution = Some(attribution);
        if verified && p.active_delta_seconds.is_finite() {
            self.active_watch_seconds += p.active_delta_seconds.clamp(0.0, 30.0);
        }

        // --- metadata: episode hops & title hops -------------------------------------------
        if p.url_changed && p.detected.is_none() {
            // In-app navigation happened and the new item isn't identified yet: write nothing
            // rather than risk attributing the next episode's progress to the previous one.
            self.awaiting_metadata = true;
        }
        let mut title_changed = false;
        if let Some(d) = &p.detected {
            self.awaiting_metadata = false;
            title_changed = self.apply_detection(d, target, &mut plan);
        }

        if !verified {
            plan.ops.clear();
            plan.emits.retain(|(event, _)| *event == EVT_TITLE_CHANGED);
            let observed_name = p.ott_profile.as_ref().and_then(|o| o.name.clone());
            let key = attribution.key();
            if self.last_notified != Some(key) {
                self.last_notified = Some(key);
                if key != "unverified" {
                    plan.emits.push((
                        EVT_PROFILE_MISMATCH,
                        json!({
                            "appProfileId": self.app_profile_id,
                            "providerId": self.provider_id,
                            "providerName": self.provider_name,
                            "reason": key,
                            "observedOttProfileName": observed_name,
                        }),
                    ));
                }
            }
            let message = match attribution {
                Attribution::Mismatch | Attribution::OwnedByOther => format!(
                    "Not tracking: {} isn't {}'s {} profile",
                    observed_name.as_deref().unwrap_or("this"),
                    self.app_profile_name,
                    self.provider_name
                ),
                Attribution::Unlinked => format!("Not tracking yet: link this {} profile to {}", self.provider_name, self.app_profile_name),
                _ => format!("Verifying your {} profile…", self.provider_name),
            };
            plan.ack = TelemetryAck { observed_profile_name: observed_name, ..TelemetryAck::status(key, Some(message)) };
            return plan;
        }
        self.last_notified = None;

        if title_changed {
            plan.ack = TelemetryAck::status("suspended", Some("Identifying the new title…".to_string()));
            return plan;
        }
        if self.awaiting_metadata || self.item.is_none() {
            plan.ack = TelemetryAck::status("suspended", None);
            return plan;
        }

        if !self.play_start_logged {
            if let Some(item) = &self.item {
                self.play_start_logged = true;
                plan.ops.push(DbOp::Event {
                    profile: target,
                    tmdb_id: item.tmdb_id,
                    media_type: item.media_type.clone(),
                    event_type: "play_start",
                    seconds: 0.0,
                });
            }
        }

        // --- progress ------------------------------------------------------------------------
        let provider_name = self.provider_name.clone();
        let item = self.item.as_mut().expect("checked above");
        if item.media_type == "tv" && !item.episode_confirmed {
            plan.ack = TelemetryAck::status("suspended", Some("Identifying the episode…".to_string()));
            return plan;
        }
        let trackable = p.duration.is_finite() && p.duration >= MIN_TRACKABLE_DURATION_SECS;
        if trackable && p.current_time.is_finite() && p.current_time >= 1.0 {
            item.last_progress = p.current_time;
            item.last_duration = p.duration;
            let page_url = p
                .page_url
                .as_deref()
                .filter(|u| u.starts_with("https://"))
                .map(str::to_string);
            plan.ops.push(DbOp::Progress(ProgressUpdate {
                app_profile_id: target,
                tmdb_id: item.tmdb_id,
                media_type: item.media_type.clone(),
                season_number: item.season_number,
                episode_number: item.episode_number,
                episode_title: item.episode_title.clone(),
                provider_name: Some(provider_name),
                direct_url: page_url.or_else(|| Some(item.direct_url.clone()).filter(|u| !u.is_empty())),
                progress_seconds: p.current_time,
                duration_seconds: p.duration,
            }));
            if item.media_type == "tv" && item.ratio() >= HOP_COMPLETION_RATIO {
                self.episodes_finished.insert((item.season_number, item.episode_number));
            }
        }

        let item = self.item.as_ref().expect("checked above");
        match p.kind {
            TelemetryKind::Pause if trackable => plan.ops.push(DbOp::Event {
                profile: target,
                tmdb_id: item.tmdb_id,
                media_type: item.media_type.clone(),
                event_type: "pause",
                seconds: self.active_watch_seconds,
            }),
            TelemetryKind::Seek if trackable => {
                if let Some(from) = p.seek_from.filter(|f| f.is_finite()) {
                    plan.ops.push(DbOp::Event {
                        profile: target,
                        tmdb_id: item.tmdb_id,
                        media_type: item.media_type.clone(),
                        event_type: if p.current_time >= from { "seek_forward" } else { "seek_backward" },
                        seconds: (p.current_time - from).abs(),
                    });
                }
            }
            TelemetryKind::Ended if trackable => {
                plan.ops.push(DbOp::Complete {
                    profile: target,
                    tmdb_id: item.tmdb_id,
                    media_type: item.media_type.clone(),
                    season: item.season_number,
                    episode: item.episode_number,
                });
                plan.ops.push(DbOp::Event {
                    profile: target,
                    tmdb_id: item.tmdb_id,
                    media_type: item.media_type.clone(),
                    event_type: "ended",
                    seconds: self.active_watch_seconds,
                });
                if item.media_type == "tv" {
                    let key = (item.season_number, item.episode_number);
                    self.episodes_finished.insert(key);
                }
            }
            _ => {}
        }

        let item = self.item.as_ref().expect("checked above");
        let urgent = matches!(p.kind, TelemetryKind::Pause | TelemetryKind::Ended | TelemetryKind::Final);
        let due = self.last_progress_emit.is_none_or(|t| t.elapsed() >= Duration::from_secs(10));
        if trackable && (urgent || due) {
            self.last_progress_emit = Some(Instant::now());
            plan.emits.push((
                EVT_PLAYBACK_PROGRESS,
                json!({
                    "appProfileId": target,
                    "tmdbId": item.tmdb_id,
                    "mediaType": item.media_type,
                    "seasonNumber": item.season_number,
                    "episodeNumber": item.episode_number,
                    "progressSeconds": item.last_progress,
                    "durationSeconds": item.last_duration,
                    "paused": p.paused,
                }),
            ));
        }

        plan.ack = TelemetryAck { accepted: true, ..TelemetryAck::status("recording", None) };
        plan
    }

    /// Handles detected metadata. Returns `true` when the user switched to a different title.
    fn apply_detection(&mut self, d: &DetectedMedia, target: i64, plan: &mut Plan) -> bool {
        let Some(item) = self.item.as_mut() else {
            // Already waiting for the catalog window to identify a new title.
            return false;
        };
        let detected_title = d.title.as_deref().unwrap_or_default();
        let same_title = item.titles.iter().any(|t| titles_match(t, detected_title));

        if !same_title {
            if item.ratio() >= HOP_COMPLETION_RATIO {
                plan.ops.push(DbOp::Complete {
                    profile: target,
                    tmdb_id: item.tmdb_id,
                    media_type: item.media_type.clone(),
                    season: item.season_number,
                    episode: item.episode_number,
                });
            }
            plan.ops.push(DbOp::Event {
                profile: target,
                tmdb_id: item.tmdb_id,
                media_type: item.media_type.clone(),
                event_type: "title_hop",
                seconds: self.active_watch_seconds,
            });
            plan.emits.push((
                EVT_TITLE_CHANGED,
                json!({
                    "appProfileId": self.app_profile_id,
                    "providerId": self.provider_id,
                    "providerName": self.provider_name,
                    "previousTmdbId": item.tmdb_id,
                    "detected": d,
                }),
            ));
            self.pending_title_change = Some(d.clone());
            self.item = None;
            return true;
        }

        if item.media_type == "tv" {
            if let Some(ep) = d.episode_number.filter(|e| *e > 0) {
                let detected_season = d.season_number.filter(|s| *s > 0);
                // A season is only known if detected now or previously confirmed.
                let season = detected_season.or(item.episode_confirmed.then_some(item.season_number).filter(|s| *s > 0));
                if let Some(season) = season {
                    if (season, ep) != (item.season_number, item.episode_number) {
                        if item.episode_confirmed && item.episode_number > 0 {
                            if item.ratio() >= HOP_COMPLETION_RATIO {
                                plan.ops.push(DbOp::Complete {
                                    profile: target,
                                    tmdb_id: item.tmdb_id,
                                    media_type: item.media_type.clone(),
                                    season: item.season_number,
                                    episode: item.episode_number,
                                });
                                self.episodes_finished.insert((item.season_number, item.episode_number));
                            }
                            plan.ops.push(DbOp::Event {
                                profile: target,
                                tmdb_id: item.tmdb_id,
                                media_type: item.media_type.clone(),
                                event_type: "episode_hop",
                                seconds: self.active_watch_seconds,
                            });
                        }
                        item.season_number = season;
                        item.episode_number = ep;
                        item.episode_title = d.episode_title.clone();
                        item.last_progress = 0.0;
                        item.last_duration = 0.0;
                    }
                    item.episode_confirmed = true;
                }
            }
        }
        if d.episode_title.is_some() && (item.episode_title.is_none() || item.media_type == "tv") {
            item.episode_title = d.episode_title.clone().or(item.episode_title.take());
        }
        false
    }

    /// Writes performed when the session ends (window closed / Back to Hub / replaced).
    fn finalize_ops(&self) -> Vec<DbOp> {
        let (Some(profile), Some(item)) = (self.recording_profile(), self.item.as_ref()) else {
            return Vec::new();
        };
        if self.mode != PlayerMode::Play {
            return Vec::new();
        }
        let mut ops = vec![DbOp::Event {
            profile,
            tmdb_id: item.tmdb_id,
            media_type: item.media_type.clone(),
            event_type: "session_end",
            seconds: self.active_watch_seconds,
        }];
        // Binge Velocity: 3+ episodes finished in one sitting.
        if self.episodes_finished.len() >= 3 {
            ops.push(DbOp::Event {
                profile,
                tmdb_id: item.tmdb_id,
                media_type: item.media_type.clone(),
                event_type: "binge_session",
                seconds: self.episodes_finished.len() as f64,
            });
        }
        ops
    }
}

// ---------------------------------------------------------------------------------------------
// Manager state
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct PlayerManager {
    session: Mutex<Option<PlayerSession>>,
}

impl PlayerManager {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<PlayerSession>> {
        self.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub(crate) fn random_token() -> String {
    let mut buf = [0u8; 24];
    getrandom::getrandom(&mut buf).expect("OS random number generator unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn tokens_equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub(crate) fn next_window_label(prefix: &str) -> String {
    format!("{prefix}{}", WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// The injected script is a function expression; Rust appends the config call.
pub(crate) fn build_injection(config: &Value) -> String {
    format!("{TELEMETRY_SCRIPT}({config});")
}

fn parse_https_url(raw: &str) -> AppResult<tauri::Url> {
    let url = tauri::Url::parse(raw.trim()).map_err(|e| AppError::Message(format!("invalid URL: {e}")))?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err(AppError::Message("player URLs must be https".into()));
    }
    Ok(url)
}

// ---------------------------------------------------------------------------------------------
// Per-profile browser sessions
// ---------------------------------------------------------------------------------------------

/// Root folder of all per-profile browser data (`%LOCALAPPDATA%\<identifier>\Profiles`).
pub fn profiles_root(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app.path().app_local_data_dir()?.join(PROFILES_DIR))
}

/// The browser data folder of one Omnia profile (created on demand).
pub fn profile_data_dir(app: &AppHandle, app_profile_id: i64) -> AppResult<PathBuf> {
    if app_profile_id <= 0 {
        return Err(AppError::Message(format!("invalid profile id {app_profile_id}")));
    }
    let dir = profiles_root(app)?.join(app_profile_id.to_string());
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Stable 16-byte WKWebView data-store id for a profile (macOS has no data directories).
pub fn profile_store_identifier(app_profile_id: i64) -> [u8; 16] {
    let mut id = [0u8; 16];
    // "omnia.pr" prefix keeps it distinct from other stores; bytes 8..16 carry the profile id.
    id[..8].copy_from_slice(b"omnia.pr");
    id[8..16].copy_from_slice(&app_profile_id.to_be_bytes());
    id
}

/// A webview builder bound to `app_profile_id`'s isolated browser session. Every OTT-facing
/// webview must be created through here so no window ever falls back to the shared default store.
pub(crate) fn profile_webview_builder<'a>(
    app: &'a AppHandle,
    label: &str,
    url: WebviewUrl,
    app_profile_id: i64,
) -> AppResult<WebviewWindowBuilder<'a, tauri::Wry, AppHandle>> {
    Ok(WebviewWindowBuilder::new(app, label, url)
        .data_directory(profile_data_dir(app, app_profile_id)?)
        .data_store_identifier(profile_store_identifier(app_profile_id)))
}

/// Is any webview currently using this profile's browser data?
fn profile_session_in_use(app: &AppHandle, app_profile_id: i64) -> bool {
    let state = app.state::<AppState>();
    let player = state.player.lock().as_ref().is_some_and(|s| s.app_profile_id == app_profile_id);
    player || state.importer.has_running_for(app_profile_id)
}

/// Permanently deletes a (deleted) profile's cookies, cache and storage. WebView2's browser
/// process can hold the folder for a few seconds after its last window closes, so this retries;
/// anything still locked is swept on the next launch by [`sweep_orphan_profile_data`].
pub async fn purge_profile_data(app: &AppHandle, app_profile_id: i64) {
    let Ok(root) = profiles_root(app) else { return };
    let dir = root.join(app_profile_id.to_string());
    for attempt in 0..8u64 {
        if !dir.exists() {
            return;
        }
        if !profile_session_in_use(app, app_profile_id) && std::fs::remove_dir_all(&dir).is_ok() {
            log::info!("removed browser data of deleted profile {app_profile_id}");
            return;
        }
        tokio::time::sleep(Duration::from_millis(750 * (attempt + 1))).await;
    }
    log::warn!("browser data of deleted profile {app_profile_id} is still locked; it will be removed on next launch");
}

/// Startup: removes browser data folders whose Omnia profile no longer exists.
pub fn sweep_orphan_profile_data(app: &AppHandle, live_profile_ids: &[i64]) {
    let Ok(root) = profiles_root(app) else { return };
    let Ok(entries) = std::fs::read_dir(&root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| n.parse::<i64>().ok()) else { continue };
        if !live_profile_ids.contains(&id) {
            match std::fs::remove_dir_all(entry.path()) {
                Ok(()) => log::info!("removed orphaned browser data for profile {id}"),
                Err(e) => log::warn!("couldn't remove orphaned browser data for profile {id}: {e}"),
            }
        }
    }
}

/// Builds a WebView2 window for third-party OTT content with the telemetry script injected,
/// inside `app_profile_id`'s isolated browser session.
/// Non-HTTPS navigations (http downgrades, `nflx://`-style app hand-offs) are blocked.
pub(crate) fn build_ott_window(
    app: &AppHandle,
    label: &str,
    url: tauri::Url,
    title: &str,
    script: String,
    visible: bool,
    app_profile_id: i64,
) -> AppResult<WebviewWindow> {
    let window = profile_webview_builder(app, label, WebviewUrl::External(url), app_profile_id)?
        .title(title)
        .inner_size(1280.0, 760.0)
        .min_inner_size(640.0, 360.0)
        .center()
        .visible(visible)
        .focused(visible)
        .initialization_script(script)
        .on_navigation(|url| matches!(url.scheme(), "https" | "about" | "blob" | "data"))
        .build()?;
    Ok(window)
}

async fn execute_ops(db: &Database, ops: Vec<DbOp>) -> AppResult<()> {
    if ops.is_empty() {
        return Ok(());
    }
    db.run(move |c| {
        let tx = c.transaction()?;
        for op in ops {
            match op {
                DbOp::Progress(update) => {
                    queries::record_progress(&tx, &update)?;
                }
                DbOp::Complete { profile, tmdb_id, media_type, season, episode } => {
                    queries::mark_completed(&tx, profile, tmdb_id, &media_type, season, episode)?;
                }
                DbOp::Event { profile, tmdb_id, media_type, event_type, seconds } => {
                    queries::insert_playback_event(&tx, profile, tmdb_id, &media_type, event_type, seconds)?;
                }
            }
        }
        tx.commit()
    })
    .await
}

/// Brings the catalog window to the front.
pub fn focus_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Ends the session for `label` (if it is still the active one), writing session-level events.
async fn finalize_session(app: &AppHandle, label: &str, reason: &str) {
    let state = app.state::<AppState>();
    let taken = {
        let mut guard = state.player.lock();
        if guard.as_ref().is_some_and(|s| s.label == label) {
            guard.take()
        } else {
            None
        }
    };
    let Some(session) = taken else { return };
    if let Err(e) = execute_ops(&state.db, session.finalize_ops()).await {
        log::warn!("failed to finalize player session: {e}");
    }
    // New telemetry: let this profile's recommendations refresh.
    state.recommender.invalidate(session.app_profile_id);
    let status = session.status();
    let _ = app.emit_to(MAIN_LABEL, EVT_PLAYER_CLOSED, json!({ "reason": reason, "status": status }));
}

/// Flushes the final position from the page, finalizes the session and destroys the window
/// (releasing the WebView2 renderer's memory). Returns the last status, if a player was open.
async fn close_active_player(app: &AppHandle, reason: &str) -> Option<PlayerStatus> {
    let state = app.state::<AppState>();
    let (label, flush, status) = {
        let guard = state.player.lock();
        let s = guard.as_ref()?;
        (s.label.clone(), s.final_flush.clone(), s.status())
    };
    if let Some(window) = app.get_webview_window(&label) {
        if window.eval("window.__omniaFinalFlush && window.__omniaFinalFlush()").is_ok() {
            let _ = tokio::time::timeout(FINAL_FLUSH_WAIT, flush.notified()).await;
        }
        finalize_session(app, &label, reason).await;
        let _ = window.destroy();
    } else {
        finalize_session(app, &label, reason).await;
    }
    Some(status)
}

/// "Back to Hub": shared by the overlay pill, the global hotkeys and the catalog UI.
pub async fn back_to_hub(app: AppHandle) {
    let status = close_active_player(&app, "back_to_hub").await;
    focus_main_window(&app);
    let _ = app.emit_to(
        MAIN_LABEL,
        EVT_BACK_TO_HUB,
        json!({
            "tmdbId": status.as_ref().and_then(|s| s.tmdb_id),
            "mediaType": status.as_ref().and_then(|s| s.media_type.clone()),
        }),
    );
}

// ---------------------------------------------------------------------------------------------
// Commands — catalog window
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn open_player(app: AppHandle, state: State<'_, AppState>, request: OpenPlayerRequest) -> AppResult<PlayerOpened> {
    let profile_id = request.app_profile_id;
    let profile = state
        .db
        .run(move |c| queries::get_profile(c, profile_id))
        .await?
        .ok_or_else(|| AppError::Message(format!("profile {profile_id} not found")))?;
    let provider = OttProvider::detect(request.provider_id, &request.provider_name);
    let provider_key = canonical_provider_id(request.provider_id, &request.provider_name);
    let region = match request.region.clone() {
        Some(r) => r,
        None => state
            .db
            .run(|c| queries::get_setting(c, queries::keys::REGION_CODE))
            .await?
            .unwrap_or_else(|| "US".into()),
    };

    // Validate the request and work out the item being played.
    let (target_url, item, window_title) = match request.mode {
        PlayerMode::Play => {
            let tmdb_id = request.tmdb_id.ok_or_else(|| AppError::Message("tmdbId is required to play".into()))?;
            let media_type = request.media_type.clone().unwrap_or_default();
            if media_type != "movie" && media_type != "tv" {
                return Err(AppError::Message("mediaType must be 'movie' or 'tv'".into()));
            }
            let title = request
                .title
                .clone()
                .filter(|t| !t.trim().is_empty())
                .ok_or_else(|| AppError::Message("title is required to play".into()))?;
            let direct_url = request
                .direct_url
                .clone()
                .ok_or_else(|| AppError::Message("directUrl is required to play".into()))?;
            let url = parse_https_url(&direct_url)?;
            let mut titles = vec![title.clone()];
            titles.extend(request.original_title.clone().filter(|t| !t.trim().is_empty()));
            let is_tv = media_type == "tv";
            let (season, episode) = if is_tv {
                (request.season_number.max(0), request.episode_number.max(0))
            } else {
                (0, 0)
            };
            let item = SessionItem {
                tmdb_id,
                media_type,
                titles,
                season_number: season,
                episode_number: episode,
                episode_title: request.episode_title.clone(),
                direct_url: url.to_string(),
                last_progress: 0.0,
                last_duration: 0.0,
                // The launch-time episode is a guess (deep links open the series page); providers
                // that report the real episode must confirm it before anything is written.
                episode_confirmed: !is_tv || !provider.confirms_episodes(),
            };
            (url, Some(item), format!("{title} — {}", request.provider_name))
        }
        PlayerMode::Connect => {
            let raw = request
                .direct_url
                .clone()
                .or_else(|| provider.home_url(&region))
                .ok_or_else(|| AppError::Message(format!("{} isn't supported for account linking", request.provider_name)))?;
            (parse_https_url(&raw)?, None, format!("Connect {} — Omnia", request.provider_name))
        }
    };

    // Resume point from local history when the caller didn't pass one.
    let resume_at = match (&item, request.resume_at_seconds) {
        (_, Some(r)) => Some(r),
        (Some(it), None) => {
            let (tmdb_id, mt, s, e) = (it.tmdb_id, it.media_type.clone(), it.season_number, it.episode_number);
            state
                .db
                .run(move |c| queries::get_history_entry(c, profile_id, tmdb_id, &mt, s, e))
                .await?
                .filter(|h| !h.is_completed && h.progress_seconds > 30.0)
                .map(|h| h.progress_seconds)
        }
        (None, None) => None,
    };

    let (mapping, provider_has_mappings) = state
        .db
        .run(move |c| {
            Ok((
                queries::get_ott_mapping(c, profile_id, provider_key)?,
                queries::count_mappings_for_provider(c, provider_key)? > 0,
            ))
        })
        .await?;

    // Switch the provider to the linked profile before opening the title, where supported.
    let switch_url = match (request.mode, &mapping) {
        (PlayerMode::Play, Some(m)) => provider.profile_switch_url(&m.ott_native_profile_id),
        _ => None,
    };
    let initial_url = match &switch_url {
        Some(u) => parse_https_url(u)?,
        None => target_url.clone(),
    };

    // Only one player at a time: flush & destroy the previous one first.
    close_active_player(&app, "replaced").await;

    let label = next_window_label(PLAYER_LABEL_PREFIX);
    let token = random_token();
    let config = json!({
        "token": token,
        "mode": request.mode,
        "provider": provider.key(),
        "providerId": provider_key,
        "providerName": request.provider_name,
        "appProfileName": profile.profile_name,
        "title": item.as_ref().and_then(|i| i.titles.first().cloned()),
        "resumeAtSeconds": resume_at.unwrap_or(0.0),
        "syncIntervalMs": SYNC_INTERVAL_MS,
        "expectedOttProfileId": mapping.as_ref().map(|m| m.ott_native_profile_id.clone()),
        "expectedOttProfileName": mapping.as_ref().and_then(|m| m.ott_native_profile_name.clone()),
        "targetUrl": switch_url.as_ref().map(|_| target_url.to_string()),
        "canLink": mapping.is_none(),
    });

    let session = PlayerSession {
        label: label.clone(),
        token,
        mode: request.mode,
        app_profile_id: profile_id,
        app_profile_name: profile.profile_name.clone(),
        provider_id: provider_key,
        provider_name: request.provider_name.clone(),
        provider,
        mapped_ott_profile_id: mapping.as_ref().map(|m| m.ott_native_profile_id.clone()),
        provider_has_mappings,
        item: item.clone(),
        awaiting_metadata: false,
        pending_title_change: None,
        active_watch_seconds: 0.0,
        episodes_finished: HashSet::new(),
        last_attribution: None,
        last_notified: None,
        play_start_logged: false,
        last_progress_emit: None,
        final_flush: Arc::new(Notify::new()),
        episode_lookups: HashMap::new(),
    };
    *state.player.lock() = Some(session);

    let window = match build_ott_window(&app, &label, initial_url, &window_title, build_injection(&config), true, profile_id) {
        Ok(w) => w,
        Err(e) => {
            state.player.lock().take();
            return Err(e);
        }
    };

    // User closed the window with the OS close button: finalize just like Back to Hub.
    let app_for_events = app.clone();
    let label_for_events = label.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let app = app_for_events.clone();
            let label = label_for_events.clone();
            tauri::async_runtime::spawn(async move {
                finalize_session(&app, &label, "closed").await;
            });
        }
    });

    let opened = PlayerOpened {
        label,
        mode: request.mode,
        resume_at_seconds: resume_at,
        mapped_ott_profile_id: mapping.map(|m| m.ott_native_profile_id),
        switching_profile: switch_url.is_some(),
    };
    let _ = app.emit_to(MAIN_LABEL, EVT_PLAYER_OPENED, &opened);
    Ok(opened)
}

/// Closes the player if it belongs to `app_profile_id` (used before deleting a profile).
pub async fn close_player_for_profile(app: &AppHandle, app_profile_id: i64) {
    let owned = app.state::<AppState>().player.lock().as_ref().is_some_and(|s| s.app_profile_id == app_profile_id);
    if owned {
        close_active_player(app, "profile_deleted").await;
    }
}

#[tauri::command]
pub async fn close_player(app: AppHandle) -> AppResult<()> {
    back_to_hub(app).await;
    Ok(())
}

#[tauri::command]
pub async fn get_player_status(state: State<'_, AppState>) -> AppResult<Option<PlayerStatus>> {
    Ok(state.player.lock().as_ref().map(PlayerSession::status))
}

/// Binds the player to a title the catalog window identified after an in-app title hop.
#[tauri::command]
pub async fn player_rebind_title(app: AppHandle, state: State<'_, AppState>, request: RebindRequest) -> AppResult<PlayerStatus> {
    if request.media_type != "movie" && request.media_type != "tv" {
        return Err(AppError::Message("mediaType must be 'movie' or 'tv'".into()));
    }
    let status = {
        let mut guard = state.player.lock();
        let session = guard
            .as_mut()
            .filter(|s| s.mode == PlayerMode::Play)
            .ok_or_else(|| AppError::Message("no active player".into()))?;
        let pending = session.pending_title_change.take().unwrap_or_default();
        let mut titles = vec![request.title.clone()];
        titles.extend(request.original_title.clone());
        titles.extend(pending.title.clone());
        let is_tv = request.media_type == "tv";
        let season = request.season_number.or(pending.season_number).filter(|s| *s > 0);
        let episode = request.episode_number.or(pending.episode_number).filter(|e| *e > 0);
        session.item = Some(SessionItem {
            tmdb_id: request.tmdb_id,
            media_type: request.media_type.clone(),
            titles,
            season_number: if is_tv { season.unwrap_or(1) } else { 0 },
            episode_number: if is_tv { episode.unwrap_or(0) } else { 0 },
            episode_title: request.episode_title.clone().or(pending.episode_title),
            direct_url: String::new(),
            last_progress: 0.0,
            last_duration: 0.0,
            episode_confirmed: !is_tv || !session.provider.confirms_episodes() || (season.is_some() && episode.is_some()),
        });
        session.awaiting_metadata = false;
        session.play_start_logged = false;
        session.episodes_finished.clear();
        session.status()
    };
    let _ = app.emit_to(MAIN_LABEL, EVT_PLAYER_OPENED, json!({ "label": status.label, "rebound": true }));
    Ok(status)
}

// ---------------------------------------------------------------------------------------------
// Commands — injected script (remote OTT origin, token-gated)
// ---------------------------------------------------------------------------------------------

fn unauthorized() -> AppError {
    AppError::Message("unauthorized player session".into())
}

#[tauri::command]
pub async fn sync_playback_telemetry(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    mut payload: TelemetryPayload,
) -> AppResult<TelemetryAck> {
    let (provider_id, lookup) = {
        let mut guard = state.player.lock();
        let s = guard
            .as_mut()
            .filter(|s| s.label == window.label() && tokens_equal(&s.token, &payload.token))
            .ok_or_else(unauthorized)?;
        let mut lookup = None;
        if let Some((tmdb_id, name, season_hint)) = episode_lookup_job(s.item.as_ref(), payload.detected.as_ref()) {
            let key = (tmdb_id, name.clone());
            match s.episode_lookups.get(&key).copied() {
                Some(EpisodeLookup::Found(season, episode)) => fill_episode(&mut payload, season, episode),
                Some(EpisodeLookup::Pending) => {}
                Some(EpisodeLookup::Missing(at)) if at.elapsed() < EPISODE_LOOKUP_RETRY => {}
                _ => {
                    s.episode_lookups.insert(key, EpisodeLookup::Pending);
                    lookup = Some((tmdb_id, name, season_hint));
                }
            }
        }
        (s.provider_id, lookup)
    };

    // The player only showed the episode's name: place it with TMDB's season data.
    if let Some((tmdb_id, name, season_hint)) = lookup {
        let found = resolve_episode_by_name(&state, tmdb_id, &name, season_hint).await;
        if let Some((season, episode)) = found {
            log::info!("live telemetry: placed episode by name via TMDB as S{season}E{episode}");
            fill_episode(&mut payload, season, episode);
        }
        if let Some(s) = state.player.lock().as_mut().filter(|s| s.label == window.label()) {
            s.episode_lookups.insert(
                (tmdb_id, name),
                found.map_or(EpisodeLookup::Missing(Instant::now()), |(se, ep)| EpisodeLookup::Found(se, ep)),
            );
        }
    }

    let observed = payload
        .ott_profile
        .as_ref()
        .map(|p| p.id.trim().to_string())
        .filter(|id| !id.is_empty());
    let owner = match observed.clone() {
        Some(id) => state.db.run(move |c| queries::find_app_profile_for_ott(c, provider_id, &id)).await?,
        None => None,
    };

    let (plan, flush, attribution) = {
        let mut guard = state.player.lock();
        let s = guard
            .as_mut()
            .filter(|s| s.label == window.label() && tokens_equal(&s.token, &payload.token))
            .ok_or_else(unauthorized)?;
        let attribution = attribute(
            s.app_profile_id,
            s.mapped_ott_profile_id.as_deref(),
            observed.as_deref(),
            owner,
            s.provider_has_mappings,
        );
        let plan = s.apply(&payload, attribution);
        let flush = (payload.kind == TelemetryKind::Final).then(|| s.final_flush.clone());
        (plan, flush, attribution)
    };

    execute_ops(&state.db, plan.ops).await?;
    for (event, body) in plan.emits {
        let _ = app.emit_to(MAIN_LABEL, event, body);
    }
    if let Some(flush) = flush {
        flush.notify_one();
    }

    let mut ack = plan.ack;
    if matches!(attribution, Attribution::Mismatch | Attribution::OwnedByOther) {
        if let Some(owner_id) = owner {
            ack.owner_profile_name = state
                .db
                .run(move |c| queries::get_profile(c, owner_id))
                .await?
                .map(|p| p.profile_name);
        }
    }
    Ok(ack)
}

fn fill_episode(payload: &mut TelemetryPayload, season: i64, episode: i64) {
    if let Some(d) = payload.detected.as_mut() {
        d.season_number = Some(season);
        d.episode_number = Some(episode);
    }
}

/// Finds (season, episode) for an episode name: the detected season first, then the series.
async fn resolve_episode_by_name(state: &AppState, tmdb_id: i64, name: &str, season_hint: Option<i64>) -> Option<(i64, i64)> {
    let tmdb = match TmdbClient::from_settings(state).await {
        Ok(t) => t,
        Err(e) => {
            log::debug!("episode lookup skipped: {e}");
            return None;
        }
    };
    if let Some(season) = season_hint {
        if let Ok(eps) = tmdb.season_episodes(tmdb_id, season).await {
            if let Some(e) = match_episode_name(&eps, name, |e| e.name.as_str()) {
                return Some((season, e.number));
            }
        }
    }
    match tmdb.series_episodes(tmdb_id).await {
        Ok(all) => match_episode_name(&all, name, |(_, e)| e.name.as_str()).map(|(s, e)| (*s, e.number)),
        Err(e) => {
            log::debug!("episode lookup failed: {e}");
            None
        }
    }
}

#[tauri::command]
pub async fn player_back_to_hub(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>, payload: TokenPayload) -> AppResult<()> {
    {
        let guard = state.player.lock();
        guard
            .as_ref()
            .filter(|s| s.label == window.label() && tokens_equal(&s.token, &payload.token))
            .ok_or_else(unauthorized)?;
    }
    tauri::async_runtime::spawn(back_to_hub(app));
    Ok(())
}

/// Profile handshake. In connect mode the window closes and history import starts; in play mode
/// (pill "Link this profile") the link applies immediately and tracking begins.
#[tauri::command]
pub async fn report_ott_profile(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    payload: ReportProfilePayload,
) -> AppResult<ReportProfileResult> {
    let (app_profile_id, provider_id, provider_name, mode) = {
        let guard = state.player.lock();
        let s = guard
            .as_ref()
            .filter(|s| s.label == window.label() && tokens_equal(&s.token, &payload.token))
            .filter(|s| s.mode == PlayerMode::Connect || s.mapped_ott_profile_id.is_none())
            .ok_or_else(unauthorized)?;
        (s.app_profile_id, s.provider_id, s.provider_name.clone(), s.mode)
    };
    let ott_id = payload.profile.id.trim().to_string();
    if ott_id.is_empty() || ott_id.len() > 256 {
        return Ok(ReportProfileResult { linked: false, message: Some("No profile detected yet.".into()) });
    }
    let ott_name = payload.profile.name.map(|n| n.chars().take(64).collect::<String>());

    let lookup_id = ott_id.clone();
    let owner = state
        .db
        .run(move |c| {
            let owner = queries::find_app_profile_for_ott(c, provider_id, &lookup_id)?;
            Ok(match owner {
                Some(o) if o != app_profile_id => queries::get_profile(c, o)?.map(|p| p.profile_name),
                _ => None,
            })
        })
        .await?;
    if let Some(other) = owner {
        return Ok(ReportProfileResult {
            linked: false,
            message: Some(format!(
                "This {provider_name} profile is already linked to “{other}”. Switch to your own {provider_name} profile first."
            )),
        });
    }

    let mapping = queries::OttProfileMapping {
        app_profile_id,
        provider_id,
        ott_native_profile_id: ott_id.clone(),
        ott_native_profile_name: ott_name.clone(),
    };
    state.db.run(move |c| queries::upsert_ott_mapping(c, &mapping)).await?;
    {
        let mut guard = state.player.lock();
        if let Some(s) = guard.as_mut().filter(|s| s.label == window.label()) {
            s.mapped_ott_profile_id = Some(ott_id.clone());
            s.provider_has_mappings = true;
            s.last_notified = None;
        }
    }
    let importing = mode == PlayerMode::Connect;
    let _ = app.emit_to(
        MAIN_LABEL,
        EVT_PROFILE_CONNECTED,
        json!({
            "appProfileId": app_profile_id,
            "providerId": provider_id,
            "providerName": provider_name,
            "ottProfileId": ott_id,
            "ottProfileName": ott_name,
            "importing": importing,
        }),
    );

    if importing {
        // Close the handshake window shortly after showing the confirmation, then import history.
        let app_bg = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            back_to_hub(app_bg.clone()).await;
            crate::sync::history_importer::spawn_import(app_bg, app_profile_id, provider_id, provider_name);
        });
    }
    Ok(ReportProfileResult { linked: true, message: None })
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn session(media_type: &str, season: i64, episode: i64) -> PlayerSession {
        PlayerSession {
            label: "player-1".into(),
            token: "t".into(),
            mode: PlayerMode::Play,
            app_profile_id: 1,
            app_profile_name: "Aryan".into(),
            provider_id: 8,
            provider_name: "Netflix".into(),
            provider: OttProvider::Netflix,
            mapped_ott_profile_id: Some("GUID-A::Aryan".into()),
            provider_has_mappings: true,
            item: Some(SessionItem {
                tmdb_id: 66732,
                media_type: media_type.into(),
                titles: vec!["Stranger Things".into()],
                season_number: season,
                episode_number: episode,
                episode_title: None,
                direct_url: "https://www.netflix.com/title/80057281".into(),
                last_progress: 0.0,
                last_duration: 0.0,
                episode_confirmed: true,
            }),
            awaiting_metadata: false,
            pending_title_change: None,
            active_watch_seconds: 0.0,
            episodes_finished: HashSet::new(),
            last_attribution: None,
            last_notified: None,
            play_start_logged: false,
            last_progress_emit: None,
            final_flush: Arc::new(Notify::new()),
            episode_lookups: HashMap::new(),
        }
    }

    fn sample(kind: TelemetryKind, t: f64, d: f64, detected: Option<DetectedMedia>) -> TelemetryPayload {
        TelemetryPayload {
            token: "t".into(),
            kind,
            current_time: t,
            duration: d,
            paused: false,
            active_delta_seconds: 3.0,
            seek_from: None,
            page_url: Some("https://www.netflix.com/watch/1".into()),
            url_changed: false,
            detected,
            ott_profile: None,
        }
    }

    fn det(title: &str, s: i64, e: i64) -> DetectedMedia {
        DetectedMedia {
            title: Some(title.into()),
            season_number: (s > 0).then_some(s),
            episode_number: Some(e),
            episode_title: Some(format!("Episode {e}")),
            ott_title_id: None,
            confidence: Confidence::High,
        }
    }

    const REC: Attribution = Attribution::Recording(1);

    #[test]
    fn attribution_is_strict() {
        // Linked profile active -> record.
        assert_eq!(attribute(1, Some("A"), Some("A"), Some(1), true), REC);
        // Another OTT profile (owned or not) while linked -> never recorded, never rerouted.
        assert_eq!(attribute(1, Some("A"), Some("B"), Some(2), true), Attribution::Mismatch);
        assert_eq!(attribute(1, Some("A"), Some("C"), None, true), Attribution::Mismatch);
        // Linked but undetectable -> unverified.
        assert_eq!(attribute(1, Some("A"), None, None, true), Attribution::Unverified);
        // Not linked: someone else's OTT profile -> blocked; unclaimed -> offer link, no writes.
        assert_eq!(attribute(1, None, Some("A"), Some(2), true), Attribution::OwnedByOther);
        assert_eq!(attribute(1, None, Some("C"), None, false), Attribution::Unlinked);
        // Undetectable and nobody linked this provider -> record (no isolation configured).
        assert_eq!(attribute(1, None, None, None, false), REC);
        assert_eq!(attribute(1, None, None, None, true), Attribution::Unverified);
    }

    #[test]
    fn netflix_identity_helpers() {
        assert_eq!(netflix_guid("ABC123::Clara"), "ABC123");
        assert_eq!(netflix_guid("ABC123"), "ABC123");
        assert_eq!(
            OttProvider::Netflix.profile_switch_url("ABC123::Clara").as_deref(),
            Some("https://www.netflix.com/SwitchProfile?tkn=ABC123")
        );
        assert_eq!(OttProvider::PrimeVideo.profile_switch_url("x"), None);
    }

    #[test]
    fn provider_variants_share_one_canonical_id() {
        assert_eq!(canonical_provider_id(2100, "Amazon Prime Video with Ads"), 9);
        assert_eq!(canonical_provider_id(10, "Amazon Video"), 9);
        assert_eq!(canonical_provider_id(119, "Amazon Prime Video"), 9);
        assert_eq!(canonical_provider_id(1796, "Netflix basic with Ads"), 8);
        assert_eq!(canonical_provider_id(0, "Disney+ Hotstar"), 122);
        assert_eq!(canonical_provider_id(4242, "Obscure Flix"), 4242);
        assert_eq!(canonical_provider_id(201, "MUBI Amazon Channel"), 201, "channels aren't Prime Video");
        assert_eq!(canonical_provider_id(1853, "Paramount Plus Apple TV Channel"), 531);
    }

    #[test]
    fn titles_match_handles_variants() {
        assert!(titles_match("Stranger Things", "STRANGER THINGS"));
        assert!(titles_match("RRR", "RRR (Hindi)"));
        assert!(titles_match("The Office", ""));
        assert!(!titles_match("Stranger Things", "The Crown"));
    }

    #[test]
    fn progress_is_recorded_and_ads_ignored() {
        let mut s = session("tv", 1, 1);
        let plan = s.apply(&sample(TelemetryKind::Progress, 12.0, 30.0, None), REC);
        assert!(!plan.ops.iter().any(|o| matches!(o, DbOp::Progress(_))), "30s media is an ad/bumper");
        let plan = s.apply(&sample(TelemetryKind::Progress, 600.0, 3000.0, None), REC);
        match &plan.ops[0] {
            DbOp::Progress(u) => {
                assert_eq!(u.app_profile_id, 1);
                assert_eq!((u.season_number, u.episode_number), (1, 1));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(plan.ack.attribution, "recording");
    }

    #[test]
    fn unverified_states_write_nothing_anywhere() {
        for attribution in [Attribution::Mismatch, Attribution::OwnedByOther, Attribution::Unlinked, Attribution::Unverified] {
            let mut s = session("movie", 0, 0);
            let plan = s.apply(&sample(TelemetryKind::Ended, 5900.0, 6000.0, None), attribution);
            assert!(plan.ops.is_empty(), "{attribution:?} must not write");
            assert!(!plan.ack.accepted);
            assert!(s.finalize_ops().is_empty());
        }
    }

    #[test]
    fn guessed_episode_is_never_recorded_until_confirmed() {
        // Friends S2E1: launched with a guessed S1E1; provider reports the real episode later.
        let mut s = session("tv", 1, 1);
        s.item.as_mut().unwrap().titles = vec!["Friends".into()];
        s.item.as_mut().unwrap().episode_confirmed = false;
        let plan = s.apply(&sample(TelemetryKind::Progress, 120.0, 1320.0, None), REC);
        assert!(!plan.ops.iter().any(|o| matches!(o, DbOp::Progress(_))), "unconfirmed episode must not be written");
        // Episode number without a season is still not enough.
        let plan = s.apply(&sample(TelemetryKind::Progress, 123.0, 1320.0, Some(det("Friends", 0, 1))), REC);
        assert!(!plan.ops.iter().any(|o| matches!(o, DbOp::Progress(_))));
        let plan = s.apply(&sample(TelemetryKind::Progress, 126.0, 1320.0, Some(det("Friends", 2, 1))), REC);
        assert!(plan.ops.iter().any(|o| matches!(o, DbOp::Progress(u) if (u.season_number, u.episode_number) == (2, 1))));
        assert!(!plan.ops.iter().any(|o| matches!(o, DbOp::Event { event_type: "episode_hop", .. })), "a guess isn't a hop");
    }

    #[test]
    fn episode_name_only_detection_needs_a_tmdb_lookup() {
        let mut s = session("tv", 1, 24);
        s.item.as_mut().unwrap().titles = vec!["Friends".into()];
        let name_only = DetectedMedia {
            title: Some("Friends".into()),
            season_number: None,
            episode_number: None,
            episode_title: Some("The One with the Breast Milk".into()),
            ott_title_id: Some("70274078".into()),
            confidence: Confidence::High,
        };
        let job = episode_lookup_job(s.item.as_ref(), Some(&name_only)).expect("lookup needed");
        assert_eq!(job, (s.item.as_ref().unwrap().tmdb_id, "the one with the breast milk".into(), None));
        // Numbers already known, another title, or the "episode name" is just the series name: no lookup.
        assert!(episode_lookup_job(s.item.as_ref(), Some(&det("Friends", 2, 2))).is_none());
        let other = DetectedMedia { title: Some("Dark".into()), ..name_only.clone() };
        assert!(episode_lookup_job(s.item.as_ref(), Some(&other)).is_none());
        let series_only = DetectedMedia { episode_title: Some("Friends".into()), ..name_only.clone() };
        assert!(episode_lookup_job(s.item.as_ref(), Some(&series_only)).is_none());

        // Once the lookup fills the numbers, the hop from S1E24 to S2E2 is tracked.
        let mut payload = sample(TelemetryKind::Progress, 60.0, 1320.0, Some(name_only));
        fill_episode(&mut payload, 2, 2);
        let plan = s.apply(&payload, REC);
        assert!(plan.ops.iter().any(|o| matches!(o, DbOp::Progress(u) if (u.season_number, u.episode_number) == (2, 2))));
    }

    #[test]
    fn episode_hop_completes_previous_and_tracks_new() {
        let mut s = session("tv", 1, 3);
        s.apply(&sample(TelemetryKind::Progress, 2900.0, 3000.0, Some(det("Stranger Things", 1, 3))), REC);
        let plan = s.apply(&sample(TelemetryKind::Metadata, 5.0, 3100.0, Some(det("Stranger Things", 1, 4))), REC);
        assert!(plan.ops.iter().any(|o| matches!(o, DbOp::Complete { episode: 3, .. })));
        assert!(plan.ops.iter().any(|o| matches!(o, DbOp::Event { event_type: "episode_hop", .. })));
        assert!(plan.ops.iter().any(|o| matches!(o, DbOp::Progress(u) if u.episode_number == 4)));
    }

    #[test]
    fn binge_session_after_three_episodes() {
        let mut s = session("tv", 1, 1);
        for ep in 1..=3 {
            s.apply(&sample(TelemetryKind::Progress, 2900.0, 3000.0, Some(det("Stranger Things", 1, ep))), REC);
        }
        let ops = s.finalize_ops();
        assert!(ops.iter().any(|o| matches!(o, DbOp::Event { event_type: "binge_session", .. })));
    }

    #[test]
    fn title_hop_suspends_until_rebind() {
        let mut s = session("tv", 1, 1);
        let plan = s.apply(&sample(TelemetryKind::Metadata, 5.0, 6000.0, Some(det("The Crown", 1, 1))), REC);
        assert!(plan.emits.iter().any(|(e, _)| *e == EVT_TITLE_CHANGED));
        assert!(s.item.is_none());
        let plan = s.apply(&sample(TelemetryKind::Progress, 60.0, 6000.0, None), REC);
        assert!(plan.ops.is_empty());
        assert_eq!(plan.ack.attribution, "suspended");
    }

    #[test]
    fn url_change_without_metadata_suspends_writes() {
        let mut s = session("tv", 1, 1);
        let mut p = sample(TelemetryKind::Progress, 60.0, 3000.0, None);
        p.url_changed = true;
        let plan = s.apply(&p, REC);
        assert!(plan.ops.is_empty());
        let plan = s.apply(&sample(TelemetryKind::Progress, 63.0, 3000.0, Some(det("Stranger Things", 1, 2))), REC);
        assert!(plan.ops.iter().any(|o| matches!(o, DbOp::Progress(u) if u.episode_number == 2)));
    }

    #[test]
    fn provider_detection() {
        assert_eq!(OttProvider::detect(8, "Netflix"), OttProvider::Netflix);
        assert_eq!(OttProvider::detect(0, "Disney+ Hotstar"), OttProvider::Hotstar);
        assert_eq!(OttProvider::detect(119, "Amazon Prime Video"), OttProvider::PrimeVideo);
        assert_eq!(OttProvider::detect(0, "Obscure"), OttProvider::Generic);
    }
}
