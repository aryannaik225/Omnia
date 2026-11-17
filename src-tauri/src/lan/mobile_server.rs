//! LAN companion server: Omnia on your phone (Safari) and TV (the Android thin client) over
//! your own Wi-Fi, without any cloud.
//!
//! * `0.0.0.0:8765` (HTTP, axum) serves the same React app the desktop shows, plus
//!   `POST /api/invoke/{command}`, a JSON bridge to an allow-listed subset of the desktop's
//!   Tauri commands. Data never leaves the local network: phones and TVs read the desktop's
//!   SQLite through it, and OTT cookies, player windows and importers stay on the desktop.
//! * `0.0.0.0:8766` (UDP) answers `OMNIA_DISCOVER` broadcasts so the TV app can find the desktop.
//!
//! **Pairing.** Nothing but a pairing screen is served to a device that isn't paired. Settings
//! on the desktop shows a 6-digit PIN (and a QR code of the pairing link); a device that
//! submits it gets a random 256-bit token (an `HttpOnly` cookie for browsers, a bearer token
//! for the TV app). Only the token's SHA-256 is stored (`lan_devices`), and Settings can revoke
//! it. A PIN lasts 10 minutes, is replaced after every pairing, and after 5 wrong guesses.
//!
//! **Hardening.** Requests whose `Host` isn't an IP address, `localhost` or a `.local` name are
//! refused (DNS rebinding); cross-site requests are refused except from the TV app's own origin
//! (`http://tauri.localhost`); the cookie is `HttpOnly; SameSite=Lax`; and the LAN server's own
//! controls, profile deletion, history wipes, account linking and the player are never exposed.

use std::collections::HashMap;
use std::net::{IpAddr, TcpListener as StdTcpListener, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, Request, State as AxState};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use super::{AppResult, AppState};
use crate::db::queries::{self, LanDevice};
use crate::player::window_manager;

pub const PORT: u16 = 8765;
pub const DISCOVERY_PORT: u16 = 8766;
/// `app_settings` key: start the server with the app (`"true"`).
pub const SETTING_ENABLED: &str = "lan_server_enabled";
/// Settings with this prefix are never readable or writable from a LAN device.
const PRIVATE_SETTING_PREFIX: &str = "lan_";
pub const EVT_LAN_CHANGED: &str = "omnia://lan-changed";
const DISCOVER_PROBE: &[u8] = b"OMNIA_DISCOVER";

const PIN_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PIN_FAILURES: u32 = 5;
const COOKIE: &str = "omnia_lan";
/// The Android thin client's page origin (Tauri's Android asset host).
const TV_ORIGINS: &[&str] = &["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];

// ---------------------------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------------------------

struct Pin {
    code: String,
    expires: Instant,
}

struct Running {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    stop_discovery: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    running: Option<Running>,
    pin: Option<Pin>,
    failures: u32,
    last_error: Option<String>,
}

/// Managed state (`app.manage(LanServer::default())`).
#[derive(Default)]
pub struct LanServer {
    inner: Mutex<Inner>,
    remote: RemoteHub,
}

impl LanServer {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn is_running(&self) -> bool {
        self.lock().running.is_some()
    }

    /// The current PIN (a new one once the old one expired) and its remaining lifetime.
    fn current_pin(&self) -> (String, Duration) {
        let mut inner = self.lock();
        let now = Instant::now();
        if inner.pin.as_ref().is_none_or(|p| p.expires <= now) {
            inner.pin = Some(Pin { code: random_pin(), expires: now + PIN_TTL });
        }
        let p = inner.pin.as_ref().expect("pin set above");
        (p.code.clone(), p.expires.saturating_duration_since(now))
    }

    fn rotate_pin(&self) {
        let mut inner = self.lock();
        inner.pin = Some(Pin { code: random_pin(), expires: Instant::now() + PIN_TTL });
        inner.failures = 0;
    }

    /// Checks a submitted PIN. Wrong guesses count; the 5th replaces the PIN.
    fn check_pin(&self, submitted: &str) -> bool {
        let mut inner = self.lock();
        let now = Instant::now();
        let ok = inner.pin.as_ref().is_some_and(|p| p.expires > now && constant_time_eq(p.code.as_bytes(), submitted.trim().as_bytes()));
        if ok {
            inner.pin = Some(Pin { code: random_pin(), expires: now + PIN_TTL });
            inner.failures = 0;
        } else {
            inner.failures += 1;
            if inner.failures >= MAX_PIN_FAILURES {
                inner.pin = Some(Pin { code: random_pin(), expires: now + PIN_TTL });
                inner.failures = 0;
            }
        }
        ok
    }
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).expect("OS random number generator");
    buf
}

fn random_pin() -> String {
    let n = u32::from_le_bytes(random_bytes::<4>()) % 1_000_000;
    format!("{n:06}")
}

fn random_token() -> String {
    random_bytes::<32>().iter().map(|b| format!("{b:02x}")).collect()
}

fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// This computer's address on the local network (the interface that routes outward). Uses a
/// UDP "connect", which only picks a route: no packet is sent.
pub fn lan_address() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Omnia PC".into())
}

// ---------------------------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------------------------

/// Starts the HTTP server and the discovery responder (no-op when already running).
pub fn start(app: &AppHandle) -> Result<(), String> {
    let server = app.state::<LanServer>();
    if server.is_running() {
        return Ok(());
    }
    // Bind synchronously so a busy port is reported to Settings right away.
    let listener = StdTcpListener::bind(("0.0.0.0", PORT)).map_err(|e| format!("Port {PORT} is unavailable: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let router = router(app.clone());
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                log::warn!("LAN server could not start: {e}");
                return;
            }
        };
        let served = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = rx.await;
        });
        if let Err(e) = served.await {
            log::warn!("LAN server stopped: {e}");
        }
    });

    let stop_discovery = Arc::new(AtomicBool::new(false));
    spawn_discovery_responder(stop_discovery.clone());

    let mut inner = server.lock();
    inner.running = Some(Running { shutdown: Some(tx), stop_discovery });
    inner.last_error = None;
    drop(inner);
    server.current_pin();
    log::info!("LAN companion server listening on port {PORT}");
    Ok(())
}

pub fn stop(app: &AppHandle) {
    let server = app.state::<LanServer>();
    let mut inner = server.lock();
    if let Some(mut running) = inner.running.take() {
        running.stop_discovery.store(true, Ordering::SeqCst);
        if let Some(tx) = running.shutdown.take() {
            let _ = tx.send(());
        }
        log::info!("LAN companion server stopped");
    }
}

/// Starts the server at launch when Settings enabled it.
pub fn start_if_enabled(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let enabled = state.db.run(|c| queries::get_setting(c, SETTING_ENABLED)).await.ok().flatten().is_some_and(|v| v == "true");
        if enabled {
            if let Err(e) = start(&app) {
                log::warn!("LAN companion server: {e}");
                app.state::<LanServer>().lock().last_error = Some(e);
            }
        }
    });
}

/// Answers TV discovery broadcasts with this computer's name and the HTTP port. Nothing else
/// (no profiles, no data) is ever sent over UDP.
fn spawn_discovery_responder(stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let socket = match UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("LAN discovery responder unavailable (UDP {DISCOVERY_PORT}): {e}");
                return;
            }
        };
        let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
        let reply = json!({ "omnia": 1, "name": host_name(), "port": PORT }).to_string();
        let mut buf = [0u8; 64];
        while !stop.load(Ordering::SeqCst) {
            if let Ok((n, from)) = socket.recv_from(&mut buf) {
                if buf[..n].starts_with(DISCOVER_PROBE) {
                    let _ = socket.send_to(reply.as_bytes(), from);
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Desktop-only commands (Settings → Linked Devices). Never reachable over the LAN bridge.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStatus {
    enabled: bool,
    running: bool,
    port: u16,
    address: Option<String>,
    /// `http://<address>:8765/pair?pin=<pin>`: the QR code's content.
    pair_url: Option<String>,
    pin: Option<String>,
    pin_expires_in_secs: Option<u64>,
    devices: Vec<LanDevice>,
    error: Option<String>,
}

async fn status(app: &AppHandle) -> AppResult<LanStatus> {
    let state = app.state::<AppState>();
    let (enabled, devices) = state
        .db
        .run(|c| Ok((queries::get_setting(c, SETTING_ENABLED)?.is_some_and(|v| v == "true"), queries::list_lan_devices(c)?)))
        .await?;
    let server = app.state::<LanServer>();
    let running = server.is_running();
    let address = lan_address().map(|ip| ip.to_string());
    let (pin, ttl) = if running { let (p, t) = server.current_pin(); (Some(p), Some(t.as_secs())) } else { (None, None) };
    let pair_url = match (&address, &pin) {
        (Some(a), Some(p)) => Some(format!("http://{a}:{PORT}/pair?pin={p}")),
        _ => None,
    };
    let error = server.lock().last_error.clone();
    Ok(LanStatus { enabled, running, port: PORT, address, pair_url, pin, pin_expires_in_secs: ttl, devices, error })
}

#[tauri::command]
pub async fn lan_status(app: AppHandle) -> AppResult<LanStatus> {
    status(&app).await
}

/// Turns the companion server on or off (remembered for the next launch).
#[tauri::command]
pub async fn lan_set_enabled(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> AppResult<LanStatus> {
    state.db.run(move |c| queries::set_setting(c, SETTING_ENABLED, if enabled { "true" } else { "false" })).await?;
    if enabled {
        let result = start(&app);
        app.state::<LanServer>().lock().last_error = result.err();
    } else {
        stop(&app);
    }
    status(&app).await
}

#[tauri::command]
pub async fn lan_new_pin(app: AppHandle) -> AppResult<LanStatus> {
    app.state::<LanServer>().rotate_pin();
    status(&app).await
}

#[tauri::command]
pub async fn lan_revoke_device(app: AppHandle, state: State<'_, AppState>, device_id: i64) -> AppResult<LanStatus> {
    state.db.run(move |c| queries::revoke_lan_device(c, device_id)).await?;
    status(&app).await
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
}

fn router(app: AppHandle) -> Router {
    let ctx = Ctx { app };
    Router::new()
        .route("/api/ping", get(ping))
        .route("/api/pair", post(pair))
        .route("/api/invoke/{command}", post(invoke))
        .route("/api/remote/targets", get(remote_targets))
        .route("/api/remote/send", post(remote_send))
        .route("/api/remote/poll", get(remote_poll))
        .fallback(page_or_asset)
        .layer(middleware::from_fn(guard))
        .with_state(ctx)
}

fn host_of(headers: &HeaderMap) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?.trim().to_ascii_lowercase();
    // Strip the port ("[::1]:8765", "192.168.1.5:8765").
    let name = if let Some(rest) = host.strip_prefix('[') { rest.split(']').next()?.to_string() } else { host.rsplit_once(':').map(|(h, _)| h.to_string()).unwrap_or(host) };
    Some(name)
}

/// IP literals, `localhost` and mDNS `.local` names only: a DNS-rebinding page served from an
/// attacker's domain arrives with that domain as its Host and is refused.
fn host_allowed(host: &str) -> bool {
    host.parse::<IpAddr>().is_ok() || host == "localhost" || host.ends_with(".local") || host.eq_ignore_ascii_case(&host_name())
}

fn tv_origin(origin: &str) -> bool {
    TV_ORIGINS.contains(&origin)
}

/// Host check, same-origin / TV-origin check and CORS for the TV app.
async fn guard(req: Request, next: Next) -> Response {
    let headers = req.headers().clone();
    let Some(host) = host_of(&headers).filter(|h| host_allowed(h)) else {
        return (StatusCode::MISDIRECTED_REQUEST, "Omnia only answers on its local address.").into_response();
    };
    let origin = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()).map(str::to_string);
    let from_tv = origin.as_deref().is_some_and(tv_origin);
    if let Some(o) = origin.as_deref() {
        let same = o.strip_prefix("http://").is_some_and(|rest| {
            let h = rest.split(':').next().unwrap_or(rest).trim_start_matches('[').trim_end_matches(']');
            h.eq_ignore_ascii_case(&host)
        });
        if !same && !from_tv {
            return (StatusCode::FORBIDDEN, "Cross-site requests are not allowed.").into_response();
        }
    }
    if req.method() == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        if from_tv {
            add_cors(&mut res, origin.as_deref().unwrap_or_default());
        }
        return res;
    }
    let mut res = next.run(req).await;
    if from_tv {
        add_cors(&mut res, origin.as_deref().unwrap_or_default());
    }
    let h = res.headers_mut();
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    // Origin only, never the path (YouTube embeds need a referrer; the address is the PC's LAN IP).
    h.insert("referrer-policy", HeaderValue::from_static("strict-origin-when-cross-origin"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    res
}

fn add_cors(res: &mut Response, origin: &str) {
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(origin) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    // Chromium's Private Network Access preflight (the TV app reaching a LAN address).
    h.insert("access-control-allow-private-network", HeaderValue::from_static("true"));
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("authorization, content-type"));
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    h.insert(header::VARY, HeaderValue::from_static("Origin"));
}

/// The device's token: the `omnia_lan` cookie (browsers) or `Authorization: Bearer` (TV app).
fn presented_token(headers: &HeaderMap) -> Option<String> {
    if let Some(bearer) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")) {
        return Some(bearer.trim().to_string());
    }
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|kv| kv.trim().strip_prefix(&format!("{COOKIE}=")).map(str::to_string))
}

/// The paired device making the request, if any.
async fn device_of(ctx: &Ctx, headers: &HeaderMap) -> Option<i64> {
    let token = presented_token(headers).filter(|t| t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()))?;
    let hash = token_hash(&token);
    let state = ctx.app.state::<AppState>();
    state.db.run(move |c| queries::touch_lan_device(c, &hash)).await.ok().flatten()
}

async fn authorized(ctx: &Ctx, headers: &HeaderMap) -> bool {
    device_of(ctx, headers).await.is_some()
}

// ---------------------------------------------------------------------------------------------
// Phone remote control
//
// A paired phone sends D-pad keys to a "screen": this PC (its catalog window, or the open
// player) or a TV running the thin client. TVs pick up their keys with a long-poll
// (`GET /api/remote/poll`), so no extra connection type is needed.
// ---------------------------------------------------------------------------------------------

/// Keys a remote may send.
pub const REMOTE_KEYS: &[&str] = &["up", "down", "left", "right", "ok", "back", "home", "playpause"];
pub const EVT_REMOTE_KEY: &str = "omnia://remote-key";
/// A TV counts as "on" while it has polled within this window.
const SCREEN_ONLINE: Duration = Duration::from_secs(40);
const POLL_WAIT: Duration = Duration::from_secs(25);

#[derive(Clone, Debug)]
struct RemoteCmd {
    device_id: i64,
    key: String,
}

pub struct RemoteHub {
    tx: tokio::sync::broadcast::Sender<RemoteCmd>,
    /// TVs currently polling: device id → last poll.
    screens: Mutex<HashMap<i64, Instant>>,
}

impl Default for RemoteHub {
    fn default() -> Self {
        Self { tx: tokio::sync::broadcast::channel(64).0, screens: Mutex::new(HashMap::new()) }
    }
}

impl RemoteHub {
    fn mark_online(&self, device_id: i64) {
        self.screens.lock().unwrap_or_else(|p| p.into_inner()).insert(device_id, Instant::now());
    }

    fn online(&self) -> Vec<i64> {
        let mut screens = self.screens.lock().unwrap_or_else(|p| p.into_inner());
        screens.retain(|_, seen| seen.elapsed() < SCREEN_ONLINE);
        let mut list: Vec<(i64, Instant)> = screens.iter().map(|(k, v)| (*k, *v)).collect();
        list.sort_by_key(|(_, seen)| std::cmp::Reverse(*seen));
        list.into_iter().map(|(id, _)| id).collect()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTarget {
    /// `"pc"` or a paired TV's device id.
    id: String,
    name: String,
    kind: &'static str,
}

async fn remote_targets(AxState(ctx): AxState<Ctx>, headers: HeaderMap) -> Response {
    let Some(me) = device_of(&ctx, &headers).await else { return StatusCode::UNAUTHORIZED.into_response() };
    let online = ctx.app.state::<LanServer>().remote.online();
    let state = ctx.app.state::<AppState>();
    let devices = state.db.run(|c| queries::list_lan_devices(c)).await.unwrap_or_default();
    let mut targets = vec![RemoteTarget { id: "pc".into(), name: host_name(), kind: "pc" }];
    for id in online.into_iter().filter(|id| *id != me) {
        if let Some(d) = devices.iter().find(|d| d.device_id == id) {
            targets.insert(1, RemoteTarget { id: id.to_string(), name: d.device_name.clone(), kind: "tv" });
        }
    }
    // Most recently active TV first, then this PC.
    if targets.len() > 1 {
        let pc = targets.remove(0);
        targets.push(pc);
    }
    Json(targets).into_response()
}

#[derive(Deserialize)]
struct RemoteSend {
    target: String,
    key: String,
}

async fn remote_send(AxState(ctx): AxState<Ctx>, headers: HeaderMap, Json(body): Json<RemoteSend>) -> Response {
    if !authorized(&ctx, &headers).await {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !REMOTE_KEYS.contains(&body.key.as_str()) {
        return (StatusCode::BAD_REQUEST, "unknown key").into_response();
    }
    if body.target == "pc" {
        // The open player takes the key first (play / pause, seek, back to hub).
        if !window_manager::remote_control_player(&ctx.app, &body.key).await {
            if body.key == "home" {
                window_manager::focus_main_window(&ctx.app);
            }
            let _ = ctx.app.emit_to(window_manager::MAIN_LABEL, EVT_REMOTE_KEY, json!({ "key": body.key }));
        }
        return StatusCode::NO_CONTENT.into_response();
    }
    let Ok(device_id) = body.target.parse::<i64>() else { return (StatusCode::BAD_REQUEST, "unknown screen").into_response() };
    // Nobody listening (the TV is off) is not an error for a remote: the key is just dropped.
    let _ = ctx.app.state::<LanServer>().remote.tx.send(RemoteCmd { device_id, key: body.key });
    StatusCode::NO_CONTENT.into_response()
}

/// TV thin client: waits up to 25 s for the next key sent to it.
async fn remote_poll(AxState(ctx): AxState<Ctx>, headers: HeaderMap) -> Response {
    let Some(me) = device_of(&ctx, &headers).await else { return StatusCode::UNAUTHORIZED.into_response() };
    let server = ctx.app.state::<LanServer>();
    let mut rx = server.remote.tx.subscribe();
    server.remote.mark_online(me);
    let wait = async {
        loop {
            match rx.recv().await {
                Ok(cmd) if cmd.device_id == me => return Some(cmd.key),
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return None,
            }
        }
    };
    let key = tokio::time::timeout(POLL_WAIT, wait).await.ok().flatten();
    server.remote.mark_online(me);
    match key {
        Some(key) => Json(json!({ "key": key })).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

async fn ping(AxState(ctx): AxState<Ctx>, headers: HeaderMap) -> Json<Value> {
    let paired = authorized(&ctx, &headers).await;
    Json(json!({ "omnia": 1, "name": host_name(), "paired": paired }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairBody {
    pin: String,
    #[serde(default)]
    device_name: Option<String>,
}

fn device_name_from(headers: &HeaderMap, given: Option<String>) -> String {
    let given = given.map(|n| n.chars().filter(|c| !c.is_control()).take(40).collect::<String>()).filter(|n| !n.trim().is_empty());
    if let Some(n) = given {
        return n.trim().to_string();
    }
    let ua = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or_default();
    if ua.contains("iPhone") {
        "iPhone".into()
    } else if ua.contains("iPad") {
        "iPad".into()
    } else if ua.contains("Android") {
        "Android device".into()
    } else {
        "Web browser".into()
    }
}

async fn pair(AxState(ctx): AxState<Ctx>, headers: HeaderMap, Json(body): Json<PairBody>) -> Response {
    let server = ctx.app.state::<LanServer>();
    if !server.check_pin(&body.pin) {
        // Slows guessing down further (each PIN allows 5 guesses before it is replaced).
        tokio::time::sleep(Duration::from_millis(900)).await;
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "That PIN isn't right. Check the PIN shown in Omnia's Settings on your PC." }))).into_response();
    }
    // Pairing again from a device that is still paired (it still holds its old token) replaces
    // that entry instead of listing the same phone twice.
    let previous = device_of(&ctx, &headers).await;
    let token = random_token();
    let hash = token_hash(&token);
    let name = device_name_from(&headers, body.device_name);
    let state = ctx.app.state::<AppState>();
    let n = name.clone();
    let added = state
        .db
        .run(move |c| {
            if let Some(old) = previous {
                queries::revoke_lan_device(c, old)?;
            }
            queries::add_lan_device(c, &n, &hash)
        })
        .await;
    if let Err(e) = added {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response();
    }
    log::info!("LAN device paired: {name}{}", if previous.is_some() { " (replaced its earlier pairing)" } else { "" });
    let _ = ctx.app.emit_to(window_manager::MAIN_LABEL, EVT_LAN_CHANGED, ());
    // Lax, not Strict: Safari withholds Strict cookies when it restores or reloads a tab that was
    // first opened from outside (the QR code via the Camera app), which looked like a lost pairing.
    // Cross-site POSTs are still refused by the Origin check in `guard`.
    let cookie = format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000");
    let mut res = Json(json!({ "token": token, "deviceName": name })).into_response();
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        res.headers_mut().insert(header::SET_COOKIE, v);
    }
    res
}

async fn invoke(AxState(ctx): AxState<Ctx>, Path(command): Path<String>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    if !authorized(&ctx, &headers).await {
        return (StatusCode::UNAUTHORIZED, Json(json!("This device isn't paired with Omnia (or was revoked)."))).into_response();
    }
    let args: Value = if body.is_empty() { json!({}) } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => return (StatusCode::BAD_REQUEST, Json(json!(format!("invalid JSON: {e}")))).into_response(),
        }
    };
    match dispatch(&ctx.app, &command, args).await {
        Ok(v) => Json(v).into_response(),
        // Tauri rejects an `invoke` with the error string; the bridge mirrors that.
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!(e))).into_response(),
    }
}

// ---------------------------------------------------------------------------------------------
// Pages & static assets
// ---------------------------------------------------------------------------------------------

async fn page_or_asset(AxState(ctx): AxState<Ctx>, req: Request) -> Response {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = req.uri().path().to_string();
    if path == "/pair" {
        return pairing_page();
    }
    if !authorized(&ctx, req.headers()).await {
        // Unpaired devices only ever see the pairing screen.
        let is_page = path == "/" || !path.rsplit('/').next().unwrap_or_default().contains('.');
        return if is_page { pairing_page() } else { (StatusCode::UNAUTHORIZED, "Pair this device first.").into_response() };
    }
    serve_asset(&ctx.app, &path)
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "wasm" => "application/wasm",
        "onnx" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn serve_asset(app: &AppHandle, path: &str) -> Response {
    if path.split('/').any(|seg| seg == "..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let wanted = if path == "/" { "/index.html".to_string() } else { path.to_string() };
    let is_page = !wanted.rsplit('/').next().unwrap_or_default().contains('.');
    // Unknown client-side routes get the app shell (SPA).
    let candidates = if is_page { vec!["/index.html".to_string()] } else { vec![wanted.clone()] };
    for key in candidates {
        let resolver = app.asset_resolver();
        if let Some(asset) = resolver.get(key.clone()) {
            return asset_response(&key, asset.bytes().to_vec(), asset.mime_type().to_string(), asset.csp_header().map(str::to_string));
        }
        // `tauri dev` serves the frontend from Vite, so nothing is embedded: use the last build.
        if cfg!(debug_assertions) {
            let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist").join(key.trim_start_matches('/'));
            if let Ok(bytes) = std::fs::read(&file) {
                return asset_response(&key, bytes, mime_for(&key).to_string(), None);
            }
        }
    }
    if is_page {
        return (StatusCode::SERVICE_UNAVAILABLE, "The Omnia web app isn't built yet: run `npm run build` on the PC.").into_response();
    }
    StatusCode::NOT_FOUND.into_response()
}

fn asset_response(key: &str, bytes: Vec<u8>, mime: String, csp: Option<String>) -> Response {
    let mut res = Response::new(Body::from(bytes));
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        h.insert(header::CONTENT_TYPE, v);
    }
    // Hashed build assets never change; the shell always revalidates.
    let cache = if key.starts_with("/assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Some(v) = csp.and_then(|c| HeaderValue::from_str(&c).ok()) {
        h.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    res
}

/// Standalone pairing screen (no app code, no data). `/pair?pin=123456` (the QR code) pairs at once.
fn pairing_page() -> Response {
    let mut res = Response::new(Body::from(PAIRING_HTML));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'"),
    );
    res
}

const PAIRING_HTML: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark"><title>Pair with Omnia</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:radial-gradient(120% 80% at 20% 0%,#2a2350 0%,#0b0b0f 60%);color:#f5f5f7;font:16px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
.card{width:100%;max-width:400px;padding:32px 24px;border-radius:24px;background:rgba(18,18,22,.65);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 24px 60px rgba(0,0,0,.5);text-align:center}
h1{margin:0 0 6px;font-size:28px;letter-spacing:-.02em}p{margin:0;color:rgba(235,235,245,.7)}
input{display:block;width:100%;margin:24px 0 14px;padding:14px;border:0;border-radius:12px;background:rgba(255,255,255,.1);color:#fff;font:600 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.4em;text-align:center;outline:none}
input:focus{box-shadow:0 0 0 2px rgba(255,255,255,.7)}
button{width:100%;padding:14px;border:0;border-radius:12px;background:#f5f5f7;color:#111;font-weight:600;font-size:16px}
button:disabled{opacity:.5}.err{min-height:22px;margin-top:12px;color:#ff6961;font-size:14px}.hint{margin-top:18px;font-size:13px;color:rgba(235,235,245,.5)}
</style></head><body><main class="card">
<h1>Pair with Omnia</h1><p>Enter the 6-digit PIN shown on your PC in <b>Settings → Linked Devices</b>.</p>
<form id="f"><input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="••••••" aria-label="Pairing PIN" required>
<button id="go" type="submit">Pair this device</button></form><div class="err" id="err" role="alert"></div>
<p class="hint">Your history stays on your PC. This device only reads it over your Wi-Fi.</p></main>
<script>
(function(){var f=document.getElementById("f"),pin=document.getElementById("pin"),go=document.getElementById("go"),err=document.getElementById("err");
function name(){var u=navigator.userAgent;return /iPhone/.test(u)?"iPhone":/iPad/.test(u)?"iPad":/Android/.test(u)?"Android device":"Web browser"}
function submit(){var v=pin.value.replace(/\D/g,"");if(v.length!==6){err.textContent="The PIN has 6 digits.";return}
go.disabled=true;err.textContent="";fetch("/api/pair",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify({pin:v,deviceName:name()})})
.then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||"Pairing failed");location.replace("/")})})
.catch(function(e){err.textContent=e.message;go.disabled=false;pin.select()})}
f.addEventListener("submit",function(e){e.preventDefault();submit()});
var q=new URLSearchParams(location.search).get("pin");if(q){pin.value=q;history.replaceState(null,"","/pair");submit()}else pin.focus()})();
</script></body></html>"#;

// ---------------------------------------------------------------------------------------------
// Command bridge (allow-list)
// ---------------------------------------------------------------------------------------------

fn out<T: Serialize>(r: AppResult<T>) -> Result<Value, String> {
    r.map_err(|e| e.to_string()).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// Deserialises the camelCase argument object into a tuple of the named parameters.
macro_rules! args {
    ($v:expr; $( $arg:ident : $ty:ty ),* ) => {{
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        #[allow(dead_code)]
        struct A { $( $arg: $ty, )* }
        #[allow(unused_variables)]
        let a: A = serde_json::from_value($v).map_err(|e| format!("invalid arguments: {e}"))?;
        ( $( a.$arg, )* )
    }};
}

/// One allow-listed command: `[state]`, `[app]` or `[app, state]` leading parameters, then args.
macro_rules! call {
    ($app:ident, $v:ident, $f:path, [state] $(, $arg:ident : $ty:ty )* ) => {{
        #[allow(unused_parens, clippy::let_unit_value)]
        let ( $( $arg, )* ) = args!($v; $( $arg: $ty ),*);
        out($f($app.state(), $( $arg ),*).await)
    }};
    ($app:ident, $v:ident, $f:path, [app] $(, $arg:ident : $ty:ty )* ) => {{
        #[allow(unused_parens, clippy::let_unit_value)]
        let ( $( $arg, )* ) = args!($v; $( $arg: $ty ),*);
        out($f($app.clone(), $( $arg ),*).await)
    }};
}

fn private_setting(key: &str) -> bool {
    key.starts_with(PRIVATE_SETTING_PREFIX)
}

/// Runs an allow-listed desktop command for a paired device. Everything that opens windows on
/// the PC, links OTT accounts, deletes profiles or wipes history, or controls this server is
/// deliberately missing.
#[allow(clippy::unused_unit)]
async fn dispatch(app: &AppHandle, command: &str, v: Value) -> Result<Value, String> {
    use super as d;
    use crate::ml::recommender as rec;
    match command {
        // Profiles (no deletion over the LAN).
        "list_profiles" => call!(app, v, d::list_profiles, [state]),
        "create_profile" => call!(app, v, d::create_profile, [state], profile_name: String, avatar_asset: Option<String>, is_kids_profile: bool),
        "update_profile" => call!(app, v, d::update_profile, [state], profile_id: i64, profile_name: String, avatar_asset: Option<String>, is_kids_profile: bool),

        // Settings, minus this server's own.
        "get_setting" => {
            let (key,) = args!(v; key: String);
            if private_setting(&key) {
                return Ok(Value::Null);
            }
            out(d::get_setting(app.state(), key).await)
        }
        "get_all_settings" => {
            let all: HashMap<String, String> = d::get_all_settings(app.state()).await.map_err(|e| e.to_string())?;
            out::<HashMap<String, String>>(Ok(all.into_iter().filter(|(k, _)| !private_setting(k)).collect()))
        }
        "set_setting" => {
            let (key, value) = args!(v; key: String, value: String);
            if private_setting(&key) {
                return Err("This setting can only be changed on the PC.".into());
            }
            out(d::set_setting(app.state(), key, value).await)
        }
        "delete_setting" => {
            let (key,) = args!(v; key: String);
            if private_setting(&key) {
                return Err("This setting can only be changed on the PC.".into());
            }
            out(d::delete_setting(app.state(), key).await)
        }

        // Linked accounts are read-only here: linking needs the PC's player window.
        "list_ott_profile_mappings" => call!(app, v, d::list_ott_profile_mappings, [state], app_profile_id: i64),
        "get_sync_states" => call!(app, v, d::get_sync_states, [state], app_profile_id: i64),
        "sync_accounts_now" => call!(app, v, d::sync_accounts_now, [app], app_profile_id: i64),

        // Subscriptions & catalog.
        "list_subscribed_providers" => call!(app, v, d::list_subscribed_providers, [state], region_code: String, active_only: bool),
        "set_subscribed_providers" => call!(app, v, d::set_subscribed_providers, [state], region_code: String, providers: Vec<queries::SubscribedProvider>),
        "set_provider_active" => call!(app, v, d::set_provider_active, [state], provider_id: i64, region_code: String, is_active: bool),
        "cache_media_metadata" => call!(app, v, d::cache_media_metadata, [state], entries: Vec<queries::MediaCatalogEntry>),
        "get_cached_media" => call!(app, v, d::get_cached_media, [state], tmdb_id: i64, media_type: String),
        "list_custom_hubs" => call!(app, v, d::list_custom_hubs, [state], category_type: Option<String>),
        "upsert_custom_hubs" => call!(app, v, d::upsert_custom_hubs, [state], hubs: Vec<queries::CustomHub>),

        // Deep links & provider choice.
        "resolve_deep_links" => call!(app, v, d::resolve_deep_links, [state], request: crate::resolver::justwatch::ResolveRequest),
        "get_cached_deep_links" => call!(app, v, d::get_cached_deep_links, [state], tmdb_id: i64, media_type: String, region_code: String),
        "get_preferred_provider" => call!(app, v, d::get_preferred_provider, [state], app_profile_id: i64, tmdb_id: i64, media_type: String),
        "set_preferred_provider" => call!(app, v, d::set_preferred_provider, [state], app_profile_id: i64, tmdb_id: i64, media_type: String, provider_id: i64, provider_name: String),
        "clear_preferred_provider" => call!(app, v, d::clear_preferred_provider, [state], app_profile_id: i64, tmdb_id: i64, media_type: String),

        // Continue Watching & history (per-title removal only; no bulk wipes).
        "get_continue_watching" => call!(app, v, d::get_continue_watching, [state], app_profile_id: i64, limit: Option<i64>),
        "hide_from_continue_watching" => call!(app, v, d::hide_from_continue_watching, [state], app_profile_id: i64, tmdb_id: i64, media_type: String),
        "unhide_from_continue_watching" => call!(app, v, d::unhide_from_continue_watching, [state], app_profile_id: i64, tmdb_id: i64, media_type: String),
        "get_watch_history" => call!(app, v, d::get_watch_history, [state], app_profile_id: i64, limit: Option<i64>, offset: Option<i64>),
        "get_title_progress" => call!(app, v, d::get_title_progress, [state], app_profile_id: i64, tmdb_id: i64, media_type: String),
        "get_history_titles" => call!(app, v, d::get_history_titles, [state], app_profile_id: i64, limit: Option<i64>, offset: Option<i64>, provider_id: Option<i64>),
        "get_history_provider_counts" => call!(app, v, d::get_history_provider_counts, [state], app_profile_id: i64),
        "delete_watch_history_entry" => call!(app, v, d::delete_watch_history_entry, [state], app_profile_id: i64, id: i64),
        "delete_title_history" => call!(app, v, d::delete_title_history, [state], app_profile_id: i64, tmdb_id: i64, media_type: String),
        "mark_title_completed" => call!(app, v, d::mark_title_completed, [state], app_profile_id: i64, tmdb_id: i64, media_type: String, season_number: i64, episode_number: i64),
        "mark_watched" => call!(app, v, d::mark_watched, [state], app_profile_id: i64, tmdb_id: i64, media_type: String, season_number: Option<i64>, episode_number: Option<i64>, episode_title: Option<String>, duration_seconds: Option<f64>),
        "mark_episodes_watched" => call!(app, v, d::mark_episodes_watched, [state], app_profile_id: i64, tmdb_id: i64, episodes: Vec<queries::EpisodeMark>),
        "unmark_watched" => call!(app, v, d::unmark_watched, [state], app_profile_id: i64, tmdb_id: i64, media_type: String, season_number: Option<i64>, episode_number: Option<i64>),
        "check_airing_shows" => call!(app, v, d::check_airing_shows, [state], app_profile_id: i64),
        "export_watch_history" => call!(app, v, d::export_watch_history, [state], app_profile_id: i64),
        "identify_title" => call!(app, v, d::identify_title, [state], title: String, media_type: String, release_year: Option<i64>),
        "log_playback_event" => call!(app, v, d::log_playback_event, [state], app_profile_id: i64, tmdb_id: i64, media_type: String, event_type: String, session_watch_duration_sec: Option<f64>),
        "list_playback_events" => call!(app, v, d::list_playback_events, [state], app_profile_id: i64, since: Option<String>, limit: Option<i64>),

        // Library.
        "add_to_watchlist" => call!(app, v, d::add_to_watchlist, [state], app_profile_id: i64, tmdb_id: i64, media_type: String),
        "remove_from_watchlist" => call!(app, v, d::remove_from_watchlist, [state], app_profile_id: i64, tmdb_id: i64, media_type: String),
        "get_watchlist" => call!(app, v, d::get_watchlist, [state], app_profile_id: i64),
        "is_in_watchlist" => call!(app, v, d::is_in_watchlist, [state], app_profile_id: i64, tmdb_id: i64, media_type: String),
        "set_favorite" => call!(app, v, d::set_favorite, [state], app_profile_id: i64, tmdb_id: i64, media_type: String, favorite: bool),
        "is_favorite" => call!(app, v, d::is_favorite, [state], app_profile_id: i64, tmdb_id: i64, media_type: String),
        "get_favorites" => call!(app, v, d::get_favorites, [state], app_profile_id: i64),
        "get_collections" => call!(app, v, d::get_collections, [state], app_profile_id: i64),
        "create_collection" => call!(app, v, d::create_collection, [state], app_profile_id: i64, name: String),
        "rename_collection" => call!(app, v, d::rename_collection, [state], app_profile_id: i64, collection_id: i64, name: String),
        "delete_collection" => call!(app, v, d::delete_collection, [state], app_profile_id: i64, collection_id: i64),
        "add_to_collection" => call!(app, v, d::add_to_collection, [state], app_profile_id: i64, collection_id: i64, tmdb_id: i64, media_type: String),
        "remove_from_collection" => call!(app, v, d::remove_from_collection, [state], app_profile_id: i64, collection_id: i64, tmdb_id: i64, media_type: String),
        "get_collection_items" => call!(app, v, d::get_collection_items, [state], app_profile_id: i64, collection_id: i64),
        "get_title_collections" => call!(app, v, d::get_title_collections, [state], app_profile_id: i64, tmdb_id: i64, media_type: String),

        // Recommendations.
        "get_recommendations" => call!(app, v, rec::get_recommendations, [app], app_profile_id: i64, force_refresh: Option<bool>),
        "get_taste_summary" => call!(app, v, rec::get_taste_summary, [state], app_profile_id: i64, limit: Option<usize>),
        "get_embedding_status" => call!(app, v, rec::get_embedding_status, [state]),
        "get_similar_titles" => call!(app, v, rec::get_similar_titles, [app], app_profile_id: i64, tmdb_id: i64, media_type: String),

        // The PC's player is the PC's: a remote device only sees whether one is open.
        "get_player_status" => call!(app, v, window_manager::get_player_status, [state]),

        other => Err(format!("'{other}' isn't available from another device. Use Omnia on your PC for this.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_origins() {
        assert!(host_allowed("192.168.1.5"));
        assert!(host_allowed("::1"));
        assert!(host_allowed("localhost"));
        assert!(host_allowed("omnia-pc.local"));
        assert!(!host_allowed("evil.example.com"));
        assert!(tv_origin("http://tauri.localhost"));
        assert!(!tv_origin("https://evil.example.com"));
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("192.168.1.5:8765"));
        assert_eq!(host_of(&h).as_deref(), Some("192.168.1.5"));
        h.insert(header::HOST, HeaderValue::from_static("[fe80::1]:8765"));
        assert_eq!(host_of(&h).as_deref(), Some("fe80::1"));
    }

    #[test]
    fn tokens_from_cookie_or_bearer() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("a=1; omnia_lan=abc; b=2"));
        assert_eq!(presented_token(&h).as_deref(), Some("abc"));
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer xyz"));
        assert_eq!(presented_token(&h).as_deref(), Some("xyz"));
    }

    #[test]
    fn pins_rotate_after_success_and_too_many_failures() {
        let server = LanServer::default();
        let (pin, ttl) = server.current_pin();
        assert_eq!(pin.len(), 6);
        assert!(ttl > Duration::from_secs(500));
        assert!(server.check_pin(&pin));
        // Used once: the old PIN no longer works.
        assert!(!server.check_pin(&pin));
        let (fresh, _) = server.current_pin();
        for _ in 0..MAX_PIN_FAILURES {
            let wrong = if fresh == "000000" { "111111" } else { "000000" };
            server.check_pin(wrong);
        }
        // Five wrong guesses replaced it.
        assert_ne!(server.current_pin().0, fresh);
        assert_eq!(token_hash("x").len(), 64);
        assert_eq!(random_token().len(), 64);
    }

    #[test]
    fn remote_screens_are_listed_newest_first_and_expire() {
        let hub = RemoteHub::default();
        hub.mark_online(3);
        std::thread::sleep(Duration::from_millis(5));
        hub.mark_online(9);
        assert_eq!(hub.online(), vec![9, 3]);
        hub.screens.lock().unwrap().insert(3, Instant::now() - SCREEN_ONLINE - Duration::from_secs(1));
        assert_eq!(hub.online(), vec![9]);
        assert!(REMOTE_KEYS.contains(&"playpause") && !REMOTE_KEYS.contains(&"power"));
    }

    #[test]
    fn lan_settings_are_private() {
        assert!(private_setting(SETTING_ENABLED));
        assert!(!private_setting("region_code"));
    }
}
