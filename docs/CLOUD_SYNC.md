# Optional cloud sync (Desktop ⇄ Web)

Omnia Desktop is local-first and works with no account. **Sign in to Sync** (Settings) is opt-in:
until someone signs in, the desktop sends nothing to Supabase. Signed in, one local profile syncs
two-way with Omnia Web (`/app`), so what you track on your phone shows up on the PC and the other way round.

| Synced | Never leaves the PC |
| --- | --- |
| Watchlist entries | OTT logins, cookies, WebView2 sessions |
| Watched movies / episodes (ids, watched-at, runtime), including what the OTT player and history importer recorded | Playback telemetry & events, progress ticks |
| Profile name and picture (256×256 WebP in Storage; only its URL in `profiles.avatar_url`) | Taste vectors / embeddings, the TMDB metadata cache, deep links, other profiles |
| Home Page Layout (row order, `profiles.home_row_order`) | Other settings (region, subscriptions, LAN, `cloud_*`, `tmdb_api_key`) |

## How it syncs

- **Desktop:** SQLite triggers (migration v9) note *which* item changed and *when* in `cloud_outbox`.
  `src-tauri/src/sync/cloud.rs` pushes each item's current state (present → upsert, gone → tombstone),
  then pulls rows the server stamped since its last pull. It runs ~20 s after a change, every 2 min,
  when the window regains focus and on **Sync now**. The access token lives only in memory; the refresh
  token is stored in local settings and is never returned to the UI or to LAN devices.
- **Web:** writes straight to Supabase (tombstones instead of deletes), and listens with Supabase
  Realtime (plus a refetch when the tab returns), so desktop changes appear in **My Library** live.
  A guest library in `localStorage` is merged into the account on first sign-in.
- **Conflicts:** last write wins per item. Every row carries the device's `updated_at`; a trigger in
  `supabase/schema.sql` drops writes older than the stored row, and `synced_at` (server time) drives
  pulls so device clock skew can't hide a change.

## Set up (once)

1. **Supabase project** → SQL Editor → paste and run [`supabase/schema.sql`](../supabase/schema.sql)
   (idempotent: safe to re-run). It creates `profiles`, `watchlist`, `tracked_movies`, `tracked_episodes`,
   RLS (`auth.uid() = user_id` for select / insert / update / delete), the public `avatars` bucket with
   per-user folder policies, Realtime publication, the `keep_alive()` ping function and `delete_my_account()`
   (web Settings → Account → Delete account; cascades every synced row).
   For Google's OAuth consent screen use `https://<your-site>/privacy` and `https://<your-site>/terms`.
2. **Authentication → Providers:** Email is on by default. For Google, enable it and paste a Google
   OAuth client id / secret (Google Cloud Console; authorised redirect URI
   `https://<project-ref>.supabase.co/auth/v1/callback`).
3. **Authentication → URL Configuration → Redirect URLs**, add:
   - `https://<your-site>/app/auth/callback` (and `http://localhost:3000/app/auth/callback` for dev)
   - `http://127.0.0.1:54365/auth/callback` (Omnia Desktop's Google sign-in, a one-shot loopback listener)
4. **Keys** (Project Settings → API): copy the project URL and the **anon / publishable** key.
   - Desktop: repo-root `.env` → `SUPABASE_URL`, `SUPABASE_ANON_KEY` (compiled in by `build.rs`).
   - Web: `web-export/.env.local` (and Vercel) → `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   - GitHub → Settings → Secrets → Actions: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (release builds and the
     keep-alive workflow).
5. Rebuild the desktop app (`npm run tauri build` / `tauri dev`) and redeploy the web app.

**Never use the service-role / secret key anywhere in Omnia.** Both builds refuse it: `build.rs` and
`web-export/next.config.mjs` fail on an `sb_secret_…` key or a JWT whose role isn't `anon`, and
the Next build also fails if any `NEXT_PUBLIC_*` name looks like a secret (`TMDB`, `SECRET`, `SERVICE_ROLE`).

## Keep-alive

Free-tier projects pause after a week idle. `.github/workflows/supabase-keep-alive.yml` calls
`POST /rest/v1/rpc/keep_alive` with the anon key every 3 days (`0 0 */3 * *`) and on demand
(Actions → Supabase keep-alive → Run workflow). It reads no user data.

## Secret handling (both apps)

- **TMDB:** the web app calls TMDB only from Route Handlers (`/app/api/tmdb`, `/app/api/titles`) with the
  server-only `TMDB_API_KEY`. The desktop UI calls the Rust `tmdb_get` command, which adds the key, so the
  key is in neither JS bundle, the webview, nor anything a browser's Network tab shows; phones / TVs paired
  over the LAN reach TMDB through the PC the same way. (The desktop binary itself still carries the bundled
  key, as before, so it works without a `.env`.)
- **Supabase:** only the URL and anon key are public; Row Level Security is on every table and on the avatars bucket.
