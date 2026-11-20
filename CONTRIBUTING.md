# Contributing to Omnia

Thanks for helping out! Omnia is a Windows desktop app (Tauri 2 + Rust + React), a Next.js website and web app (`web-export/`), and an optional Supabase sync layer shared by both. Bug reports, provider fixes, new hubs and PRs are all welcome.

[CLAUDE.md](CLAUDE.md) is the detailed design spec for every module, and the [README](README.md) has the architecture overview.

## Reporting bugs

[Open an issue](https://github.com/aryannaik225/Omnia/issues/new) with:

- the Omnia version (Settings, or the installer name) and Windows version,
- the **title, region and streaming service** for anything about availability, deep links, the player or history import,
- what you expected and what happened, plus relevant lines from `%LOCALAPPDATA%\app.omnia.hub\logs\`.

Never paste cookies, tokens, `.env` contents or your `omnia.db`. For a security issue, open an issue asking for a private contact and leave out the details.

## Local setup

### Desktop (Rust / Tauri)

Prerequisites: Windows 10/11, Node.js 20+, Rust stable (MSVC), Visual Studio Build Tools ("Desktop development with C++"), and a [TMDB API key](https://www.themoviedb.org/settings/api).

```sh
npm install
cp .env.example .env     # TMDB_API_KEY=...; leave SUPABASE_* empty unless you're working on sync
npm run tauri dev
```

### Web (Next.js)

```sh
cd web-export
npm install
cp .env.example .env.local   # TMDB_API_KEY, and NEXT_PUBLIC_SUPABASE_* for sign-in (optional)
npm run dev                  # http://localhost:3000 and /app
```

Without Supabase variables, `/app` runs in guest mode, and the landing page needs no variables at all.

### Supabase (only for sync / sign-in work)

Use your **own** Supabase project. Run [`supabase/schema.sql`](supabase/schema.sql) in its SQL editor (it's idempotent) and follow [docs/CLOUD_SYNC.md](docs/CLOUD_SYNC.md) for auth providers and redirect URLs.

## Checks before you open a PR

Run whichever apply to what you touched. CI only builds releases, so these are on you:

```sh
# Desktop frontend: type-check + production build
npm run build

# Rust backend
cd src-tauri
cargo check
cargo test

# Website / web app: type-check + production build
cd web-export
npm run typecheck
npm run build
```

If you changed the Android TV thin client, also run `npm run build:tv`.

## Pull request guidelines

- **Small and focused.** One fix or feature per PR, with a short description of what changed and how you tested it (screenshots for UI changes).
- **Keep the two frontends in sync.** `web-export/omnia/` mirrors `src/`. Port shared UI changes to both, and keep `lib/releaseStatus.ts` and `config/homeLayout.ts` identical in both.
- **Home rows:** append new ids to `HOME_SLOTS` in `config/homeLayout.ts`, and never rename or reuse one (saved and synced layouts reference them).
- **Database changes** go in a new numbered migration in `src-tauri/src/db/migrations/`. Never edit a shipped migration.
- **Synced data:** changes to what syncs also need `supabase/schema.sql` (idempotent), `src-tauri/src/sync/cloud.rs`, `docs/CLOUD_SYNC.md` and the privacy page (`web-export/app/privacy`).
- **New backend commands** must be added to `build.rs` `COMMANDS` and granted in `permissions/omnia.toml` (deny-by-default). Expose them to the LAN only through the allow-list in `lan/mobile_server.rs`, and only if they're safe for a paired phone.
- **Respect the privacy model.** The desktop app must not send viewing history, telemetry, embeddings or cookies anywhere, and adds no analytics or crash reporting. New outbound hosts need a good reason and a line in the privacy docs.
- **No placeholder code.** Ship working logic with graceful fallbacks rather than stubs.

## Keeping secrets out of client bundles

- **TMDB:** the key lives in the repo-root `.env` (compiled into the Rust binary by `build.rs`) and in `web-export/.env.local` as a **server-only** variable. The desktop UI reaches TMDB through the Rust `tmdb_get` command and the web app through `/app/api/tmdb`, so don't call TMDB with a key from React code.
- **Vite** only exposes `VITE_OMNIA_*` variables, and **Next.js** only `NEXT_PUBLIC_*` ones. Never give a secret either prefix.
- **Supabase:** only the project URL and the **anon / publishable** key are ever used, and Row Level Security protects every table. Never add the service-role / `sb_secret_…` key anywhere. `build.rs` and `web-export/next.config.mjs` fail the build if you do.
- `.env`, `.env.*` and `*.db` are git-ignored. Check `git status` before committing, and never commit real keys, cookies, databases or exported watch history.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
