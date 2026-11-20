# Releasing Omnia

The checklist for every desktop release. Releases are built by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) when a `vX.Y.Z` tag is pushed. It builds
the NSIS + MSI installers, signs the updater artifacts, publishes the GitHub Release with `latest.json`
(which installed copies poll for updates) and attaches `setup_instructions.txt`. The website
(`web-export/`, deployed to Vercel from `main`) reads the latest release live.

Work through the sections in order. Nothing is committed, tagged or pushed until [step 7](#7-tag-and-publish).

---

## 0. Pick the version and review what changed

```sh
git fetch --tags
git describe --tags --abbrev=0                       # last release, e.g. v1.2.0
git log --oneline "$(git describe --tags --abbrev=0)"..HEAD
git diff --stat "$(git describe --tags --abbrev=0)"..HEAD -- src src-tauri supabase web-export .github
```

Semantic versioning:

| Change | Bump |
|---|---|
| Fixes and polish only | patch (`1.2.0 → 1.2.1`) |
| New features, new migrations, new synced data (backward compatible) | minor (`1.2.0 → 1.3.0`) |
| A change that breaks existing installs, data or the sync contract | major |

Keep this commit list open: it drives the docs check (step 2) and the release notes (step 6).

---

## 1. Version bumps

Every one of these must say the new version. The workflow fails if the tag, `tauri.conf.json`,
`package.json` and `Cargo.toml` disagree, because the installers and `latest.json` take their version
from the files, not from the tag.

| File | What to change |
|---|---|
| `package.json` | `"version"` |
| `package-lock.json` | the top-level `"version"` **and** `packages[""].version` (lines 3 and 9) |
| `src-tauri/tauri.conf.json` | `"version"` |
| `src-tauri/Cargo.toml` | `[package] version` |
| `src-tauri/Cargo.lock` | the `name = "omnia"` entry's `version` (refreshed by `cargo check`) |
| `web-export/lib/release.ts` | `FALLBACK`: `version`, `tag`, `name`, `notes` (short "What's new in X.Y.Z" summary), `publishedAt: null` |

`FALLBACK` is what the landing page shows when the GitHub API is unreachable (rate limit, outage, private
repo). `web-export/package.json` has its own version (`0.1.0`) that is **not** tied to app releases; leave it.

Verify:

```sh
grep -n '"version"' package.json src-tauri/tauri.conf.json
sed -n '3p;9p' package-lock.json
grep -n '^version' src-tauri/Cargo.toml
grep -n -A1 '^name = "omnia"' src-tauri/Cargo.lock
grep -n 'version: "\|tag: "' web-export/lib/release.ts
```

---

## 2. Docs and copy parity

For each feature, filter, setting or piece of stored data that the commit list added, changed or removed,
check that every place describing it is still true. Never advertise something the code doesn't do.

| File | Check |
|---|---|
| `README.md` | Highlights, Architecture, Privacy model (outbound hosts, what syncs), env tables, Project structure, Known limitations, Troubleshooting |
| `web-export/README.md` | Route table, Supabase schema summary, set-up steps, env vars |
| `setup_instructions.txt` | Shipped with **every** release: installer name pattern, first-launch steps, settings names, privacy summary |
| `docs/CLOUD_SYNC.md` | "Synced / Never leaves the PC" table, setup steps, redirect URLs |
| `docs/PHONE_AND_TV.md` | LAN allow-list, pairing and TV build, if `lan/` or `tv_client.rs` changed |
| Landing page (`web-export/components/landing/*`) | Features grid and `SPEC` cards, `DesktopVsBrowser` rows, the `Privacy` blueprint and its host list, `Handoff`, the hero copy |
| `web-export/app/privacy/page.tsx` | Every outbound host, every stored or synced field, retention and deletion. Update `UPDATED` |
| `web-export/app/terms/page.tsx` | Accounts, sync and acceptable use, if those changed. Update `UPDATED` |
| `CLAUDE.md` | The spec sections and directory tree, for new modules, migrations or settings |

Handy greps for claims that tend to go stale:

```sh
grep -rniE "no account|no cloud|there isn't one|never leaves|1\.[0-9]+\.[0-9]+" README.md setup_instructions.txt web-export/README.md web-export/components/landing web-export/app/privacy web-export/app/terms
```

Shared UI must also be in step: `src/` and `web-export/omnia/` (same layout), with `lib/releaseStatus.ts`
and `config/homeLayout.ts` kept identical:

```sh
diff src/lib/releaseStatus.ts web-export/omnia/lib/releaseStatus.ts
diff src/config/homeLayout.ts web-export/omnia/config/homeLayout.ts
```

---

## 3. Database and migrations

```sh
git diff --stat "$(git describe --tags --abbrev=0)"..HEAD -- src-tauri/src/db supabase/schema.sql
```

- **New SQLite migration** (`src-tauri/src/db/migrations/NNN_*.sql`): it must be registered in
  `src-tauri/src/db/mod.rs`. Never edit a migration that has already shipped. Mention it in the release
  notes ("runs automatically on first launch") and update the migration range in `README.md` and `CLAUDE.md`.
- **`supabase/schema.sql` changed:** it must stay idempotent (safe to re-run). **Re-run it in the
  production Supabase project (Dashboard → SQL Editor → paste → Run) *before* publishing**, because
  released desktop builds and the live web app expect the new schema. Then check for errors.
- **Synced data changed:** also update `src-tauri/src/sync/cloud.rs`, `docs/CLOUD_SYNC.md` and the
  privacy page (step 2).

---

## 4. Pre-release build checks

All of these must pass on the release commit:

```sh
# Rust backend
cd src-tauri
cargo check
cargo test
cd ..

# Desktop frontend: type-check + production build
npm run build

# Android TV thin client: type-check + production build
npm run build:tv

# Website + web app: type-check + production build
cd web-export
npm run typecheck
npm run build
cd ..
```

Optional, slower: `npm run tauri build` does a full local installer build. CI does this anyway; run it
locally only if `tauri.conf.json`, bundling or icons changed.

---

## 5. Workflow, secrets and environment

**`.github/workflows/release.yml`**: if it changed since the last release, re-read it. It must still:
- run on `push: tags: v*` with `permissions: contents: write`,
- fail when `TMDB_API_KEY` or `TAURI_PRIVATE_KEY` is missing,
- run the *Check the tag matches the app version* step,
- pass the signing key to `tauri-apps/tauri-action` with `includeUpdaterJson: true`,
- attach `setup_instructions.txt`.

**GitHub repository secrets** (Settings → Secrets and variables → Actions):

```sh
gh secret list
```

| Secret | Required | Used for |
|---|---|---|
| `TMDB_API_KEY` | yes | Compiled into the Rust binary |
| `TAURI_PRIVATE_KEY` | yes | Signs the updater artifacts (`.sig`, `latest.json`) |
| `TAURI_KEY_PASSWORD` | if the key has one | Unlocks the signing key |
| `SUPABASE_URL` | for sync | Compiled in. Empty = release ships with sync disabled (the workflow warns) |
| `SUPABASE_ANON_KEY` | for sync | Compiled in. **Anon / publishable key only.** `build.rs` rejects secret keys |

Any new variable that `build.rs` reads must be added to the workflow's `env` **and** to the secrets list.

**Vercel** (Project → Settings → Environment Variables, Production). If the release adds a variable to
`web-export/.env.example`, add it here before the deploy:

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public; anon key only |
| `NEXT_PUBLIC_SITE_URL` | `https://omnia-tv.vercel.app` (auth redirects, metadata) |
| `TMDB_API_KEY` | Server only |
| `GITHUB_TOKEN` | Optional, server only (release lookup rate limit; signed downloads while private) |

If auth or redirect URLs changed, update Supabase → Authentication → URL Configuration as well.

---

## 6. Release notes

Draft them from the commit list (step 0) before tagging:

```markdown
## What's new in X.Y.Z
- **Feature.** One or two sentences, user-facing.

## Omnia on the web
- …

## Under the hood
- Migrations, security, polish.

## Install
- `Omnia_X.Y.Z_x64-setup.exe`: recommended installer (per-user, no admin needed)
- `Omnia_X.Y.Z_x64_en-US.msi`: MSI installer
- `setup_instructions.txt`: step-by-step setup guide

Already on an older version? Omnia will offer **Restart to Install** automatically.
```

Use absolute links (`https://omnia-tv.vercel.app/...`): relative links break on GitHub, and the landing
page's notes renderer only links `https://` URLs.

---

## 7. Tag and publish

Only after steps 1–6 are done, and only with the maintainer's go-ahead:

```sh
git status                                   # only intended changes; no .env, *.db or exports
git add -A
git commit -m "vX.Y.Z: <summary>"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

Then:

1. **Wait for `release.yml` to finish:**
   ```sh
   gh run list --workflow=release.yml --limit 1
   gh run watch <run-id>
   ```
   If it fails, fix the cause on `main`. Then delete the tag and the (possibly half-made) release, and re-tag:
   ```sh
   gh release delete vX.Y.Z --yes          # if one was created
   git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z
   ```
2. **Check the release assets:** `latest.json`, both installers and their `.sig` files, and `setup_instructions.txt`:
   ```sh
   gh release view vX.Y.Z --json assets --jq '[.assets[].name]'
   ```
3. **Edit the release body** (GitHub → Releases → vX.Y.Z → Edit) and replace the installer list with the drafted notes.
4. **Verify the live site** (https://omnia-tv.vercel.app). The Vercel deploy from `main` must have
   succeeded, and the release info refreshes within an hour (ISR):
   - the Download section shows `vX.Y.Z` and the new notes,
   - `/download/exe` and `/download/msi` download the new installers,
   - `/app`, `/privacy` and `/terms` load, and sign-in still works if auth or schema changed.
5. **Check the auto-update:** `latest.json` reports the new version
   (`https://github.com/aryannaik225/Omnia/releases/latest/download/latest.json`), and an installed
   older copy offers **Restart to Install**.
