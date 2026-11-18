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

fn main() {
    embed_tmdb_key();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
