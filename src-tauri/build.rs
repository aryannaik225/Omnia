//! Generates the Tauri context plus per-command ACL permissions (`allow-<command>`).
//!
//! Declaring the app manifest makes *every* custom command deny-by-default: each window can only
//! call what its capability grants (see `capabilities/` and `permissions/omnia.toml`). This is what
//! confines third-party OTT pages in player windows to the telemetry commands.

const COMMANDS: &[&str] = &[
    // Catalog window
    "list_profiles",
    "create_profile",
    "update_profile",
    "delete_profile",
    "get_setting",
    "set_setting",
    "get_all_settings",
    "delete_setting",
    "list_ott_profile_mappings",
    "upsert_ott_profile_mapping",
    "delete_ott_profile_mapping",
    "list_subscribed_providers",
    "set_subscribed_providers",
    "set_provider_active",
    "cache_media_metadata",
    "get_cached_media",
    "resolve_deep_links",
    "get_cached_deep_links",
    "record_watch_progress",
    "mark_title_completed",
    "get_continue_watching",
    "get_watch_history",
    "get_title_progress",
    "delete_watch_history_entry",
    "clear_watch_history",
    "get_history_titles",
    "delete_title_history",
    "get_history_provider_counts",
    "clear_provider_history",
    "mark_watched",
    "unmark_watched",
    "mark_episodes_watched",
    "lan_status",
    "lan_set_enabled",
    "lan_new_pin",
    "lan_revoke_device",
    "discover_lan_servers",
    "open_in_app",
    "set_favorite",
    "is_favorite",
    "get_favorites",
    "get_collections",
    "create_collection",
    "rename_collection",
    "delete_collection",
    "add_to_collection",
    "remove_from_collection",
    "get_collection_items",
    "get_title_collections",
    "check_airing_shows",
    "fetch_avatar_image",
    "get_sync_states",
    "sync_accounts_now",
    "identify_title",
    "import_watch_history",
    "export_watch_history",
    "log_playback_event",
    "list_playback_events",
    "list_custom_hubs",
    "upsert_custom_hubs",
    "delete_custom_hub",
    "add_to_watchlist",
    "remove_from_watchlist",
    "get_watchlist",
    "is_in_watchlist",
    "get_preferred_provider",
    "set_preferred_provider",
    "clear_preferred_provider",
    "hide_from_continue_watching",
    "unhide_from_continue_watching",
    "open_player",
    "close_player",
    "get_player_status",
    "player_rebind_title",
    "import_ott_history",
    "import_history_file",
    "get_recommendations",
    "get_taste_summary",
    "get_embedding_status",
    "get_similar_titles",
    // Self-update
    "check_for_update",
    "install_update",
    // TMDB proxy (the key stays in Rust)
    "tmdb_get",
    "tmdb_status",
    // Optional cloud sync
    "cloud_status",
    "cloud_sign_in",
    "cloud_sign_up",
    "cloud_sign_in_google",
    "cloud_sign_out",
    "cloud_sync_now",
    // Injected OTT script (remote origins)
    "sync_playback_telemetry",
    "player_back_to_hub",
    "report_ott_profile",
    "submit_scraped_history",
    "report_scrape_progress",
];

/// Resolves the TMDB key at compile time so the shipped binary needs no `.env` at runtime.
/// Order: the `TMDB_API_KEY` environment variable (CI secret), then `TMDB_API_KEY=` in the
/// repo-root `.env` (local builds). Exposed to the crate as `env!("OMNIA_TMDB_API_KEY")`.
fn embed_tmdb_key() {
    println!("cargo:rerun-if-env-changed=TMDB_API_KEY");
    println!("cargo:rerun-if-changed=../.env");

    let from_env = std::env::var("TMDB_API_KEY").ok();
    let from_file = || {
        let text = std::fs::read_to_string("../.env").ok()?;
        text.lines().find_map(|line| {
            let line = line.trim();
            let value = line.strip_prefix("export ").unwrap_or(line).strip_prefix("TMDB_API_KEY=")?;
            Some(value.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        })
    };
    let key = from_env
        .filter(|k| !k.trim().is_empty())
        .or_else(from_file)
        .map(|k| k.trim().to_string())
        .unwrap_or_default();

    if key.is_empty() {
        println!("cargo:warning=TMDB_API_KEY not set (env or ../.env): this build has no bundled TMDB key; users must paste one in Settings.");
    }
    if key.contains(['\n', '\r']) {
        panic!("TMDB_API_KEY must be a single line");
    }
    println!("cargo:rustc-env=OMNIA_TMDB_API_KEY={key}");
}

/// `KEY=value` from the repo-root `.env` (local builds), or None.
fn dotenv_value(name: &str) -> Option<String> {
    let text = std::fs::read_to_string("../.env").ok()?;
    let prefix = format!("{name}=");
    text.lines().find_map(|line| {
        let line = line.trim();
        let value = line.strip_prefix("export ").unwrap_or(line).strip_prefix(prefix.as_str())?;
        Some(value.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
    })
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
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
    let clean: Vec<u8> = s.bytes().filter(|c| *c != b'=').collect();
    let mut out = Vec::new();
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

/// Optional cloud sync: the Supabase project URL and its *public* anon / publishable key
/// (`SUPABASE_URL`, `SUPABASE_ANON_KEY`; env var first, then `../.env`). Both are safe to ship
/// because Row Level Security limits every row to the signed-in user. A secret / service-role
/// key fails the build instead of ever being compiled into the app.
fn embed_supabase() {
    for name in ["SUPABASE_URL", "SUPABASE_ANON_KEY"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let get = |name: &str| {
        std::env::var(name)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| dotenv_value(name))
            .map(|v| v.trim().to_string())
            .unwrap_or_default()
    };
    let url = get("SUPABASE_URL");
    let key = get("SUPABASE_ANON_KEY");
    if url.contains(['\n', '\r']) || key.contains(['\n', '\r']) {
        panic!("SUPABASE_URL / SUPABASE_ANON_KEY must be single lines");
    }
    if !url.is_empty() && !url.starts_with("https://") {
        panic!("SUPABASE_URL must start with https://");
    }
    if key.starts_with("sb_secret_") {
        panic!("SUPABASE_ANON_KEY is a Supabase *secret* key. Use the anon / publishable key; secrets must never ship in the app.");
    }
    let parts: Vec<&str> = key.split('.').collect();
    if parts.len() == 3 {
        let role = b64url_decode(parts[1])
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|json| json.split("\"role\"").nth(1).map(|rest| rest.trim_start_matches([':', ' ', '"']).split('"').next().unwrap_or("").to_string()));
        if role.as_deref().is_some_and(|r| r != "anon") {
            panic!("SUPABASE_ANON_KEY has role {role:?}. Use the anon key; the service-role key must never ship in the app.");
        }
    }
    if url.is_empty() || key.is_empty() {
        println!("cargo:warning=SUPABASE_URL / SUPABASE_ANON_KEY not set: this build has cloud sync disabled (everything stays local).");
    }
    println!("cargo:rustc-env=OMNIA_SUPABASE_URL={url}");
    println!("cargo:rustc-env=OMNIA_SUPABASE_ANON_KEY={key}");
}

fn main() {
    embed_tmdb_key();
    embed_supabase();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
