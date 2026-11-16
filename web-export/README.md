# Omnia Web — the "back-pocket" cloud edition (Next.js + Supabase)

A **separate, optional** starter for hosting a web-only Omnia on Vercel with cloud sync. It is
not part of the desktop app's build, and nothing in the desktop app uses it.

> **This is a different privacy model.** The desktop app is local-first: history, profiles and
> taste data never leave your PC (see the repo's `CLAUDE.md`). This edition stores them in *your*
> Supabase project in the cloud. Row Level Security limits every row to the signed-in user, but
> the data does live on a server. Only deploy it if you want that.

## What's included

| Path | What it does |
| --- | --- |
| `supabase/schema.sql` | Omnia's schema in Postgres: profiles, settings, subscriptions, watch history (with the generated `completion_ratio`), watchlist, favourites, collections, preferred providers, a shared TMDB catalog cache and a `continue_watching` view. RLS on every table, plus a trigger that gives new users a first profile. |
| `middleware.ts`, `lib/supabase/*` | Supabase SSR auth: refreshes the session cookie on each request and sends signed-out visitors to `/login`. |
| `app/login`, `app/auth/*` | E-mail + password sign-in and sign-up (server actions), the e-mail confirmation callback and sign-out. |
| `app/page.tsx` | Home page in the desktop app's Liquid Glass style: hero, Continue Watching and Your List (from Supabase), and Trending / Popular rows (from TMDB). |
| `lib/tmdb.ts` | Server-only TMDB client. The API key never reaches the browser. |

Not included (port these from the desktop app when you need them): the detail page,
search, hubs, the JustWatch deep-link resolver, the recommender (it uses on-device ONNX),
and OTT history import. A website can't read your Netflix / Prime sessions, so history
would come from CSV / JSON import (the desktop's "Export history" JSON fits `watch_history`).

## Set up

1. Create a Supabase project. In the **SQL editor**, run `supabase/schema.sql`.
2. In **Authentication → URL Configuration**, set the Site URL to your deployment
   (`http://localhost:3000` while developing) and add `/auth/callback` as a redirect URL.
3. Copy `.env.example` to `.env.local` and fill it in:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Settings → API),
   `TMDB_API_KEY`, `NEXT_PUBLIC_SITE_URL`, optionally `DEFAULT_REGION`.
4. Run it:

   ```bash
   cd web-export
   npm install
   npm run dev        # http://localhost:3000
   ```

## Deploy to Vercel

1. Push the repo, then in Vercel choose **Add New → Project**, import it, and set **Root
   Directory** to `web-export`.
2. Add the same environment variables (with `NEXT_PUBLIC_SITE_URL` set to the Vercel URL).
3. Deploy, then put the production URL into Supabase's Site URL / redirect URLs.

Keep the **service-role key** out of the browser. This starter never uses it. If you add
server code that writes the shared `media_catalog`, read it from a server-only environment
variable (RLS gives users read-only access to that table).
