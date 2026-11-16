//! Android TV / Fire TV thin client.
//!
//! No database, no OTT sessions, no importer: the TV is a window onto the desktop. The
//! frontend (built with `VITE_OMNIA_THIN_CLIENT=1`) talks to the desktop's LAN server over
//! HTTP with the token it got from pairing; Rust here only does what a web page can't:
//!
//! * [`discover_lan_servers`]: a UDP broadcast (`OMNIA_DISCOVER` → port 8766) that the
//!   desktop answers with its name and HTTP port, so the TV finds the PC without typing an IP.
//! * [`open_in_app`]: hands playback to the installed OTT app with an Android `ACTION_VIEW`
//!   intent (`nflx://…`, `https://www.primevideo.com/…` App Links, …), trying each candidate
//!   URL in order until one opens. The OTT app tracks progress on its own servers, and the
//!   desktop's background delta sync reads it from there.

use std::net::UdpSocket;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const DISCOVERY_PORT: u16 = 8766;
const DISCOVER_PROBE: &[u8] = b"OMNIA_DISCOVER";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundServer {
    pub host: String,
    pub port: u16,
    pub name: String,
}

#[derive(Deserialize)]
struct Reply {
    omnia: u8,
    #[serde(default)]
    name: String,
    port: u16,
}

fn parse_reply(bytes: &[u8], host: String) -> Option<FoundServer> {
    let r: Reply = serde_json::from_slice(bytes).ok()?;
    (r.omnia == 1 && r.port > 0).then(|| FoundServer { host, port: r.port, name: if r.name.is_empty() { "Omnia PC".into() } else { r.name } })
}

/// Broadcasts a discovery probe and collects the desktops that answer within `wait`.
pub fn discover(wait: Duration) -> Vec<FoundServer> {
    let mut found: Vec<FoundServer> = Vec::new();
    let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else { return found };
    let _ = socket.set_broadcast(true);
    let _ = socket.set_read_timeout(Some(Duration::from_millis(250)));
    let deadline = Instant::now() + wait;
    let mut next_probe = Instant::now();
    let mut buf = [0u8; 512];
    while Instant::now() < deadline {
        // Wi-Fi drops broadcasts now and then: probe a few times.
        if Instant::now() >= next_probe {
            let _ = socket.send_to(DISCOVER_PROBE, ("255.255.255.255", DISCOVERY_PORT));
            next_probe = Instant::now() + Duration::from_millis(500);
        }
        if let Ok((n, from)) = socket.recv_from(&mut buf) {
            if let Some(server) = parse_reply(&buf[..n], from.ip().to_string()) {
                if !found.iter().any(|f| f.host == server.host) {
                    found.push(server);
                }
            }
        }
    }
    found
}

/// Schemes the TV may hand to Android: web App Links and the OTT apps' own schemes. Never
/// `intent:`, `file:`, `content:` or `javascript:`.
fn openable(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else { return false };
    !rest.is_empty()
        && matches!(
            scheme.to_ascii_lowercase().as_str(),
            "https" | "nflx" | "aiv" | "primevideo" | "hotstar" | "zee5" | "sonyliv" | "jiocinema" | "disneyplus" | "hbomax" | "max" | "hulu" | "peacock" | "videos" | "com.apple.tv"
        )
}

#[tauri::command]
pub async fn discover_lan_servers() -> Result<Vec<FoundServer>, String> {
    tauri::async_runtime::spawn_blocking(|| discover(Duration::from_millis(1800)))
        .await
        .map_err(|e| e.to_string())
}

/// Opens the first candidate URL some installed app accepts; returns the one that opened.
#[cfg(mobile)]
#[tauri::command]
pub fn open_in_app(app: tauri::AppHandle, urls: Vec<String>) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let mut last = "No link to open.".to_string();
    for url in urls.into_iter().filter(|u| openable(u)) {
        match app.opener().open_url(url.clone(), None::<&str>) {
            Ok(()) => return Ok(url),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![discover_lan_servers, open_in_app])
        .run(tauri::generate_context!())
        .expect("error while running the Omnia TV client");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_are_parsed_strictly() {
        let ok = parse_reply(br#"{"omnia":1,"name":"DESKTOP","port":8765}"#, "192.168.1.5".into()).unwrap();
        assert_eq!(ok, FoundServer { host: "192.168.1.5".into(), port: 8765, name: "DESKTOP".into() });
        assert!(parse_reply(b"hello", "x".into()).is_none());
        assert!(parse_reply(br#"{"omnia":2,"port":8765}"#, "x".into()).is_none());
    }

    #[test]
    fn only_ott_schemes_are_opened() {
        assert!(openable("nflx://www.netflix.com/watch/80057281"));
        assert!(openable("https://www.primevideo.com/detail/0ABC"));
        assert!(!openable("intent://x#Intent;end"));
        assert!(!openable("javascript:alert(1)"));
        assert!(!openable("file:///sdcard/x"));
        assert!(!openable("http://192.168.1.5"));
    }
}
