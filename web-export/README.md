# Omnia Web — the website and the "back-pocket" cloud edition (Next.js + Supabase)

One Next.js project, one Vercel deployment:

- **`/`** is the Omnia landing page: a WebGL theater hero (React Three Fiber), interactive
  previews of the desktop UI, and a download section that reads the latest GitHub release.
- **`/app`** is the desktop app's UI in the browser (ported in `omnia/`) as a TV Time / Letterboxd-style
  **manual tracker**: browse, search, see where a title
  streams, mark movies watched, tick off episodes, keep a watchlist and follow upcoming air dates.
  No account needed: guests track in their browser (`localStorage`). Signing in (Supabase) is
  optional and syncs the library; a guest library is uploaded on first sign-in. It is not part of
  the desktop app's build, and nothing in the desktop app uses it.

> **This is a different privacy model.** The desktop app is local-first: history, profiles and
> taste data never leave your PC (see the repo's `CLAUDE.md`). This edition stores them in *your*
> Supabase project in the cloud. Row Level Security limits every row to the signed-in user, but
> the data does live on a server. Only deploy it if you want that.

## What's included

| Path | What it does |
| --- | --- |
| `app/page.tsx`, `components/landing/*` | The landing page. Static, regenerated hourly (ISR). `hero/TheaterScene.tsx` is the WebGL scene (lazy-loaded, paused off-screen, with a CSS fallback). |
| `lib/release.ts` | Latest release from the GitHub API, fetched on the server with `revalidate: 3600`. Falls back to v1.1.0 and the Releases page while the repo is private (404) or GitHub is unreachable. |
| `lib/landing.ts` | Poster art for the landing page: TMDB trending (when `TMDB_API_KEY` is set) through Next's image optimizer, or generated art otherwise. |
| `supabase/schema.sql` | Omnia's schema in Postgres: profiles, settings, subscriptions, watch history (with the generated `completion_ratio`), watchlist, favourites, collections, preferred providers, a shared TMDB catalog cache and a `continue_watching` view. RLS on every table, plus a trigger that gives new users a first profile. |
| `middleware.ts`, `lib/supabase/*`, `lib/session.ts` | Supabase SSR auth for `/app/*`: refreshes a signed-in session cookie. No login wall; without Supabase env vars the app runs in guest mode only. |
| `app/app/login`, `app/app/auth/*` | Optional e-mail + password sign-in / sign-up (server actions), the e-mail confirmation callback and sign-out. |
| `omnia/` | **The desktop app's frontend, ported.** Same folder layout as the repo's `src/` (`components/`, `config/`, `lib/`, `services/`, `store/`) so files can be diffed and kept in sync: Liquid Glass sidebar / tab bar, filter bar with the region switcher, ambient bleed, hero with trailer previews, 3D specular cards, Top 10, hubs, the Home row registry, "View More" grids, the detail sheet (season chips, collapsible episode lists, cast → filmography), Oscar badges, toasts, tap-the-tab-again-to-top. Web-only pieces: `store/useAppStore.ts` (localStorage instead of SQLite, Next routes instead of views), `services/tauriBridge.ts` (types only), `lib/region.ts`, `lib/personal.ts`, `components/common/LibraryActions.tsx` / `DesktopOnly.tsx`, `components/layout/WebShell.tsx`, `components/views/SettingsView.tsx`. |
| `app/globals.css`, `tailwind.config.ts` | The desktop's `src/styles/liquid-glass.css` and Tailwind tokens, verbatim; only window-level rules are scoped to the `.omnia-app` shell so the landing page is unaffected. |
| `app/app/(main)/*` | Home, Search, **My Library** (`library`: a Watch Summary bar — total watch time from each title's TMDB runtime, recorded when it's marked — then Watchlist, Upcoming, Ongoing Series, Completed Series and Tracked Movies rows, 20 per row, newest first; `library/[section]` is each row's full grid), My OTTs, Franchises & Hubs (`hubs/[slug]`), Settings, `browse` (View More). The detail sheet's Where to watch shows upcoming release dates (TMDB regional `release_dates`, theatrical vs digital) and "In Theatres Now" when a title has no providers yet (`omnia/lib/releaseStatus.ts`). A title opens as the detail sheet and is mirrored in `?t=movie:603` (old `title/[type]/[id]` links redirect there). |
| `app/app/api/tmdb/[...path]` | Read-only TMDB proxy: the ported TMDB client runs in the browser unchanged, but the key stays on the server. Public catalog GET endpoints only; responses are cached (data cache + CDN `s-maxage`). |
| `app/app/api/region` | The visitor's country: Vercel's `x-vercel-ip-country` header (or `cf-ipcountry`); off Vercel (e.g. localhost) an IP-country lookup of the server's own connection. The browser falls back to its time zone, then language, then `US`, stores the result in `localStorage`, re-checks auto regions once per visit, and never overrides a manual choice. |
| `components/tracker/*`, `lib/tracker*.ts` | One tracker API over two backends: `localStorage` for guests, the user's own Supabase rows when signed in (watched movies are `watch_history` rows at S0 E0, episodes at their S/E, as on the desktop). Each watched movie / episode also keeps its TMDB runtime (`runtimes`; `watch_history.duration_seconds` when signed in). Optimistic writes with rollback. Imports this app's export or the desktop's "Export history" JSON. |
| `app/app/api/titles`, `lib/tmdb.ts`, `lib/media.ts` | Title summaries (artwork, air dates, season sizes) for Continue Watching / Upcoming / Watchlist; client-safe date and provider-link helpers. |

Desktop-only features (OTT account linking and history auto-import, automatic playback tracking
in the native player, on-device recommendations, phone / TV pairing) are not in the web app; it
shows a small "Available on Omnia Desktop" badge linking to the landing page's download section.

## Set up

1. Create a Supabase project. In the **SQL editor**, run `supabase/schema.sql`.
2. In **Authentication → URL Configuration**, set the Site URL to your deployment
   (`http://localhost:3000` while developing) and add `/app/auth/callback` as a redirect URL.
3. Copy `.env.example` to `.env.local` and fill it in:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Settings → API),
   `TMDB_API_KEY`, `NEXT_PUBLIC_SITE_URL`, optionally `GITHUB_TOKEN`. The catalog region is detected per visitor.
   The landing page's download buttons go through `/download/exe` and `/download/msi`, which redirect to the
   latest release asset. With `GITHUB_TOKEN` (read access to the repo) this works even while the repository is
   private, so anyone visiting the site can download the installers; without it they fall back to the Releases page.
   The landing page at `/` builds and runs with none of these set.
4. Run it:

   ```bash
   cd web-export
   npm install
   npm run dev        # http://localhost:3000 (landing), /app (web edition)
   ```

## Deploy to Vercel

1. Push the repo, then in Vercel choose **Add New → Project**, import it, and set **Root
   Directory** to `web-export`.
2. Add the same environment variables (with `NEXT_PUBLIC_SITE_URL` set to the Vercel URL).
3. Deploy, then put the production URL into Supabase's Site URL / redirect URLs.

Keep the **service-role key** out of the browser. This starter never uses it. If you add
server code that writes the shared `media_catalog`, read it from a server-only environment
variable (RLS gives users read-only access to that table).
