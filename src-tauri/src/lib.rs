//! Omnia native backend.
//!
//! * Desktop (Windows / macOS / Linux): the full local-first hub in [`desktop`] — SQLite, the
//!   OTT player and importer windows, the recommender and the LAN companion server.
//! * Android (Google TV / Fire TV): a thin client ([`tv_client`]) with no database of its own.
//!   It finds the desktop on the local network, pairs with it, reads everything through the
//!   desktop's LAN server and hands playback to the installed OTT apps via Android intents.

#[cfg(desktop)]
pub mod db;

#[cfg(desktop)]
pub mod resolver {
    pub mod justwatch;
}

#[cfg(desktop)]
pub mod player {
    pub mod window_manager;
}

#[cfg(desktop)]
pub mod sync {
    pub mod airing;
    pub mod cloud;
    pub mod background;
    pub mod history_importer;
}

#[cfg(desktop)]
pub mod ml {
    pub mod embeddings;
    pub mod recommender;
}

#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
pub use desktop::{run, AppError, AppResult, AppState};

// Compiled into desktop test builds too, so its discovery and URL rules are tested.
#[cfg(any(mobile, test))]
#[cfg_attr(test, allow(dead_code))]
mod tv_client;
#[cfg(mobile)]
pub use tv_client::run;
