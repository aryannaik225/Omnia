//! Optional two-way cloud sync with Supabase (Settings → "Sign in to Sync"; off by default).
//!
//! Local-first stays the rule: SQLite is the source of truth for the app, nothing here runs and
//! no request leaves the PC until the user signs in, and signing out stops it again.
//!
//! **What syncs** (one local profile, the one that signed in): watchlist entries, completed
//! movies and completed episodes (ids, timestamps, runtime), including completions recorded
//! by the OTT player / history importer, plus the profile's name and picture (a 256×256 WebP
//! URL in Storage). **What never syncs:** OTT cookies and sessions, playback telemetry, taste
//! vectors, the metadata cache, other profiles.
//!
//! **How**: SQLite triggers (migration v9) record which item changed and when in
//! `cloud_outbox`. A sync pushes each outbox item's *current* state (present → upsert,
//! absent → tombstone) with that time as `updated_at`; the server keeps whichever write is
//! newest (supabase/schema.sql). It then pulls every row the server stamped (`synced_at`)
//! since the last pull and applies it unless a newer local change is still waiting.
//!
//! Tokens: the refresh token is kept in local settings (never shown to the UI or LAN devices),
//! the access token only in memory. Supabase is reached with the public anon key compiled in
//! by `build.rs` plus the user's own JWT; Row Level Security limits every row to that user.

use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::db::queries;
use crate::{AppError, AppResult, AppState};

/// Public project URL and anon / publishable key, compiled in by `build.rs` (empty = no cloud sync in this build).
pub const SUPABASE_URL: &str = env!("OMNIA_SUPABASE_URL");
pub const SUPABASE_ANON_KEY: &str = env!("OMNIA_SUPABASE_ANON_KEY");

/// Google sign-in returns here (add it to Supabase → Authentication → URL Configuration).
pub const OAUTH_PORT: u16 = 54365;
pub const OAUTH_REDIRECT: &str = "http://127.0.0.1:54365/auth/callback";

pub const EVT_CLOUD_SYNC: &str = "omnia://cloud-sync";

/// Settings keys. All `cloud_` keys are hidden from the UI and from LAN devices.
pub mod keys {
    pub const PREFIX: &str = "cloud_";
    pub const REFRESH_TOKEN: &str = "cloud_refresh_token";
    pub const USER_ID: &str = "cloud_user_id";
    pub const EMAIL: &str = "cloud_user_email";
    /// Must match the triggers in migrations/009_cloud_sync.sql.
    pub const PROFILE_ID: &str = "cloud_sync_profile_id";
    pub const CURSOR_PREFIX: &str = "cloud_cursor_";
    pub const LAST_SYNC: &str = "cloud_last_sync_at";
    pub const LAST_ERROR: &str = "cloud_last_error";
    pub const PROFILE_SIG: &str = "cloud_profile_sig";
    pub const PROFILE_SEEN: &str = "cloud_profile_seen_at";
    /// Last Home row order synced (its own LWW signature, separate from name / picture).
    pub const HOME_ORDER_SIG: &str = "cloud_home_order_sig";
}

/// The profile's Home row order setting (a JSON array of row ids). Must match
/// src/store/useAppStore.ts → homeOrderKey.
pub fn home_order_key(profile_id: i64) -> String {
    format!("home_row_order_p{profile_id}")
}

/// A stored / synced Home row order as canonical JSON (strings only, at most 100 short ids).
fn canonical_order(v: &Value) -> Option<String> {
    let ids: Vec<&str> = v.as_array()?.iter().filter_map(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 64).take(100).collect();
    serde_json::to_string(&ids).ok()
}

const CHUNK: usize = 500;
const PAGE: usize = 1000;
/// Pull window overlap: rows committed slightly out of order are still picked up.
const PULL_OVERLAP: chrono::Duration = chrono::Duration::seconds(10);
/// Background: look for pending local changes this often; pull at least every `FULL_EVERY`.
const TICK: Duration = Duration::from_secs(20);
const FULL_EVERY: Duration = Duration::from_secs(120);
const WAKE_DEBOUNCE: Duration = Duration::from_secs(30);
/// Pulled watches older than this are stored as silent history (not on Continue Watching).
const LIVE_WINDOW_DAYS: i64 = 7;
const MAX_AVATAR_BYTES: usize = 600 * 1024;

pub fn configured() -> bool {
    SUPABASE_URL.starts_with("https://") && !SUPABASE_ANON_KEY.trim().is_empty()
}

fn base() -> &'static str {
    SUPABASE_URL.trim_end_matches('/')
}

fn err(msg: impl Into<String>) -> AppError {
    AppError::Message(msg.into())
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

struct Session {
    access_token: String,
    expires_at: Instant,
    user_id: String,
}

#[derive(Default)]
pub struct CloudSync {
    session: StdMutex<Option<Session>>,
    /// One sync (or sign-in / sign-out) at a time.
    run: Mutex<()>,
    /// One Google browser flow at a time.
    oauth: Mutex<()>,
    last_run: StdMutex<Option<Instant>>,
}

impl CloudSync {
    fn cached_token(&self) -> Option<(String, String)> {
        let s = self.session.lock().ok()?;
        s.as_ref()
            .filter(|s| s.expires_at > Instant::now() + Duration::from_secs(60))
            .map(|s| (s.access_token.clone(), s.user_id.clone()))
    }
    fn set_session(&self, s: Option<Session>) {
        if let Ok(mut g) = self.session.lock() {
            *g = s;
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    /// This build has Supabase credentials.
    pub configured: bool,
    pub signed_in: bool,
    pub email: Option<String>,
    /// The local profile synced with the account.
    pub profile_id: Option<i64>,
    pub profile_name: Option<String>,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    /// Local changes not yet uploaded.
    pub pending: i64,
    pub google_redirect: &'static str,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: usize,
    /// Changes from other devices applied locally.
    pub applied: usize,
    pub profile_updated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignUpResult {
    /// False when Supabase wants the e-mail confirmed first.
    pub signed_in: bool,
    pub status: CloudStatus,
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// RFC 3339 (Postgres / outbox) or SQLite `YYYY-MM-DD HH:MM:SS` (UTC).
fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    for f in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, f) {
            return Some(n.and_utc());
        }
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0)).map(|n| n.and_utc())
}

fn to_iso(s: Option<&str>) -> String {
    s.and_then(parse_ts).map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true)).unwrap_or_else(now_iso)
}

fn to_sqlite(d: DateTime<Utc>) -> String {
    d.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn b64url(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(T[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(T[n as usize & 63] as char);
        }
    }
    out
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    };
    let clean: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=').collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

fn random_token() -> String {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b).expect("OS random number generator unavailable");
    b64url(&b)
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// GoTrue / PostgREST / Storage error text (never includes request bodies or tokens).
async fn api_error(resp: reqwest::Response, what: &str) -> AppError {
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    let text = ["error_description", "msg", "message", "error"]
        .iter()
        .find_map(|k| body.get(*k).and_then(Value::as_str))
        .map(str::to_string);
    match (status.as_u16(), text) {
        (_, Some(t)) => err(format!("{what}: {t}")),
        (401 | 403, None) => err(format!("{what}: not authorised (HTTP {status})")),
        (_, None) => err(format!("{what} failed (HTTP {status})")),
    }
}

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
    user: AuthUser,
}

#[derive(Deserialize)]
struct AuthUser {
    id: String,
    #[serde(default)]
    email: Option<String>,
}

fn require_configured() -> AppResult<()> {
    if configured() {
        Ok(())
    } else {
        Err(err("Cloud sync isn't set up in this build (SUPABASE_URL / SUPABASE_ANON_KEY)."))
    }
}

async fn gotrue(state: &AppState, path: &str, body: Value, what: &str) -> AppResult<Value> {
    let resp = state
        .http
        .post(format!("{}/auth/v1{path}", base()))
        .header("apikey", SUPABASE_ANON_KEY)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error(resp, what).await);
    }
    Ok(resp.json().await?)
}

fn token_from(v: Value) -> AppResult<TokenResponse> {
    serde_json::from_value(v).map_err(|_| err("Unexpected sign-in response from Supabase."))
}

/// Stores a fresh session and links the account to `profile_id` (re-linking starts a full merge).
async fn link_session(state: &AppState, tok: TokenResponse, profile_id: i64) -> AppResult<()> {
    let user_id = tok.user.id.clone();
    let email = tok.user.email.clone().unwrap_or_default();
    let refresh = tok.refresh_token.clone();
    state.cloud.set_session(Some(Session {
        access_token: tok.access_token,
        expires_at: Instant::now() + Duration::from_secs(tok.expires_in.unwrap_or(3600)),
        user_id: user_id.clone(),
    }));
    state
        .db
        .run(move |c| {
            queries::get_profile(c, profile_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            let tx = c.transaction()?;
            let prev_user = queries::get_setting(&tx, keys::USER_ID)?;
            let prev_profile = queries::get_setting(&tx, keys::PROFILE_ID)?;
            let relink = prev_user.as_deref() != Some(user_id.as_str()) || prev_profile.as_deref() != Some(profile_id.to_string().as_str());
            queries::set_setting(&tx, keys::REFRESH_TOKEN, &refresh)?;
            queries::set_setting(&tx, keys::USER_ID, &user_id)?;
            queries::set_setting(&tx, keys::EMAIL, &email)?;
            if relink {
                tx.execute("DELETE FROM app_settings WHERE key LIKE 'cloud\\_cursor\\_%' ESCAPE '\\' OR key IN (?1, ?2, ?3)", params![keys::PROFILE_SIG, keys::PROFILE_SEEN, keys::LAST_ERROR])?;
                tx.execute("DELETE FROM cloud_outbox", [])?;
                queries::set_setting(&tx, keys::PROFILE_ID, &profile_id.to_string())?;
                seed_outbox(&tx, profile_id)?;
            }
            tx.commit()
        })
        .await
        .map_err(|e| match e {
            AppError::Db(_) | AppError::Sqlite(_) => err(format!("Couldn't link the account to this profile: {e}")),
            other => other,
        })
}

/// First link: every tracked item of the profile is offered to the account with its own time,
/// so the merge with what's already in the cloud is last-write-wins per item.
fn seed_outbox(c: &Connection, profile_id: i64) -> rusqlite::Result<()> {
    c.execute(
        "INSERT OR IGNORE INTO cloud_outbox (kind, app_profile_id, tmdb_id, media_type, season_number, episode_number, changed_at)
         SELECT 'watchlist', app_profile_id, tmdb_id, media_type, 0, 0,
                COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', added_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           FROM watchlist WHERE app_profile_id = ?1",
        [profile_id],
    )?;
    c.execute(
        "INSERT OR IGNORE INTO cloud_outbox (kind, app_profile_id, tmdb_id, media_type, season_number, episode_number, changed_at)
         SELECT CASE WHEN media_type = 'movie' THEN 'movie' ELSE 'episode' END, app_profile_id, tmdb_id, media_type,
                CASE WHEN media_type = 'movie' THEN 0 ELSE season_number END,
                CASE WHEN media_type = 'movie' THEN 0 ELSE episode_number END,
                COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', last_watched_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           FROM watch_history
          WHERE app_profile_id = ?1 AND is_completed = 1",
        [profile_id],
    )?;
    Ok(())
}

/// Forgets the account on this PC (local data stays). Also used when the session is revoked.
async fn clear_local_session(state: &AppState) -> AppResult<()> {
    state.cloud.set_session(None);
    state
        .db
        .run(|c| {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM app_settings WHERE key LIKE 'cloud\\_%' ESCAPE '\\'", [])?;
            tx.execute("DELETE FROM cloud_outbox", [])?;
            tx.commit()
        })
        .await
}

fn is_signed_in_locally(c: &Connection) -> rusqlite::Result<bool> {
    Ok(queries::get_setting(c, keys::REFRESH_TOKEN)?.is_some_and(|t| !t.is_empty()))
}

/// A valid access token (refreshing it when needed) and the user id.
async fn access_token(state: &AppState) -> AppResult<(String, String)> {
    if let Some(t) = state.cloud.cached_token() {
        return Ok(t);
    }
    let refresh = state
        .db
        .run(|c| queries::get_setting(c, keys::REFRESH_TOKEN))
        .await?
        .filter(|t| !t.is_empty())
        .ok_or_else(|| err("Not signed in."))?;
    let resp = state
        .http
        .post(format!("{}/auth/v1/token?grant_type=refresh_token", base()))
        .header("apikey", SUPABASE_ANON_KEY)
        .json(&json!({ "refresh_token": refresh }))
        .send()
        .await?;
    let status = resp.status().as_u16();
    if status == 400 || status == 401 || status == 403 {
        // Revoked / expired refresh token: sign out here instead of retrying forever.
        clear_local_session(state).await?;
        return Err(err("Your cloud session expired. Sign in again to keep syncing."));
    }
    if !resp.status().is_success() {
        return Err(api_error(resp, "Refreshing the session").await);
    }
    let tok = token_from(resp.json().await?)?;
    let (access, user_id, new_refresh) = (tok.access_token.clone(), tok.user.id.clone(), tok.refresh_token.clone());
    state.cloud.set_session(Some(Session {
        access_token: tok.access_token,
        expires_at: Instant::now() + Duration::from_secs(tok.expires_in.unwrap_or(3600)),
        user_id: tok.user.id,
    }));
    // Refresh tokens rotate: keep the new one.
    state.db.run(move |c| queries::set_setting(c, keys::REFRESH_TOKEN, &new_refresh)).await?;
    Ok((access, user_id))
}

// ---------------------------------------------------------------------------------------------
// Google OAuth (PKCE through the system browser and a one-shot loopback listener)
// ---------------------------------------------------------------------------------------------

fn open_in_browser(url: &str) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    r.map(|_| ()).map_err(|e| err(format!("Couldn't open your browser: {e}")))
}

const CALLBACK_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Omnia</title><body style=\"font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0\"><div style=\"text-align:center\"><h2>{TITLE}</h2><p>{BODY}</p></div>";

async fn respond(sock: &mut tokio::net::TcpStream, status: &str, title: &str, body: &str) {
    use tokio::io::AsyncWriteExt;
    let page = CALLBACK_PAGE.replace("{TITLE}", title).replace("{BODY}", body);
    let msg = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = sock.write_all(msg.as_bytes()).await;
    let _ = sock.shutdown().await;
}

/// Waits for the browser to land on `/auth/callback?code=…` and returns the code.
async fn wait_for_code(listener: &tokio::net::TcpListener) -> AppResult<String> {
    use tokio::io::AsyncReadExt;
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => continue,
        };
        let req = String::from_utf8_lossy(&buf[..n]);
        let target = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
        let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else { continue };
        if url.path() != "/auth/callback" {
            respond(&mut sock, "404 Not Found", "Not found", "").await;
            continue;
        }
        let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
        if let Some(code) = q.get("code").filter(|c| !c.is_empty() && c.len() < 512) {
            respond(&mut sock, "200 OK", "You're signed in", "You can close this tab and return to Omnia.").await;
            return Ok(code.clone());
        }
        let reason = q.get("error_description").or_else(|| q.get("error")).cloned().unwrap_or_else(|| "Sign-in was cancelled.".into());
        respond(&mut sock, "400 Bad Request", "Sign-in failed", "Return to Omnia and try again.").await;
        return Err(err(format!("Google sign-in failed: {}", reason.chars().take(200).collect::<String>())));
    }
}

// ---------------------------------------------------------------------------------------------
// PostgREST / Storage
// ---------------------------------------------------------------------------------------------

struct Api<'a> {
    http: &'a reqwest::Client,
    token: String,
    user_id: String,
}

impl Api<'_> {
    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", base()))
            .header("apikey", SUPABASE_ANON_KEY)
            .bearer_auth(&self.token)
    }

    async fn upsert(&self, table: &str, on_conflict: &str, rows: &[Value]) -> AppResult<()> {
        for chunk in rows.chunks(CHUNK) {
            let resp = self
                .req(reqwest::Method::POST, &format!("/rest/v1/{table}"))
                .query(&[("on_conflict", on_conflict)])
                .header("Prefer", "resolution=merge-duplicates,return=minimal")
                .json(chunk)
                .send()
                .await?;
            if !resp.status().is_success() {
                return Err(api_error(resp, &format!("Uploading {table}")).await);
            }
        }
        Ok(())
    }

    /// Every row of `table` the server stamped after `since`, oldest first.
    async fn pull(&self, table: &str, select: &str, since: Option<&str>) -> AppResult<Vec<Value>> {
        let lower = since.and_then(parse_ts).map(|d| (d - PULL_OVERLAP).to_rfc3339_opts(SecondsFormat::Micros, true));
        let mut out = Vec::new();
        for page in 0.. {
            let mut q: Vec<(&str, String)> = vec![
                ("select", select.to_string()),
                ("user_id", format!("eq.{}", self.user_id)),
                ("order", "synced_at.asc".into()),
                ("limit", PAGE.to_string()),
                ("offset", (page * PAGE).to_string()),
            ];
            if let Some(l) = &lower {
                q.push(("synced_at", format!("gt.{l}")));
            }
            let resp = self.req(reqwest::Method::GET, &format!("/rest/v1/{table}")).query(&q).send().await?;
            if !resp.status().is_success() {
                return Err(api_error(resp, &format!("Downloading {table}")).await);
            }
            let rows: Vec<Value> = resp.json().await?;
            let n = rows.len();
            out.extend(rows);
            if n < PAGE {
                break;
            }
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------------------------
// Push (outbox → cloud)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct OutboxItem {
    kind: String,
    tmdb_id: i64,
    media_type: String,
    season: i64,
    episode: i64,
    changed_at: String,
    /// Current local state: Some((added / watched at, duration seconds)) when present.
    present: Option<(Option<String>, f64)>,
    /// Episode title (sent for unnumbered episodes, which have nothing else to show).
    episode_title: Option<String>,
}

fn read_outbox(c: &Connection, profile_id: i64) -> rusqlite::Result<Vec<OutboxItem>> {
    let mut stmt = c.prepare(
        "SELECT o.kind, o.tmdb_id, o.media_type, o.season_number, o.episode_number, o.changed_at,
                CASE o.kind
                  WHEN 'watchlist' THEN (SELECT 1 FROM watchlist w WHERE w.app_profile_id = o.app_profile_id AND w.tmdb_id = o.tmdb_id AND w.media_type = o.media_type)
                  ELSE (SELECT 1 FROM watch_history h WHERE h.app_profile_id = o.app_profile_id AND h.tmdb_id = o.tmdb_id AND h.media_type = o.media_type
                          AND h.season_number = o.season_number AND h.episode_number = o.episode_number AND h.is_completed = 1)
                END AS present,
                CASE o.kind
                  WHEN 'watchlist' THEN (SELECT w.added_at FROM watchlist w WHERE w.app_profile_id = o.app_profile_id AND w.tmdb_id = o.tmdb_id AND w.media_type = o.media_type)
                  ELSE (SELECT h.last_watched_at FROM watch_history h WHERE h.app_profile_id = o.app_profile_id AND h.tmdb_id = o.tmdb_id AND h.media_type = o.media_type
                          AND h.season_number = o.season_number AND h.episode_number = o.episode_number)
                END AS at,
                COALESCE((SELECT h.duration_seconds FROM watch_history h WHERE o.kind <> 'watchlist' AND h.app_profile_id = o.app_profile_id AND h.tmdb_id = o.tmdb_id
                          AND h.media_type = o.media_type AND h.season_number = o.season_number AND h.episode_number = o.episode_number), 0),
                (SELECT h.episode_title FROM watch_history h WHERE o.kind = 'episode' AND h.app_profile_id = o.app_profile_id AND h.tmdb_id = o.tmdb_id
                          AND h.media_type = o.media_type AND h.season_number = o.season_number AND h.episode_number = o.episode_number)
           FROM cloud_outbox o
          WHERE o.app_profile_id = ?1
          ORDER BY o.changed_at",
    )?;
    let rows = stmt.query_map([profile_id], |r| {
        let present: Option<i64> = r.get(6)?;
        Ok(OutboxItem {
            kind: r.get(0)?,
            tmdb_id: r.get(1)?,
            media_type: r.get(2)?,
            season: r.get(3)?,
            episode: r.get(4)?,
            changed_at: r.get(5)?,
            present: present.map(|_| (r.get::<_, Option<String>>(7).ok().flatten(), r.get::<_, f64>(8).unwrap_or(0.0))),
            episode_title: r.get::<_, Option<String>>(9).ok().flatten().map(|t| t.chars().take(200).collect()),
        })
    })?;
    rows.collect()
}

/// Runtime in whole minutes from a duration in seconds (1 s = unknown, as in manual marks).
fn runtime_minutes(duration_seconds: f64) -> Option<i64> {
    (duration_seconds > 60.0).then(|| (duration_seconds / 60.0).round() as i64).filter(|m| (1..1000).contains(m))
}

/// Shown when the Supabase project predates unnumbered-episode support.
const SCHEMA_UPGRADE_HINT: &str = "Some episodes without an episode number couldn't sync yet: re-run supabase/schema.sql in the Supabase SQL Editor.";

/// Uploads the outbox. Returns how many items went up, and a warning when unnumbered episodes
/// were refused (an older schema): those stay queued and everything else still syncs.
async fn push(state: &AppState, api: &Api<'_>, profile_id: i64) -> AppResult<(usize, Option<String>)> {
    let mut items = state.db.run(move |c| read_outbox(c, profile_id)).await?;
    if items.is_empty() {
        return Ok((0, None));
    }
    let uid = api.user_id.as_str();
    let (mut wl_up, mut wl_del, mut mv_up, mut mv_del, mut ep_up, mut ep_del) = (vec![], vec![], vec![], vec![], vec![], vec![]);
    // Unnumbered episodes (episode 0) carry their title and go in their own batch.
    let (mut ep0_up, mut ep0_del) = (vec![], vec![]);
    for it in &items {
        let changed = to_iso(Some(&it.changed_at));
        match (it.kind.as_str(), &it.present) {
            ("watchlist", Some((at, _))) => wl_up.push(json!({
                "user_id": uid, "tmdb_id": it.tmdb_id, "media_type": it.media_type,
                "added_at": to_iso(at.as_deref()), "updated_at": changed, "deleted_at": null,
            })),
            ("watchlist", None) => wl_del.push(json!({
                "user_id": uid, "tmdb_id": it.tmdb_id, "media_type": it.media_type, "updated_at": changed, "deleted_at": changed,
            })),
            ("movie", Some((at, dur))) => mv_up.push(json!({
                "user_id": uid, "tmdb_id": it.tmdb_id, "media_type": "movie", "status": "watched",
                "runtime_minutes": runtime_minutes(*dur), "watched_at": to_iso(at.as_deref()), "updated_at": changed, "deleted_at": null,
            })),
            ("movie", None) => mv_del.push(json!({
                "user_id": uid, "tmdb_id": it.tmdb_id, "media_type": "movie", "updated_at": changed, "deleted_at": changed,
            })),
            ("episode", Some((at, dur))) if it.episode == 0 => ep0_up.push(json!({
                "user_id": uid, "tmdb_id": it.tmdb_id, "media_type": "tv", "season_number": it.season, "episode_number": 0,
                "status": "watched", "runtime_minutes": runtime_minutes(*dur), "watched_at": to_iso(at.as_deref()),
                "episode_title": it.episode_title, "updated_at": changed, "deleted_at": null,
            })),
            ("episode", Some((at, dur))) => ep_up.push(json!({
                "user_id": uid, "tmdb_id": it.tmdb_id, "media_type": "tv", "season_number": it.season, "episode_number": it.episode,
                "status": "watched", "runtime_minutes": runtime_minutes(*dur), "watched_at": to_iso(at.as_deref()),
                "updated_at": changed, "deleted_at": null,
            })),
            ("episode", None) => {
                let row = json!({
                    "user_id": uid, "tmdb_id": it.tmdb_id, "media_type": "tv", "season_number": it.season, "episode_number": it.episode,
                    "updated_at": changed, "deleted_at": changed,
                });
                if it.episode == 0 { ep0_del.push(row) } else { ep_del.push(row) }
            }
            _ => {}
        }
    }
    const WL: &str = "user_id,tmdb_id,media_type";
    const MV: &str = "user_id,tmdb_id";
    const EP: &str = "user_id,tmdb_id,season_number,episode_number";
    api.upsert("watchlist", WL, &wl_up).await?;
    api.upsert("watchlist", WL, &wl_del).await?;
    api.upsert("tracked_movies", MV, &mv_up).await?;
    api.upsert("tracked_movies", MV, &mv_del).await?;
    api.upsert("tracked_episodes", EP, &ep_up).await?;
    api.upsert("tracked_episodes", EP, &ep_del).await?;
    let mut warning = None;
    let unnumbered = async {
        api.upsert("tracked_episodes", EP, &ep0_up).await?;
        api.upsert("tracked_episodes", EP, &ep0_del).await
    }
    .await;
    if let Err(e) = unnumbered {
        log::warn!("unnumbered episodes not synced ({e}); the Supabase schema needs updating");
        items.retain(|it| !(it.kind == "episode" && it.episode == 0));
        warning = Some(SCHEMA_UPGRADE_HINT.to_string());
    }

    // Done: drop exactly what was sent (a change made meanwhile has a newer changed_at and stays).
    let n = items.len();
    state
        .db
        .run(move |c| {
            let tx = c.transaction()?;
            {
                let mut del = tx.prepare(
                    "DELETE FROM cloud_outbox WHERE kind = ?1 AND app_profile_id = ?2 AND tmdb_id = ?3 AND media_type = ?4
                       AND season_number = ?5 AND episode_number = ?6 AND changed_at = ?7",
                )?;
                for it in &items {
                    del.execute(params![it.kind, profile_id, it.tmdb_id, it.media_type, it.season, it.episode, it.changed_at])?;
                }
            }
            tx.commit()
        })
        .await?;
    Ok((n, warning))
}

// ---------------------------------------------------------------------------------------------
// Pull (cloud → SQLite)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Remote {
    kind: &'static str,
    tmdb_id: i64,
    media_type: String,
    season: i64,
    episode: i64,
    updated_at: DateTime<Utc>,
    deleted: bool,
    /// added_at (watchlist) / watched_at.
    at: DateTime<Utc>,
    runtime_minutes: Option<i64>,
    episode_title: Option<String>,
}

fn parse_remote(kind: &'static str, v: &Value) -> Option<Remote> {
    let s = |k: &str| v.get(k).and_then(Value::as_str);
    let tmdb_id = v.get("tmdb_id")?.as_i64().filter(|n| *n > 0)?;
    let media_type = match kind {
        "movie" => "movie".to_string(),
        "episode" => "tv".to_string(),
        _ => s("media_type").filter(|m| *m == "movie" || *m == "tv")?.to_string(),
    };
    let updated_at = s("updated_at").and_then(parse_ts)?;
    let at = s(if kind == "watchlist" { "added_at" } else { "watched_at" }).and_then(parse_ts).unwrap_or(updated_at);
    let (season, episode) = if kind == "episode" {
        // Episode 0 = an unnumbered episode (kept under its season, like the importer does).
        (v.get("season_number")?.as_i64().filter(|n| *n >= 0)?, v.get("episode_number")?.as_i64().filter(|n| *n >= 0)?)
    } else {
        (0, 0)
    };
    Some(Remote {
        kind,
        tmdb_id,
        media_type,
        season,
        episode,
        updated_at,
        deleted: v.get("deleted_at").is_some_and(|d| !d.is_null()),
        at,
        runtime_minutes: v.get("runtime_minutes").and_then(Value::as_i64).filter(|m| (1..1000).contains(m)),
        episode_title: s("episode_title").map(|t| t.chars().take(200).collect()),
    })
}

/// Applies remote rows to the profile; returns how many changed something locally.
fn apply_remote(c: &mut Connection, profile_id: i64, rows: &[Remote]) -> rusqlite::Result<usize> {
    let tx = c.transaction()?;
    let mut changed = 0usize;
    let live_after = Utc::now() - chrono::Duration::days(LIVE_WINDOW_DAYS);
    for r in rows {
        let key = params![r.kind, profile_id, r.tmdb_id, r.media_type, r.season, r.episode];
        // A newer change made on this PC is still waiting to go up: it wins.
        let pending: Option<String> = tx
            .query_row(
                "SELECT changed_at FROM cloud_outbox WHERE kind = ?1 AND app_profile_id = ?2 AND tmdb_id = ?3 AND media_type = ?4
                   AND season_number = ?5 AND episode_number = ?6",
                key,
                |row| row.get(0),
            )
            .optional()?;
        if pending.as_deref().and_then(parse_ts).is_some_and(|p| p > r.updated_at) {
            continue;
        }
        let n = match (r.kind, r.deleted) {
            ("watchlist", false) => tx.execute(
                "INSERT OR IGNORE INTO watchlist (app_profile_id, tmdb_id, media_type, added_at) VALUES (?1, ?2, ?3, ?4)",
                params![profile_id, r.tmdb_id, r.media_type, to_sqlite(r.at)],
            )?,
            ("watchlist", true) => tx.execute(
                "DELETE FROM watchlist WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3",
                params![profile_id, r.tmdb_id, r.media_type],
            )?,
            (_, false) => {
                let duration = r.runtime_minutes.map(|m| (m * 60) as f64).unwrap_or(1.0);
                // Old watches go in silently (history + taste), recent ones show on Continue Watching.
                let imported = r.at < live_after;
                tx.execute(
                    "INSERT INTO watch_history
                        (app_profile_id, tmdb_id, media_type, season_number, episode_number, episode_title, provider_name,
                         progress_seconds, duration_seconds, is_completed, watch_count, abandoned, last_watched_at,
                         is_imported, is_manual)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?9, NULL, ?6, ?6, 1, 1, 0, ?7, ?8, 1)
                     ON CONFLICT(app_profile_id, tmdb_id, media_type, season_number, episode_number) DO UPDATE SET
                        is_completed = 1,
                        episode_title = COALESCE(watch_history.episode_title, excluded.episode_title),
                        abandoned = 0,
                        duration_seconds = MAX(watch_history.duration_seconds, excluded.duration_seconds),
                        progress_seconds = MAX(watch_history.duration_seconds, excluded.duration_seconds),
                        last_watched_at = MAX(watch_history.last_watched_at, excluded.last_watched_at)
                     WHERE watch_history.is_completed = 0",
                    params![profile_id, r.tmdb_id, r.media_type, r.season, r.episode, duration, to_sqlite(r.at), imported, r.episode_title],
                )?
            }
            (_, true) => tx.execute(
                "DELETE FROM watch_history WHERE app_profile_id = ?1 AND tmdb_id = ?2 AND media_type = ?3
                   AND season_number = ?4 AND episode_number = ?5 AND is_completed = 1",
                params![profile_id, r.tmdb_id, r.media_type, r.season, r.episode],
            )?,
        };
        changed += n.min(1);
        // The triggers just queued this change; it came from the cloud, so don't echo it back.
        tx.execute(
            "DELETE FROM cloud_outbox WHERE kind = ?1 AND app_profile_id = ?2 AND tmdb_id = ?3 AND media_type = ?4
               AND season_number = ?5 AND episode_number = ?6",
            key,
        )?;
    }
    tx.commit()?;
    Ok(changed)
}

async fn pull(state: &AppState, api: &Api<'_>, profile_id: i64) -> AppResult<usize> {
    const TABLES: [(&str, &str, &str); 3] = [
        ("watchlist", "watchlist", "tmdb_id,media_type,added_at,updated_at,deleted_at,synced_at"),
        ("movie", "tracked_movies", "tmdb_id,runtime_minutes,watched_at,updated_at,deleted_at,synced_at"),
        ("episode", "tracked_episodes", "tmdb_id,season_number,episode_number,episode_title,runtime_minutes,watched_at,updated_at,deleted_at,synced_at"),
    ];
    let mut applied = 0;
    for (kind, table, select) in TABLES {
        let cursor_key = format!("{}{table}", keys::CURSOR_PREFIX);
        let ck = cursor_key.clone();
        let since = state.db.run(move |c| queries::get_setting(c, &ck)).await?;
        let rows = match api.pull(table, select, since.as_deref()).await {
            // An older schema has no episode_title column: pull without it.
            Err(_) if select.contains(",episode_title") => api.pull(table, &select.replace(",episode_title", ""), since.as_deref()).await?,
            r => r?,
        };
        if rows.is_empty() {
            continue;
        }
        let newest = rows
            .iter()
            .filter_map(|r| r.get("synced_at").and_then(Value::as_str).and_then(parse_ts))
            .max();
        let parsed: Vec<Remote> = rows.iter().filter_map(|r| parse_remote(kind, r)).collect();
        applied += state
            .db
            .run(move |c| {
                let n = apply_remote(c, profile_id, &parsed)?;
                if let Some(t) = newest {
                    queries::set_setting(c, &cursor_key, &t.to_rfc3339_opts(SecondsFormat::Micros, true))?;
                }
                Ok(n)
            })
            .await?;
    }
    Ok(applied)
}

// ---------------------------------------------------------------------------------------------
// Profile: name + picture
// ---------------------------------------------------------------------------------------------

fn avatar_prefix() -> String {
    format!("{}/storage/v1/object/public/avatars/", base())
}

fn profile_sig(name: &str, avatar: Option<&str>) -> String {
    sha256_hex(&format!("{name}\u{0}{}", avatar.unwrap_or("")))
}

/// Uploads a local `data:image/…` avatar (the UI already made it a 256×256 WebP).
async fn upload_avatar(api: &Api<'_>, data_url: &str) -> AppResult<String> {
    let rest = data_url.strip_prefix("data:").ok_or_else(|| err("bad avatar"))?;
    let (mime, b64) = rest.split_once(";base64,").ok_or_else(|| err("bad avatar"))?;
    let file = match mime {
        "image/webp" => "avatar.webp",
        "image/jpeg" => "avatar.jpg",
        "image/png" => "avatar.png",
        _ => return Err(err("unsupported avatar format")),
    };
    let bytes = b64_decode(b64).ok_or_else(|| err("bad avatar"))?;
    if bytes.len() > MAX_AVATAR_BYTES {
        return Err(err("Profile picture is too large to sync."));
    }
    let path = format!("{}/{file}", api.user_id);
    let resp = api
        .req(reqwest::Method::POST, &format!("/storage/v1/object/avatars/{path}"))
        .header("Content-Type", mime)
        .header("x-upsert", "true")
        .header("cache-control", "3600")
        .body(bytes)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error(resp, "Uploading your profile picture").await);
    }
    Ok(format!("{}{path}?v={}", avatar_prefix(), Utc::now().timestamp_millis()))
}

/// Downloads a synced picture into a local data URL (so it works offline and never loads remotely).
async fn download_avatar(state: &AppState, url: &str) -> AppResult<Option<String>> {
    if url.starts_with("https://image.tmdb.org/t/p/") && url.len() <= 200 {
        return Ok(Some(url.to_string()));
    }
    if !url.starts_with(&avatar_prefix()) {
        return Ok(None);
    }
    let mut resp = state.http.get(url).send().await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(mime.as_str(), "image/webp" | "image/jpeg" | "image/png") {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_AVATAR_BYTES {
            return Ok(None);
        }
    }
    let data = format!("data:{mime};base64,{}", crate::desktop::base64_encode(&bytes));
    Ok((data.len() <= 400_000).then_some(data))
}

async fn sync_profile(state: &AppState, api: &Api<'_>, profile_id: i64) -> AppResult<bool> {
    let order_key = home_order_key(profile_id);
    let ok = order_key.clone();
    let (local, stored_sig, seen, local_order, order_sig_stored) = state
        .db
        .run(move |c| {
            Ok((
                queries::get_profile(c, profile_id)?,
                queries::get_setting(c, keys::PROFILE_SIG)?,
                queries::get_setting(c, keys::PROFILE_SEEN)?.and_then(|s| parse_ts(&s)),
                queries::get_setting(c, &ok)?,
                queries::get_setting(c, keys::HOME_ORDER_SIG)?,
            ))
        })
        .await?;
    let Some(local) = local else { return Ok(false) };
    let local_order = local_order.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|v| canonical_order(&v));

    // Projects whose schema predates home_row_order: read (and later write) without it.
    let get_profile_row = |select: &'static str| {
        api.req(reqwest::Method::GET, "/rest/v1/profiles")
            .query(&[("select", select), ("user_id", &format!("eq.{}", api.user_id))])
            .send()
    };
    let mut has_order_column = true;
    let mut resp = get_profile_row("display_name,avatar_url,home_row_order,updated_at").await?;
    if !resp.status().is_success() {
        has_order_column = false;
        resp = get_profile_row("display_name,avatar_url,updated_at").await?;
    }
    if !resp.status().is_success() {
        return Err(api_error(resp, "Reading your profile").await);
    }
    let remote: Option<Value> = resp.json::<Vec<Value>>().await?.into_iter().next();
    let r_order = remote.as_ref().and_then(|r| r.get("home_row_order")).and_then(canonical_order);
    let r_name = remote.as_ref().and_then(|r| r.get("display_name")).and_then(Value::as_str).map(str::to_string);
    let r_avatar = remote.as_ref().and_then(|r| r.get("avatar_url")).and_then(Value::as_str).map(str::to_string);
    let r_updated = remote.as_ref().and_then(|r| r.get("updated_at")).and_then(Value::as_str).and_then(parse_ts);

    let sig = profile_sig(&local.profile_name, local.avatar_asset.as_deref());
    let first_link = stored_sig.is_none();
    let local_changed = stored_sig.as_deref() != Some(sig.as_str());
    let remote_changed = match (r_updated, seen) {
        (Some(r), Some(s)) => r > s,
        (Some(_), None) => true,
        _ => false,
    };
    let uploadable = |a: &Option<String>| a.as_deref().is_some_and(|a| a.starts_with("data:image/") || a.starts_with("https://image.tmdb.org/"));

    let mut new_name = local.profile_name.clone();
    let mut new_avatar = local.avatar_asset.clone();
    let mut push_name = false;
    let mut push_avatar = false;

    if first_link {
        // Local fills in, the cloud fills the gaps.
        push_name = true;
        if uploadable(&local.avatar_asset) {
            push_avatar = true;
        } else if let Some(url) = &r_avatar {
            if let Some(a) = download_avatar(state, url).await? {
                new_avatar = Some(a);
            }
        }
    } else if local_changed {
        push_name = true;
        push_avatar = true;
    } else if remote_changed {
        if let Some(n) = r_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            new_name = n.chars().take(32).collect();
        }
        match &r_avatar {
            Some(url) => {
                if let Some(a) = download_avatar(state, url).await? {
                    new_avatar = Some(a);
                }
            }
            // Removed elsewhere: drop a synced photo, keep a built-in character / colour.
            None if uploadable(&local.avatar_asset) => new_avatar = None,
            None => {}
        }
    }

    // Home row order: its own last-write-wins, so it never drags the picture along.
    let order_sig = sha256_hex(local_order.as_deref().unwrap_or(""));
    let mut new_order = local_order.clone();
    let mut push_order = false;
    if has_order_column {
        match order_sig_stored.as_deref() {
            // First sync of the order: this PC's custom order wins; otherwise take the cloud's.
            None if local_order.is_some() => push_order = true,
            None => new_order = r_order.clone(),
            Some(prev) if prev != order_sig => push_order = true,
            Some(_) if remote_changed => new_order = r_order.clone(),
            Some(_) => {}
        }
    }

    let mut seen_at = r_updated.map(|d| d.to_rfc3339_opts(SecondsFormat::Micros, true));
    if push_name || push_avatar || push_order {
        let mut row = serde_json::Map::new();
        row.insert("user_id".into(), json!(api.user_id));
        let now = now_iso();
        row.insert("updated_at".into(), json!(now));
        if push_name {
            row.insert("display_name".into(), json!(local.profile_name.chars().take(64).collect::<String>()));
        }
        if push_avatar {
            let url = match local.avatar_asset.as_deref() {
                Some(a) if a.starts_with("data:image/") => Some(upload_avatar(api, a).await?),
                Some(a) if a.starts_with("https://image.tmdb.org/") => Some(a.to_string()),
                _ => None,
            };
            row.insert("avatar_url".into(), json!(url));
        }
        if push_order {
            let ids: Value = local_order.as_deref().and_then(|o| serde_json::from_str(o).ok()).unwrap_or(Value::Null);
            row.insert("home_row_order".into(), ids);
        }
        api.upsert("profiles", "user_id", &[Value::Object(row)]).await?;
        seen_at = Some(now);
    }

    let order_changed = new_order != local_order;
    let changed_locally = new_name != local.profile_name || new_avatar != local.avatar_asset || order_changed;
    let final_sig = profile_sig(&new_name, new_avatar.as_deref());
    let final_order_sig = sha256_hex(new_order.as_deref().unwrap_or(""));
    let name_or_avatar = new_name != local.profile_name || new_avatar != local.avatar_asset;
    state
        .db
        .run(move |c| {
            if name_or_avatar {
                queries::update_profile(c, profile_id, &new_name, new_avatar.as_deref(), local.is_kids_profile)?;
            }
            if order_changed {
                match &new_order {
                    Some(o) => queries::set_setting(c, &order_key, o)?,
                    None => {
                        queries::delete_setting(c, &order_key)?;
                    }
                }
            }
            if has_order_column {
                queries::set_setting(c, keys::HOME_ORDER_SIG, &final_order_sig)?;
            }
            queries::set_setting(c, keys::PROFILE_SIG, &final_sig)?;
            if let Some(s) = seen_at {
                queries::set_setting(c, keys::PROFILE_SEEN, &s)?;
            }
            Ok(())
        })
        .await?;
    Ok(changed_locally)
}

// ---------------------------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------------------------

/// One full round: push local changes, pull other devices' changes, then the profile.
/// Signed out: returns immediately without touching the network.
pub async fn sync_once(app: &AppHandle) -> AppResult<Option<SyncReport>> {
    if !configured() {
        return Ok(None);
    }
    let state = app.state::<AppState>();
    let _guard = state.cloud.run.lock().await;
    if let Ok(mut l) = state.cloud.last_run.lock() {
        *l = Some(Instant::now());
    }
    let profile_id = state
        .db
        .run(|c| {
            if !is_signed_in_locally(c)? {
                return Ok(None);
            }
            Ok(queries::get_setting(c, keys::PROFILE_ID)?.and_then(|p| p.parse::<i64>().ok()))
        })
        .await?;
    let Some(profile_id) = profile_id else { return Ok(None) };

    let result: AppResult<(SyncReport, Option<String>)> = async {
        let (token, user_id) = access_token(&state).await?;
        let api = Api { http: &state.http, token, user_id };
        let (pushed, warning) = push(&state, &api, profile_id).await?;
        let applied = pull(&state, &api, profile_id).await?;
        let profile_updated = sync_profile(&state, &api, profile_id).await?;
        Ok((SyncReport { pushed, applied, profile_updated }, warning))
    }
    .await;

    let (ok, msg) = match &result {
        Ok((_, warning)) => (true, warning.clone()),
        Err(e) => (false, Some(e.to_string())),
    };
    let _ = state
        .db
        .run(move |c| {
            if !is_signed_in_locally(c)? {
                return Ok(());
            }
            if ok {
                queries::set_setting(c, keys::LAST_SYNC, &now_iso())?;
                match msg {
                    Some(w) => queries::set_setting(c, keys::LAST_ERROR, &w)?,
                    None => {
                        queries::delete_setting(c, keys::LAST_ERROR)?;
                    }
                }
            } else if let Some(m) = msg {
                queries::set_setting(c, keys::LAST_ERROR, &m)?;
            }
            Ok(())
        })
        .await;
    let (report, _) = result?;
    if report.applied > 0 || report.profile_updated {
        state.recommender.invalidate(profile_id);
        let _ = app.emit(EVT_CLOUD_SYNC, json!({ "appProfileId": profile_id, "applied": report.applied, "profileUpdated": report.profile_updated }));
    }
    if report.pushed > 0 || report.applied > 0 {
        log::info!("cloud sync: pushed {} change(s), applied {}", report.pushed, report.applied);
    }
    Ok(Some(report))
}

/// Background loop: pushes pending changes within ~20 s and pulls every 2 minutes, only while
/// signed in (the check is a local settings read; nothing goes out otherwise).
pub fn spawn_loop(app: AppHandle) {
    if !configured() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        let mut last_full: Option<Instant> = None;
        loop {
            let state = app.state::<AppState>();
            let due = state
                .db
                .run(|c| {
                    if !is_signed_in_locally(c)? {
                        return Ok(None);
                    }
                    // Unnumbered episodes refused by an outdated schema retry with the 2-minute pull, not every tick.
                    let pending: i64 = c.query_row(
                        "SELECT COUNT(*) FROM cloud_outbox
                          WHERE NOT (kind = 'episode' AND episode_number = 0
                                     AND EXISTS (SELECT 1 FROM app_settings WHERE key = ?1 AND value = ?2))",
                        params![keys::LAST_ERROR, SCHEMA_UPGRADE_HINT],
                        |r| r.get(0),
                    )?;
                    Ok(Some(pending > 0))
                })
                .await
                .ok()
                .flatten();
            if let Some(has_pending) = due {
                if has_pending || last_full.is_none_or(|t| t.elapsed() >= FULL_EVERY) {
                    last_full = Some(Instant::now());
                    if let Err(e) = sync_once(&app).await {
                        log::warn!("cloud sync failed: {e}");
                    }
                }
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// The window came back: catch up soon (debounced).
pub fn on_wake(app: &AppHandle) {
    if !configured() {
        return;
    }
    let state = app.state::<AppState>();
    let recent = state.cloud.last_run.lock().ok().and_then(|l| *l).is_some_and(|t| t.elapsed() < WAKE_DEBOUNCE);
    if recent {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sync_once(&app).await {
            log::warn!("cloud sync on wake failed: {e}");
        }
    });
}

fn after_sign_in(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sync_once(&app).await {
            log::warn!("first cloud sync failed: {e}");
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Commands (catalog window only; never exposed to LAN devices)
// ---------------------------------------------------------------------------------------------

async fn status_of(state: &AppState) -> AppResult<CloudStatus> {
    state
        .db
        .run(|c| {
            let signed_in = is_signed_in_locally(c)?;
            let profile_id = queries::get_setting(c, keys::PROFILE_ID)?.and_then(|p| p.parse::<i64>().ok()).filter(|_| signed_in);
            let profile_name = match profile_id {
                Some(p) => queries::get_profile(c, p)?.map(|p| p.profile_name),
                None => None,
            };
            let pending: i64 = c.query_row("SELECT COUNT(*) FROM cloud_outbox", [], |r| r.get(0))?;
            Ok(CloudStatus {
                configured: configured(),
                signed_in,
                email: queries::get_setting(c, keys::EMAIL)?.filter(|_| signed_in),
                profile_id,
                profile_name,
                last_sync_at: queries::get_setting(c, keys::LAST_SYNC)?,
                last_error: queries::get_setting(c, keys::LAST_ERROR)?,
                pending,
                google_redirect: OAUTH_REDIRECT,
            })
        })
        .await
}

#[tauri::command]
pub async fn cloud_status(state: State<'_, AppState>) -> AppResult<CloudStatus> {
    status_of(&state).await
}

fn check_credentials(email: &str, password: &str) -> AppResult<()> {
    if !email.contains('@') || email.len() > 254 {
        return Err(err("Enter a valid e-mail address."));
    }
    if password.len() < 8 {
        return Err(err("Use a password of at least 8 characters."));
    }
    Ok(())
}

#[tauri::command]
pub async fn cloud_sign_in(app: AppHandle, state: State<'_, AppState>, email: String, password: String, app_profile_id: i64) -> AppResult<CloudStatus> {
    require_configured()?;
    let email = email.trim().to_string();
    check_credentials(&email, &password)?;
    {
        let _g = state.cloud.run.lock().await;
        let v = gotrue(&state, "/token?grant_type=password", json!({ "email": email, "password": password }), "Sign-in").await?;
        link_session(&state, token_from(v)?, app_profile_id).await?;
    }
    after_sign_in(&app);
    status_of(&state).await
}

#[tauri::command]
pub async fn cloud_sign_up(app: AppHandle, state: State<'_, AppState>, email: String, password: String, app_profile_id: i64) -> AppResult<SignUpResult> {
    require_configured()?;
    let email = email.trim().to_string();
    check_credentials(&email, &password)?;
    let v = gotrue(&state, "/signup", json!({ "email": email, "password": password }), "Creating your account").await?;
    // With e-mail confirmation on, Supabase returns the user without a session.
    let signed_in = v.get("access_token").is_some();
    if signed_in {
        let _g = state.cloud.run.lock().await;
        link_session(&state, token_from(v)?, app_profile_id).await?;
        drop(_g);
        after_sign_in(&app);
    }
    Ok(SignUpResult { signed_in, status: status_of(&state).await? })
}

#[tauri::command]
pub async fn cloud_sign_in_google(app: AppHandle, state: State<'_, AppState>, app_profile_id: i64) -> AppResult<CloudStatus> {
    require_configured()?;
    let Ok(_flow) = state.cloud.oauth.try_lock() else {
        return Err(err("Google sign-in is already open in your browser."));
    };
    let verifier = random_token();
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", OAUTH_PORT))
        .await
        .map_err(|_| err(format!("Port {OAUTH_PORT} is busy, so Google sign-in can't complete. Close the app using it, or use e-mail sign-in.")))?;
    let url = url::Url::parse_with_params(
        &format!("{}/auth/v1/authorize", base()),
        &[("provider", "google"), ("redirect_to", OAUTH_REDIRECT), ("code_challenge", challenge.as_str()), ("code_challenge_method", "s256")],
    )
    .map_err(|_| err("Invalid SUPABASE_URL in this build."))?;
    open_in_browser(url.as_str())?;
    let code = tokio::time::timeout(Duration::from_secs(300), wait_for_code(&listener))
        .await
        .map_err(|_| err("Google sign-in timed out. Try again."))??;
    drop(listener);
    {
        let _g = state.cloud.run.lock().await;
        let v = gotrue(&state, "/token?grant_type=pkce", json!({ "auth_code": code, "code_verifier": verifier }), "Google sign-in").await?;
        link_session(&state, token_from(v)?, app_profile_id).await?;
    }
    crate::player::window_manager::focus_main_window(&app);
    after_sign_in(&app);
    status_of(&state).await
}

#[tauri::command]
pub async fn cloud_sign_out(state: State<'_, AppState>) -> AppResult<CloudStatus> {
    let _g = state.cloud.run.lock().await;
    // Best effort: revoke the session server-side too.
    if configured() {
        if let Some((token, _)) = state.cloud.cached_token() {
            let _ = state
                .http
                .post(format!("{}/auth/v1/logout", base()))
                .header("apikey", SUPABASE_ANON_KEY)
                .bearer_auth(token)
                .send()
                .await;
        }
    }
    clear_local_session(&state).await?;
    drop(_g);
    status_of(&state).await
}

#[tauri::command]
pub async fn cloud_sync_now(app: AppHandle) -> AppResult<Option<SyncReport>> {
    sync_once(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_and_pkce_shape() {
        assert_eq!(b64url(b"Man"), "TWFu");
        assert_eq!(b64url(b"Ma"), "TWE");
        assert_eq!(b64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(b64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(b64_decode("TQ==").unwrap(), b"M");
        let v = random_token();
        assert_eq!(v.len(), 43);
        assert!(v.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
    }

    #[test]
    fn timestamps_parse_both_formats() {
        let a = parse_ts("2026-11-20 10:00:00").unwrap();
        let b = parse_ts("2026-11-20T10:00:00.000Z").unwrap();
        let c = parse_ts("2026-11-20T10:00:00.000000+00:00").unwrap();
        assert_eq!(a, b);
        assert_eq!(b, c);
        assert_eq!(to_sqlite(a), "2026-11-20 10:00:00");
        assert_eq!(runtime_minutes(1.0), None);
        assert_eq!(runtime_minutes(7_200.0), Some(120));
    }

    async fn db_with_link() -> crate::db::Database {
        let db = crate::db::Database::open_in_memory().await.unwrap();
        db.run(|c| {
            queries::set_setting(c, keys::PROFILE_ID, "1")?;
            Ok(())
        })
        .await
        .unwrap();
        db
    }

    #[tokio::test]
    async fn triggers_queue_only_the_linked_profile_and_real_completions() {
        let db = db_with_link().await;
        let n = db
            .run(|c| {
                let other = queries::create_profile(c, "Other", None, false)?.profile_id;
                queries::add_to_watchlist(c, 1, 603, "movie")?;
                queries::add_to_watchlist(c, other, 604, "movie")?;
                queries::mark_watched_manually(c, 1, 27205, "movie", 0, 0, None, Some(8880.0))?;
                // A progress tick that doesn't complete anything must not queue.
                c.execute(
                    "INSERT INTO watch_history (app_profile_id, tmdb_id, media_type, progress_seconds, duration_seconds) VALUES (1, 550, 'movie', 10, 100)",
                    [],
                )?;
                c.execute("UPDATE watch_history SET progress_seconds = 20 WHERE tmdb_id = 550", [])?;
                c.query_row("SELECT COUNT(*) FROM cloud_outbox", [], |r| r.get::<_, i64>(0))
            })
            .await
            .unwrap();
        assert_eq!(n, 2);
    }

    #[tokio::test]
    async fn pull_respects_newer_local_changes_and_does_not_echo() {
        let db = db_with_link().await;
        db.run(|c| {
            queries::add_to_watchlist(c, 1, 603, "movie")?; // queued now
            c.execute("DELETE FROM cloud_outbox WHERE tmdb_id = 603", [])?; // pretend it was pushed
            queries::add_to_watchlist(c, 1, 700, "tv")?; // still pending, newer than the remote tombstone below
            let old = Utc::now() - chrono::Duration::days(1);
            let rows = vec![
                Remote { kind: "watchlist", tmdb_id: 603, media_type: "movie".into(), season: 0, episode: 0, updated_at: Utc::now(), deleted: true, at: old, runtime_minutes: None, episode_title: None },
                Remote { kind: "watchlist", tmdb_id: 700, media_type: "tv".into(), season: 0, episode: 0, updated_at: old, deleted: true, at: old, runtime_minutes: None, episode_title: None },
                Remote { kind: "episode", tmdb_id: 1399, media_type: "tv".into(), season: 1, episode: 2, updated_at: Utc::now(), deleted: false, at: old, runtime_minutes: Some(55), episode_title: None },
            ];
            let applied = apply_remote(c, 1, &rows)?;
            assert_eq!(applied, 2);
            assert!(!queries::is_in_watchlist(c, 1, 603, "movie")?);
            assert!(queries::is_in_watchlist(c, 1, 700, "tv")?);
            let done: i64 = c.query_row(
                "SELECT is_completed FROM watch_history WHERE tmdb_id = 1399 AND season_number = 1 AND episode_number = 2",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(done, 1);
            // Only the local, still-newer change is waiting to go up.
            let pending: Vec<i64> = c.prepare("SELECT tmdb_id FROM cloud_outbox")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            assert_eq!(pending, vec![700]);
            Ok(())
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn unnumbered_episodes_sync_both_ways() {
        let db = db_with_link().await;
        db.run(|c| {
            // An imported Netflix watch TMDB couldn't number: S2, episode 0, with its title.
            c.execute(
                "INSERT INTO watch_history (app_profile_id, tmdb_id, media_type, season_number, episode_number, episode_title, provider_name,
                    progress_seconds, duration_seconds, is_completed) VALUES (1, 275204, 'tv', 2, 0, 'Saajan Chala Sasural', 'Netflix', 2700, 2700, 1)",
                [],
            )?;
            let out = read_outbox(c, 1)?;
            assert_eq!(out.len(), 1);
            assert_eq!((out[0].season, out[0].episode), (2, 0));
            assert_eq!(out[0].episode_title.as_deref(), Some("Saajan Chala Sasural"));
            Ok(())
        })
        .await
        .unwrap();
        let v = json!({ "tmdb_id": 99, "season_number": 3, "episode_number": 0, "episode_title": "Untitled", "watched_at": "2026-11-01T10:00:00Z", "updated_at": "2026-11-01T10:00:00Z", "deleted_at": null });
        let r = parse_remote("episode", &v).expect("episode 0 is accepted");
        assert_eq!((r.season, r.episode, r.episode_title.as_deref()), (3, 0, Some("Untitled")));
        db.run(move |c| {
            assert_eq!(apply_remote(c, 1, &[r])?, 1);
            let t: Option<String> = c.query_row("SELECT episode_title FROM watch_history WHERE tmdb_id = 99 AND season_number = 3 AND episode_number = 0", [], |x| x.get(0))?;
            assert_eq!(t.as_deref(), Some("Untitled"));
            Ok(())
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn migration_v10_queues_existing_unnumbered_rows_of_the_linked_profile() {
        let db = crate::db::Database::open_in_memory().await.unwrap();
        let n = db
            .run(|c| {
                // Simulate a profile linked before v10: the row exists, nothing queued it.
                c.execute(
                    "INSERT INTO watch_history (app_profile_id, tmdb_id, media_type, season_number, episode_number, progress_seconds, duration_seconds, is_completed)
                     VALUES (1, 275204, 'tv', 2, 0, 2700, 2700, 1)",
                    [],
                )?;
                queries::set_setting(c, keys::PROFILE_ID, "1")?;
                c.execute_batch(include_str!("../db/migrations/010_cloud_sync_unnumbered.sql"))?;
                c.query_row("SELECT COUNT(*) FROM cloud_outbox WHERE episode_number = 0", [], |r| r.get::<_, i64>(0))
            })
            .await
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn home_orders_are_canonicalised() {
        assert_eq!(canonical_order(&json!(["love", 3, "in-theatres", ""])).as_deref(), Some(r#"["love","in-theatres"]"#));
        assert_eq!(canonical_order(&json!(null)), None);
        assert_eq!(canonical_order(&json!("love")), None);
        assert_eq!(home_order_key(4), "home_row_order_p4");
    }

    #[tokio::test]
    async fn outbox_reports_tombstones_for_removed_items() {
        let db = db_with_link().await;
        let items = db
            .run(|c| {
                queries::add_to_watchlist(c, 1, 603, "movie")?;
                queries::remove_from_watchlist(c, 1, 603, "movie")?;
                queries::mark_watched_manually(c, 1, 1399, "tv", 1, 1, None, Some(3300.0))?;
                read_outbox(c, 1)
            })
            .await
            .unwrap();
        assert_eq!(items.len(), 2);
        let wl = items.iter().find(|i| i.kind == "watchlist").unwrap();
        assert!(wl.present.is_none());
        let ep = items.iter().find(|i| i.kind == "episode").unwrap();
        assert_eq!(ep.present.as_ref().map(|p| runtime_minutes(p.1)), Some(Some(55)));
    }
}
