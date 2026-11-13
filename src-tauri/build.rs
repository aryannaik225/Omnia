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
    // Injected OTT script (remote origins)
    "sync_playback_telemetry",
    "player_back_to_hub",
    "report_ott_profile",
    "submit_scraped_history",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
