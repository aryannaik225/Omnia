-- Omnia Web (optional cloud edition) — Supabase / Postgres schema.
--
-- Mirrors the desktop app's local SQLite schema (src-tauri/src/db/schema.sql + migrations),
-- re-keyed for a hosted multi-user database:
--   * every row belongs to an auth user (auth.users) and, below that, to one of the user's
--     Omnia profiles ("Who's watching?"), exactly like app_profile_id on the desktop;
--   * Row Level Security on every table: a signed-in user can only ever read or write rows
--     whose user_id is their own auth.uid(). The anon key alone can read nothing.
--
-- Run it once in the Supabase SQL editor (or `supabase db push`).

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------------------------------------
-- Profiles ("Who's watching?")
-- -------------------------------------------------------------------------------------------
create table if not exists public.app_profiles (
  profile_id    bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  profile_name  text not null check (char_length(profile_name) between 1 and 32),
  avatar_asset  text,
  is_kids_profile boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists app_profiles_user on public.app_profiles (user_id);

-- Per-user settings (region, subscriptions-only toggle, …).
create table if not exists public.user_settings (
  user_id    uuid not null references auth.users (id) on delete cascade,
  key        text not null,
  value      text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Services the user pays for, per region.
create table if not exists public.subscribed_providers (
  user_id       uuid not null references auth.users (id) on delete cascade,
  provider_id   integer not null,
  provider_name text not null,
  logo_path     text,
  region_code   text not null check (region_code ~ '^[A-Z]{2}$'),
  is_active     boolean not null default true,
  primary key (user_id, provider_id, region_code)
);

-- -------------------------------------------------------------------------------------------
-- Catalog cache (public TMDB metadata; shared, readable by any signed-in user)
-- -------------------------------------------------------------------------------------------
create table if not exists public.media_catalog (
  tmdb_id       integer not null,
  media_type    text not null check (media_type in ('movie', 'tv')),
  title         text not null,
  overview      text,
  poster_path   text,
  backdrop_path text,
  release_year  integer,
  runtime_mins  integer,
  genres_json   jsonb,
  vote_average  real,
  updated_at    timestamptz not null default now(),
  primary key (tmdb_id, media_type)
);

-- -------------------------------------------------------------------------------------------
-- Watch history, watchlist, favourites, collections (per profile)
-- -------------------------------------------------------------------------------------------
create table if not exists public.watch_history (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references auth.users (id) on delete cascade,
  profile_id       bigint not null references public.app_profiles (profile_id) on delete cascade,
  tmdb_id          integer not null,
  media_type       text not null check (media_type in ('movie', 'tv')),
  season_number    integer not null default 0,
  episode_number   integer not null default 0,
  episode_title    text,
  provider_name    text,
  direct_url       text,
  progress_seconds double precision not null default 0,
  duration_seconds double precision not null default 1,
  completion_ratio double precision generated always as (least(1.0, progress_seconds / greatest(1.0, duration_seconds))) stored,
  is_completed     boolean not null default false,
  watch_count      integer not null default 1,
  is_imported      boolean not null default false,
  last_watched_at  timestamptz not null default now(),
  unique (profile_id, tmdb_id, media_type, season_number, episode_number)
);
create index if not exists watch_history_recent on public.watch_history (profile_id, last_watched_at desc);

create table if not exists public.watchlist (
  user_id    uuid not null references auth.users (id) on delete cascade,
  profile_id bigint not null references public.app_profiles (profile_id) on delete cascade,
  tmdb_id    integer not null,
  media_type text not null check (media_type in ('movie', 'tv')),
  added_at   timestamptz not null default now(),
  primary key (profile_id, tmdb_id, media_type)
);
create index if not exists watchlist_recent on public.watchlist (profile_id, added_at desc);

create table if not exists public.favorites (
  user_id    uuid not null references auth.users (id) on delete cascade,
  profile_id bigint not null references public.app_profiles (profile_id) on delete cascade,
  tmdb_id    integer not null,
  media_type text not null check (media_type in ('movie', 'tv')),
  added_at   timestamptz not null default now(),
  primary key (profile_id, tmdb_id, media_type)
);

create table if not exists public.collections (
  collection_id bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  profile_id    bigint not null references public.app_profiles (profile_id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists collections_name on public.collections (profile_id, lower(name));

create table if not exists public.collection_items (
  collection_id bigint not null references public.collections (collection_id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  tmdb_id       integer not null,
  media_type    text not null check (media_type in ('movie', 'tv')),
  added_at      timestamptz not null default now(),
  primary key (collection_id, tmdb_id, media_type)
);

create table if not exists public.preferred_providers (
  user_id       uuid not null references auth.users (id) on delete cascade,
  profile_id    bigint not null references public.app_profiles (profile_id) on delete cascade,
  tmdb_id       integer not null,
  media_type    text not null check (media_type in ('movie', 'tv')),
  provider_id   integer not null,
  provider_name text not null,
  updated_at    timestamptz not null default now(),
  primary key (profile_id, tmdb_id, media_type)
);

-- A profile row must belong to the same user as the row pointing at it.
create or replace function public.profile_owned_by(p bigint, u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_profiles where profile_id = p and user_id = u);
$$;

-- -------------------------------------------------------------------------------------------
-- Row Level Security
-- -------------------------------------------------------------------------------------------
alter table public.app_profiles         enable row level security;
alter table public.user_settings        enable row level security;
alter table public.subscribed_providers enable row level security;
alter table public.media_catalog        enable row level security;
alter table public.watch_history        enable row level security;
alter table public.watchlist            enable row level security;
alter table public.favorites            enable row level security;
alter table public.collections          enable row level security;
alter table public.collection_items     enable row level security;
alter table public.preferred_providers  enable row level security;

-- Own rows only (tables without a profile column).
do $$
declare t text;
begin
  foreach t in array array['app_profiles', 'user_settings', 'subscribed_providers', 'collection_items'] loop
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated
                    using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- Own rows, and the profile must be one of the user's own.
do $$
declare t text;
begin
  foreach t in array array['watch_history', 'watchlist', 'favorites', 'collections', 'preferred_providers'] loop
    execute format('drop policy if exists own_profile_rows on public.%I', t);
    execute format('create policy own_profile_rows on public.%I for all to authenticated
                    using (user_id = auth.uid())
                    with check (user_id = auth.uid() and public.profile_owned_by(profile_id, auth.uid()))', t);
  end loop;
end $$;

-- The catalog cache is public TMDB metadata: readable by any signed-in user. Writes go through
-- the server with the service-role key (no insert / update policy), so users can't vandalise it.
drop policy if exists catalog_read on public.media_catalog;
create policy catalog_read on public.media_catalog for select to authenticated using (true);

-- New users get a first profile named after their e-mail's local part.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.app_profiles (user_id, profile_name)
  values (new.id, left(coalesce(nullif(split_part(new.email, '@', 1), ''), 'Me'), 32));
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Continue Watching: the latest unfinished (or newest-episode) row per title, newest first.
create or replace view public.continue_watching with (security_invoker = true) as
select distinct on (h.profile_id, h.tmdb_id, h.media_type)
       h.*, c.title, c.poster_path, c.backdrop_path
from public.watch_history h
left join public.media_catalog c on c.tmdb_id = h.tmdb_id and c.media_type = h.media_type
where not h.is_imported and (not h.is_completed or h.media_type = 'tv')
order by h.profile_id, h.tmdb_id, h.media_type, h.last_watched_at desc;
