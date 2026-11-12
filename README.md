# Omnia

Universal OTT aggregator, discovery engine and smart playback hub — Tauri 2 (Rust) + React 19.
See `CLAUDE.md` for the full architecture and privacy constraints.

## Prerequisites

- Node.js 20+
- Rust (stable, 1.77+) via [rustup](https://rustup.rs) with the MSVC toolchain on Windows
- Microsoft Edge WebView2 Runtime (preinstalled on Windows 11)

## Development

```sh
npm install
cp .env.example .env        # add your TMDB key
npm run tauri dev           # launches the desktop app
cargo test --manifest-path src-tauri/Cargo.toml   # backend unit tests (DB + resolver)
```

All user data (profiles, watch history, embeddings, cookies) lives in a local SQLite file in the
OS app-data directory and never leaves the machine.
