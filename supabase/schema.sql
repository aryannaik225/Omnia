-- =============================================================================================
-- Omnia — optional two-way cloud sync (Supabase / Postgres)
--
-- Shared by the desktop app (opt-in "Sign in to Sync" in Settings) and the web app (/app).
-- Paste the whole file into the Supabase SQL Editor and run it. It is idempotent: running it
-- again (e.g. after pulling a newer version) only adds what is missing and refreshes policies,
-- functions and triggers.
--
-- What lives here: lightweight tracking state only — watchlist entries, watched movies and
-- watched episodes (ids, timestamps, runtime) plus a display name and avatar URL.
-- What NEVER lives here: OTT sessions / cookies, playback telemetry, taste vectors, metadata
-- caches. Those stay in the desktop app's local SQLite database.
--
-- Sync model (last-write-wins):
--   * Every row carries the client's `updated_at` (when the change was made on the device).
--   * Deletions are tombstones: `deleted_at` is set instead of removing the row, so the delete
--     reaches every other device.
--   * A BEFORE UPDATE trigger ignores writes whose `updated_at` is older than the stored row,
--     so a stale device can never overwrite a newer change.
--   * `synced_at` is stamped by the server on every accepted write; devices pull
--     "everything with synced_at newer than my cursor" (immune to device clock skew).
--
-- Security: Row Level Security on every table and on the avatars bucket. A signed-in user can
-- only read or write rows where user_id = auth.uid(). The anon (publishable) key on its own can
-- read nothing. The service-role key is never needed by Omnia: do not put it in any client.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 0. Legacy cleanup
-- An earlier web-only draft created `public.watchlist` with a `profile_id` column. If it exists,
-- keep its data under a new name instead of failing on the new layout.
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'watchlist' and column_name = 'profile_id'
  ) and not exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'legacy_watchlist'
  ) then
    alter table public.watchlist rename to legacy_watchlist;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------

-- One row per account: what other devices show for "you".
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 64),
  avatar_url   text check (avatar_url is null or char_length(avatar_url) <= 512),
  updated_at   timestamptz not null default now(),
  synced_at    timestamptz not null default now()
);

create table if not exists public.watchlist (
  user_id    uuid not null references auth.users (id) on delete cascade,
  tmdb_id    integer not null check (tmdb_id > 0),
  media_type text not null check (media_type in ('movie', 'tv')),
  added_at   timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  synced_at  timestamptz not null default now(),
  primary key (user_id, tmdb_id, media_type)
);

create table if not exists public.tracked_movies (
  user_id         uuid not null references auth.users (id) on delete cascade,
  tmdb_id         integer not null check (tmdb_id > 0),
  media_type      text not null default 'movie' check (media_type = 'movie'),
  status          text not null default 'watched' check (status in ('watched')),
  runtime_minutes integer check (runtime_minutes is null or runtime_minutes between 1 and 999),
  watched_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  synced_at       timestamptz not null default now(),
  primary key (user_id, tmdb_id)
);

create table if not exists public.tracked_episodes (
  user_id         uuid not null references auth.users (id) on delete cascade,
  tmdb_id         integer not null check (tmdb_id > 0),
  media_type      text not null default 'tv' check (media_type = 'tv'),
  season_number   integer not null check (season_number >= 0),
  -- 0 = an episode the streaming service didn't number and TMDB couldn't match by name
  -- (e.g. Netflix activity for a season TMDB lists only as "Episode 1…").
  episode_number  integer not null check (episode_number >= 0),
  episode_title   text check (episode_title is null or char_length(episode_title) <= 200),
  status          text not null default 'watched' check (status in ('watched')),
  runtime_minutes integer check (runtime_minutes is null or runtime_minutes between 1 and 999),
  watched_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  synced_at       timestamptz not null default now(),
  primary key (user_id, tmdb_id, season_number, episode_number)
);

-- Upgrades for projects created from an earlier version of this file (no-ops otherwise).
alter table public.tracked_episodes add column if not exists episode_title text;
alter table public.tracked_episodes drop constraint if exists tracked_episodes_episode_title_check;
alter table public.tracked_episodes add constraint tracked_episodes_episode_title_check
  check (episode_title is null or char_length(episode_title) <= 200);
alter table public.tracked_episodes drop constraint if exists tracked_episodes_episode_number_check;
alter table public.tracked_episodes add constraint tracked_episodes_episode_number_check check (episode_number >= 0);

-- Delta pulls: "my rows changed since <cursor>".
create index if not exists watchlist_user_synced        on public.watchlist        (user_id, synced_at);
create index if not exists tracked_movies_user_synced   on public.tracked_movies   (user_id, synced_at);
create index if not exists tracked_episodes_user_synced on public.tracked_episodes (user_id, synced_at);

-- ---------------------------------------------------------------------------------------------
-- 2. Last-write-wins + server sync stamp
-- ---------------------------------------------------------------------------------------------
create or replace function public.omnia_sync_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  -- A device clock running ahead can't pin a row in the future.
  if new.updated_at is null or new.updated_at > now() + interval '2 minutes' then
    new.updated_at := now();
  end if;
  -- Stale write (another device already saved something newer): keep the stored row.
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'watchlist', 'tracked_movies', 'tracked_episodes'] loop
    execute format('drop trigger if exists omnia_sync_stamp on public.%I', t);
    execute format('create trigger omnia_sync_stamp before insert or update on public.%I
                    for each row execute function public.omnia_sync_stamp()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Row Level Security: own rows only, for every operation
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['profiles', 'watchlist', 'tracked_movies', 'tracked_episodes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('drop policy if exists own_select on public.%I', t);
    execute format('drop policy if exists own_insert on public.%I', t);
    execute format('drop policy if exists own_update on public.%I', t);
    execute format('drop policy if exists own_delete on public.%I', t);
    execute format('create policy own_select on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('create policy own_insert on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t);
    execute format('create policy own_update on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('create policy own_delete on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', t);
    -- Nothing for anon: the publishable key alone sees no rows.
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. A profile row for every new account (name from Google, else the e-mail's local part)
-- ---------------------------------------------------------------------------------------------
create or replace function public.omnia_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, display_name, avatar_url)
  values (
    new.id,
    left(coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Me'), 64),
    null
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists omnia_on_auth_user_created on auth.users;
create trigger omnia_on_auth_user_created after insert on auth.users
  for each row execute function public.omnia_handle_new_user();

-- Accounts created before this script ran.
insert into public.profiles (user_id, display_name)
select u.id, left(coalesce(nullif(split_part(coalesce(u.email, ''), '@', 1), ''), 'Me'), 64)
from auth.users u
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 5. Realtime: the web app's My Library updates live when the desktop pushes changes.
-- (Realtime honours RLS, so each user only receives their own rows.)
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['profiles', 'watchlist', 'tracked_movies', 'tracked_episodes'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Keep-alive ping (GitHub Action every 3 days, anon key): touches the database, returns no data.
-- ---------------------------------------------------------------------------------------------
create or replace function public.keep_alive() returns timestamptz
language sql stable set search_path = public as $$
  select now();
$$;
revoke all on function public.keep_alive() from public;
grant execute on function public.keep_alive() to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. Self-serve account deletion (web app: Settings → Account → Delete account).
--    Deletes the caller's auth user; every table above cascades. The app removes the avatar
--    file through the Storage API first (Storage doesn't allow deleting objects from SQL).
-- ---------------------------------------------------------------------------------------------
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  delete from auth.users where id = uid;
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 8. Avatars bucket: public read (the URL is what syncs), writes only into your own folder.
--    Object path: avatars/<auth.uid()>/avatar.webp  (256×256 WebP, compressed on the device)
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "omnia avatars: read own" on storage.objects;
drop policy if exists "omnia avatars: insert own" on storage.objects;
drop policy if exists "omnia avatars: update own" on storage.objects;
drop policy if exists "omnia avatars: delete own" on storage.objects;

-- Public bucket files are served by URL without a policy; listing / API reads are owner-only.
create policy "omnia avatars: read own" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "omnia avatars: insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "omnia avatars: update own" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "omnia avatars: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
