//! SQLite connection management and schema migrations.
//!
//! The database file lives in the OS app-data directory (e.g. `%APPDATA%\app.omnia.hub\omnia.db`)
//! and is never synced anywhere. All access goes through a single `tokio_rusqlite` connection,
//! which runs SQLite on a dedicated background thread so the async Tauri runtime never blocks.

pub mod queries;

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use crate::{AppError, AppResult};

/// Ordered list of schema migrations. `PRAGMA user_version` records the last applied version,
/// so each migration runs exactly once per database file.
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("schema.sql")),
    (2, include_str!("migrations/002_preferred_providers.sql")),
    (3, include_str!("migrations/003_continue_watching_hidden.sql")),
    (4, include_str!("migrations/004_imported_history.sql")),
    (5, include_str!("migrations/005_favorites_collections_manual.sql")),
    (6, include_str!("migrations/006_ott_sync_state.sql")),
    (7, include_str!("migrations/007_lan_devices.sql")),
];

/// Cheap-to-clone handle to the local database (internally an mpsc sender to the SQLite thread).
#[derive(Clone)]
pub struct Database {
    conn: tokio_rusqlite::Connection,
}

impl Database {
    /// Opens (or creates) the database at `path`, applies pragmas, runs migrations and seeds defaults.
    pub async fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = tokio_rusqlite::Connection::open(path).await?;
        Self::initialize(conn).await
    }

    /// In-memory database, used by tests.
    pub async fn open_in_memory() -> AppResult<Self> {
        let conn = tokio_rusqlite::Connection::open_in_memory().await?;
        Self::initialize(conn).await
    }

    async fn initialize(conn: tokio_rusqlite::Connection) -> AppResult<Self> {
        conn.call(|c| {
            configure(c)?;
            migrate(c)?;
            queries::ensure_default_profile(c)?;
            queries::ensure_default_settings(c)?;
            Ok(())
        })
        .await?;
        Ok(Self { conn })
    }

    /// Runs a synchronous closure against the connection on the SQLite thread.
    pub async fn run<F, R>(&self, f: F) -> AppResult<R>
    where
        F: FnOnce(&mut Connection) -> rusqlite::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        self.conn
            .call(move |c| f(c).map_err(tokio_rusqlite::Error::from))
            .await
            .map_err(AppError::from)
    }
}

/// Connection-level pragmas: WAL for concurrent reads during 3-second telemetry writes,
/// enforced foreign keys for profile isolation cascades, and a busy timeout.
pub(crate) fn configure(c: &Connection) -> rusqlite::Result<()> {
    c.busy_timeout(Duration::from_secs(5))?;
    // journal_mode returns the resulting mode as a row, so it must be read via query_row.
    let _mode: String = c.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    c.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;",
    )?;
    Ok(())
}

/// Applies every migration newer than the file's `user_version`, each inside its own transaction.
pub(crate) fn migrate(c: &mut Connection) -> rusqlite::Result<()> {
    let current: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (version, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        let tx = c.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute_batch(&format!("PRAGMA user_version = {version}"))?;
        tx.commit()?;
        log::info!("applied database migration v{version}");
    }
    Ok(())
}
