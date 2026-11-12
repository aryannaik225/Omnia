//! Native WebView2 Smart Player manager.
//!
//! Spawns a dedicated player `WebviewWindow` pointed at the resolved OTT deep link, injects the
//! `<video>` telemetry observer, and turns its 3-second samples into `watch_history` /
//! `playback_events` rows **for the correct Omnia profile**.
//!
//! Profile isolation: each sample carries the OTT's native profile id (Netflix `guid`, Prime
//! `profileId`, ...). It is resolved through `ott_profile_mappings`:
//!   * mapped to the session's profile         -> recorded to the session profile
//!   * mapped to a *different* Omnia profile    -> rerouted to that profile (it's their viewing)
//!   * unmapped while the session profile has a different mapping for this provider
//!                                              -> rejected (never guess; nothing is written)
//!   * not detectable / no mappings exist       -> recorded to the session profile
//!
//! Security: player windows load third-party pages. Their IPC is restricted by the `player`
//! capability (remote OTT origins only, four telemetry commands only), and every call must carry
//! the per-session random token that only the injected script knows.

use std::collections::HashSet;
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
use crate::{AppError, AppResult, AppState};

const TELEMETRY_SCRIPT: &str = include_str!("telemetry_injector.js");

pub const PLAYER_LABEL_PREFIX: &str = "player-";
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
pub const EVT_PROFILE_REROUTED: &str = "omnia://ott-profile-rerouted";
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
    /// Matches by TMDB/JustWatch provider id first, then by name.
    pub fn detect(provider_id: i64, provider_name: &str) -> Self {
        use OttProvider::*;
        let n = provider_name.to_lowercase();
        let has = |s: &str| n.contains(s);
        if matches!(provider_id, 8 | 175 | 1796) || has("netflix") {
            Netflix
        } else if matches!(provider_id, 122 | 220 | 2336) || has("hotstar") || has("jiocinema") {
            Hotstar
        } else if matches!(provider_id, 9 | 10 | 119 | 2100) || has("prime video") || has("amazon") {
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
        } else if provider_id == 531 || has("paramount") {
            ParamountPlus
        } else if provider_id == 283 || has("crunchyroll") {
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
    /// `session` | `rerouted` | `rejected` | `suspended`
    pub attribution: &'static str,
    pub profile_id: Option<i64>,
    pub profile_name: Option<String>,
    pub message: Option<String>,
}

impl TelemetryAck {
    fn suspended(message: Option<String>) -> Self {
        Self { accepted: false, attribution: "suspended", profile_id: None, profile_name: None, message }
    }
}

impl Default for TelemetryAck {
    fn default() -> Self {
        Self::suspended(None)
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
}

// ---------------------------------------------------------------------------------------------
// Profile attribution (pure, unit-tested)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attribution {
    Session(i64),
    Rerouted(i64),
    Rejected,
}

/// Decides which Omnia profile a telemetry sample belongs to. See the module docs for the rules.
pub fn attribute(
    session_profile: i64,
    session_mapping: Option<&str>,
    observed: Option<&str>,
    owner_of_observed: Option<i64>,
) -> Attribution {
    let Some(observed) = observed else {
        return Attribution::Session(session_profile);
    };
    match owner_of_observed {
        Some(owner) if owner == session_profile => Attribution::Session(session_profile),
        Some(owner) => Attribution::Rerouted(owner),
        None => match session_mapping {
            Some(mapped) if mapped != observed => Attribution::Rejected,
            _ => Attribution::Session(session_profile),
        },
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
    provider_id: i64,
    provider_name: String,
    mapped_ott_profile_id: Option<String>,
    item: Option<SessionItem>,
    awaiting_metadata: bool,
    pending_title_change: Option<DetectedMedia>,
    active_watch_seconds: f64,
    episodes_finished: HashSet<(i64, i64)>,
    last_attribution: Option<Attribution>,
    notified_mismatch: bool,
    last_progress_emit: Option<Instant>,
    final_flush: Arc<Notify>,
}

impl PlayerSession {
    fn target_profile(&self) -> Option<i64> {
        match self.last_attribution {
            Some(Attribution::Rejected) => None,
            Some(Attribution::Session(p)) | Some(Attribution::Rerouted(p)) => Some(p),
            None => Some(self.app_profile_id),
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
        }
    }

    /// Applies one telemetry sample and returns the DB writes / UI events it implies.
    fn apply(&mut self, p: &TelemetryPayload, attribution: Attribution) -> Plan {
        let mut plan = Plan::default();
        if self.mode != PlayerMode::Play {
            return plan;
        }

        let target = match attribution {
            Attribution::Rejected => {
                if !self.notified_mismatch {
                    self.notified_mismatch = true;
                    plan.emits.push((
                        EVT_PROFILE_MISMATCH,
                        json!({
                            "appProfileId": self.app_profile_id,
                            "providerId": self.provider_id,
                            "providerName": self.provider_name,
                            "expectedOttProfileId": self.mapped_ott_profile_id,
                            "observedOttProfileName": p.ott_profile.as_ref().and_then(|o| o.name.clone()),
                        }),
                    ));
                }
                self.last_attribution = Some(attribution);
                plan.ack = TelemetryAck {
                    accepted: false,
                    attribution: "rejected",
                    profile_id: None,
                    profile_name: None,
                    message: Some(format!(
                        "Not tracking: this {} profile isn't linked to {}",
                        self.provider_name, self.app_profile_name
                    )),
                };
                return plan;
            }
            Attribution::Session(id) | Attribution::Rerouted(id) => id,
        };
        if matches!(attribution, Attribution::Rerouted(_)) && self.last_attribution != Some(attribution) {
            plan.emits.push((
                EVT_PROFILE_REROUTED,
                json!({ "fromAppProfileId": self.app_profile_id, "toAppProfileId": target, "providerName": self.provider_name }),
            ));
        }
        self.last_attribution = Some(attribution);
        if p.active_delta_seconds.is_finite() {
            self.active_watch_seconds += p.active_delta_seconds.clamp(0.0, 30.0);
        }

        // --- metadata: episode hops & title hops -------------------------------------------
        if p.url_changed && p.detected.is_none() {
            // In-app navigation happened and the new item isn't identified yet: write nothing
            // rather than risk attributing the next episode's progress to the previous one.
            self.awaiting_metadata = true;
        }
        if let Some(d) = &p.detected {
            self.awaiting_metadata = false;
            if self.apply_detection(d, target, &mut plan) {
                plan.ack = TelemetryAck::suspended(Some("Identifying the new title…".to_string()));
                return plan;
            }
        }
        if self.awaiting_metadata || self.item.is_none() {
            plan.ack = TelemetryAck::suspended(None);
            return plan;
        }

        // --- progress ------------------------------------------------------------------------
        let provider_name = self.provider_name.clone();
        let item = self.item.as_mut().expect("checked above");
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
                direct_url: page_url.or_else(|| Some(item.direct_url.clone())),
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

        plan.ack = TelemetryAck {
            accepted: true,
            attribution: if matches!(attribution, Attribution::Rerouted(_)) { "rerouted" } else { "session" },
            profile_id: Some(target),
            profile_name: None,
            message: None,
        };
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
                    "appProfileId": target,
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
                let season = d.season_number.filter(|s| *s > 0).unwrap_or(item.season_number.max(1));
                if (season, ep) != (item.season_number, item.episode_number) {
                    if item.episode_number > 0 {
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
                    return false;
                }
            }
        }
        if item.episode_title.is_none() {
            item.episode_title = d.episode_title.clone();
        }
        false
    }

    /// Writes performed when the session ends (window closed / Back to Hub / replaced).
    fn finalize_ops(&self) -> Vec<DbOp> {
        let (Some(profile), Some(item)) = (self.target_profile(), self.item.as_ref()) else {
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

/// Builds a WebView2 window for third-party OTT content with the telemetry script injected.
/// Non-HTTPS navigations (http downgrades, `nflx://`-style app hand-offs) are blocked.
pub(crate) fn build_ott_window(
    app: &AppHandle,
    label: &str,
    url: tauri::Url,
    title: &str,
    script: String,
    visible: bool,
) -> AppResult<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
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
    // New telemetry: let this profile's (and any rerouted profile's) recommendations refresh.
    state.recommender.invalidate(session.app_profile_id);
    if let Some(target) = session.target_profile() {
        state.recommender.invalidate(target);
    }
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
    let region = match request.region.clone() {
        Some(r) => r,
        None => state
            .db
            .run(|c| queries::get_setting(c, queries::keys::REGION_CODE))
            .await?
            .unwrap_or_else(|| "US".into()),
    };

    // Validate the request and work out the item being played.
    let (url, item, window_title) = match request.mode {
        PlayerMode::Play => {
            let tmdb_id = request.tmdb_id.ok_or_else(|| AppError::Message("tmdbId is required to play".into()))?;
            let media_type = request.media_type.clone().unwrap_or_default();
            if media_type != "movie" && media_type != "tv" {
                return Err(AppError::Message("mediaType must be 'movie' or 'tv'".into()));
            }
            let title = request.title.clone().filter(|t| !t.trim().is_empty())
                .ok_or_else(|| AppError::Message("title is required to play".into()))?;
            let direct_url = request.direct_url.clone()
                .ok_or_else(|| AppError::Message("directUrl is required to play".into()))?;
            let url = parse_https_url(&direct_url)?;
            let mut titles = vec![title.clone()];
            titles.extend(request.original_title.clone().filter(|t| !t.trim().is_empty()));
            let (season, episode) = if media_type == "tv" {
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

    let provider_id = request.provider_id;
    let mapping = state
        .db
        .run(move |c| queries::get_ott_mapping(c, profile_id, provider_id))
        .await?;

    // Only one player at a time: flush & destroy the previous one first.
    close_active_player(&app, "replaced").await;

    let label = next_window_label(PLAYER_LABEL_PREFIX);
    let token = random_token();
    let config = json!({
        "token": token,
        "mode": request.mode,
        "provider": provider.key(),
        "providerId": request.provider_id,
        "providerName": request.provider_name,
        "appProfileName": profile.profile_name,
        "title": item.as_ref().and_then(|i| i.titles.first().cloned()),
        "resumeAtSeconds": resume_at.unwrap_or(0.0),
        "syncIntervalMs": SYNC_INTERVAL_MS,
    });

    let session = PlayerSession {
        label: label.clone(),
        token,
        mode: request.mode,
        app_profile_id: profile_id,
        app_profile_name: profile.profile_name.clone(),
        provider_id: request.provider_id,
        provider_name: request.provider_name.clone(),
        mapped_ott_profile_id: mapping.as_ref().map(|m| m.ott_native_profile_id.clone()),
        item: item.clone(),
        awaiting_metadata: false,
        pending_title_change: None,
        active_watch_seconds: 0.0,
        episodes_finished: HashSet::new(),
        last_attribution: None,
        notified_mismatch: false,
        last_progress_emit: None,
        final_flush: Arc::new(Notify::new()),
    };
    *state.player.lock() = Some(session);

    let window = match build_ott_window(&app, &label, url, &window_title, build_injection(&config), true) {
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

    if let Some(it) = &item {
        let (tmdb_id, mt) = (it.tmdb_id, it.media_type.clone());
        state
            .db
            .run(move |c| queries::insert_playback_event(c, profile_id, tmdb_id, &mt, "play_start", 0.0))
            .await?;
    }
    let opened = PlayerOpened {
        label,
        mode: request.mode,
        resume_at_seconds: resume_at,
        mapped_ott_profile_id: mapping.map(|m| m.ott_native_profile_id),
    };
    let _ = app.emit_to(MAIN_LABEL, EVT_PLAYER_OPENED, &opened);
    Ok(opened)
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
    let (status, profile) = {
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
        session.item = Some(SessionItem {
            tmdb_id: request.tmdb_id,
            media_type: request.media_type.clone(),
            titles,
            season_number: if is_tv { request.season_number.or(pending.season_number).unwrap_or(1) } else { 0 },
            episode_number: if is_tv { request.episode_number.or(pending.episode_number).unwrap_or(0) } else { 0 },
            episode_title: request.episode_title.clone().or(pending.episode_title),
            direct_url: String::new(),
            last_progress: 0.0,
            last_duration: 0.0,
        });
        session.awaiting_metadata = false;
        session.episodes_finished.clear();
        (session.status(), session.target_profile())
    };
    if let Some(profile) = profile {
        let (tmdb_id, mt) = (request.tmdb_id, request.media_type.clone());
        state
            .db
            .run(move |c| queries::insert_playback_event(c, profile, tmdb_id, &mt, "play_start", 0.0))
            .await?;
    }
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
    payload: TelemetryPayload,
) -> AppResult<TelemetryAck> {
    let provider_id = {
        let guard = state.player.lock();
        let s = guard
            .as_ref()
            .filter(|s| s.label == window.label() && tokens_equal(&s.token, &payload.token))
            .ok_or_else(unauthorized)?;
        s.provider_id
    };

    let observed = payload
        .ott_profile
        .as_ref()
        .map(|p| p.id.trim().to_string())
        .filter(|id| !id.is_empty());
    let owner = match observed.clone() {
        Some(id) => state.db.run(move |c| queries::find_app_profile_for_ott(c, provider_id, &id)).await?,
        None => None,
    };

    let (plan, flush) = {
        let mut guard = state.player.lock();
        let s = guard
            .as_mut()
            .filter(|s| s.label == window.label() && tokens_equal(&s.token, &payload.token))
            .ok_or_else(unauthorized)?;
        let attribution = attribute(s.app_profile_id, s.mapped_ott_profile_id.as_deref(), observed.as_deref(), owner);
        let plan = s.apply(&payload, attribution);
        let flush = (payload.kind == TelemetryKind::Final).then(|| s.final_flush.clone());
        (plan, flush)
    };

    execute_ops(&state.db, plan.ops).await?;
    for (event, body) in plan.emits {
        let _ = app.emit_to(MAIN_LABEL, event, body);
    }
    if let Some(flush) = flush {
        flush.notify_one();
    }

    let mut ack = plan.ack;
    if ack.attribution == "rerouted" {
        if let Some(pid) = ack.profile_id {
            ack.profile_name = state
                .db
                .run(move |c| queries::get_profile(c, pid))
                .await?
                .map(|p| p.profile_name);
        }
    }
    Ok(ack)
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

/// Profile handshake: the user confirmed which OTT profile belongs to the active Omnia profile.
#[tauri::command]
pub async fn report_ott_profile(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    payload: ReportProfilePayload,
) -> AppResult<ReportProfileResult> {
    let (app_profile_id, provider_id, provider_name) = {
        let guard = state.player.lock();
        let s = guard
            .as_ref()
            .filter(|s| s.mode == PlayerMode::Connect && s.label == window.label() && tokens_equal(&s.token, &payload.token))
            .ok_or_else(unauthorized)?;
        (s.app_profile_id, s.provider_id, s.provider_name.clone())
    };
    let ott_id = payload.profile.id.trim().to_string();
    if ott_id.is_empty() || ott_id.len() > 128 {
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
        }
    }
    let _ = app.emit_to(
        MAIN_LABEL,
        EVT_PROFILE_CONNECTED,
        json!({
            "appProfileId": app_profile_id,
            "providerId": provider_id,
            "providerName": provider_name,
            "ottProfileId": ott_id,
            "ottProfileName": ott_name,
        }),
    );

    // Close the handshake window shortly after showing the confirmation, then import history.
    let app_bg = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        back_to_hub(app_bg.clone()).await;
        crate::sync::history_importer::spawn_import(app_bg, app_profile_id, provider_id, provider_name);
    });
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
            mapped_ott_profile_id: Some("GUID-A".into()),
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
            }),
            awaiting_metadata: false,
            pending_title_change: None,
            active_watch_seconds: 0.0,
            episodes_finished: HashSet::new(),
            last_attribution: None,
            notified_mismatch: false,
            last_progress_emit: None,
            final_flush: Arc::new(Notify::new()),
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
            season_number: Some(s),
            episode_number: Some(e),
            episode_title: None,
            ott_title_id: None,
            confidence: Confidence::High,
        }
    }

    #[test]
    fn attribution_rules() {
        // Not detectable -> session profile.
        assert_eq!(attribute(1, Some("A"), None, None), Attribution::Session(1));
        // Mapped to this profile.
        assert_eq!(attribute(1, Some("A"), Some("A"), Some(1)), Attribution::Session(1));
        // Mapped to another family member -> their history, not ours.
        assert_eq!(attribute(1, Some("A"), Some("B"), Some(2)), Attribution::Rerouted(2));
        // Unmapped profile while we're mapped elsewhere -> never guess.
        assert_eq!(attribute(1, Some("A"), Some("C"), None), Attribution::Rejected);
        // No mapping at all yet -> session profile.
        assert_eq!(attribute(1, None, Some("C"), None), Attribution::Session(1));
    }

    #[test]
    fn titles_match_handles_variants() {
        assert!(titles_match("Stranger Things", "STRANGER THINGS"));
        assert!(titles_match("RRR", "RRR (Hindi)"));
        assert!(titles_match("The Office", ""));
        assert!(!titles_match("Stranger Things", "The Crown"));
    }

    #[test]
    fn progress_is_recorded_for_target_profile_and_ads_ignored() {
        let mut s = session("tv", 1, 1);
        let plan = s.apply(&sample(TelemetryKind::Progress, 12.0, 30.0, None), Attribution::Session(1));
        assert!(plan.ops.is_empty(), "30s media is an ad/bumper");
        let plan = s.apply(&sample(TelemetryKind::Progress, 600.0, 3000.0, None), Attribution::Rerouted(2));
        match &plan.ops[0] {
            DbOp::Progress(u) => {
                assert_eq!(u.app_profile_id, 2);
                assert_eq!((u.season_number, u.episode_number), (1, 1));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(plan.ack.attribution, "rerouted");
    }

    #[test]
    fn rejected_samples_write_nothing() {
        let mut s = session("movie", 0, 0);
        let plan = s.apply(&sample(TelemetryKind::Progress, 600.0, 6000.0, None), Attribution::Rejected);
        assert!(plan.ops.is_empty());
        assert_eq!(plan.ack.attribution, "rejected");
        assert_eq!(plan.emits.len(), 1);
        assert!(s.finalize_ops().is_empty());
    }

    #[test]
    fn episode_hop_completes_previous_and_tracks_new() {
        let mut s = session("tv", 1, 3);
        s.apply(&sample(TelemetryKind::Progress, 2900.0, 3000.0, Some(det("Stranger Things", 1, 3))), Attribution::Session(1));
        let plan = s.apply(&sample(TelemetryKind::Metadata, 5.0, 3100.0, Some(det("Stranger Things", 1, 4))), Attribution::Session(1));
        assert!(plan.ops.iter().any(|o| matches!(o, DbOp::Complete { episode: 3, .. })));
        assert!(plan.ops.iter().any(|o| matches!(o, DbOp::Event { event_type: "episode_hop", .. })));
        assert!(plan.ops.iter().any(|o| matches!(o, DbOp::Progress(u) if u.episode_number == 4)));
    }

    #[test]
    fn binge_session_after_three_episodes() {
        let mut s = session("tv", 1, 1);
        for ep in 1..=3 {
            s.apply(&sample(TelemetryKind::Progress, 2900.0, 3000.0, Some(det("Stranger Things", 1, ep))), Attribution::Session(1));
        }
        let ops = s.finalize_ops();
        assert!(ops.iter().any(|o| matches!(o, DbOp::Event { event_type: "binge_session", .. })));
    }

    #[test]
    fn title_hop_suspends_until_rebind() {
        let mut s = session("tv", 1, 1);
        let plan = s.apply(&sample(TelemetryKind::Metadata, 5.0, 6000.0, Some(det("The Crown", 1, 1))), Attribution::Session(1));
        assert!(plan.emits.iter().any(|(e, _)| *e == EVT_TITLE_CHANGED));
        assert!(s.item.is_none());
        let plan = s.apply(&sample(TelemetryKind::Progress, 60.0, 6000.0, None), Attribution::Session(1));
        assert!(plan.ops.is_empty());
        assert_eq!(plan.ack.attribution, "suspended");
    }

    #[test]
    fn url_change_without_metadata_suspends_writes() {
        let mut s = session("tv", 1, 1);
        let mut p = sample(TelemetryKind::Progress, 60.0, 3000.0, None);
        p.url_changed = true;
        let plan = s.apply(&p, Attribution::Session(1));
        assert!(plan.ops.is_empty());
        let plan = s.apply(&sample(TelemetryKind::Progress, 63.0, 3000.0, Some(det("Stranger Things", 1, 2))), Attribution::Session(1));
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
