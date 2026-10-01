-- The catalog in Postgres (ADR 0021 slice 4a, catalog-pg-schema design D1-D3).
--
-- A faithful port of the SQLite catalog built by packages/catalog/migrations/0001-0005, in its
-- end state: timestamps stay ISO-8601 text, flags 0/1 integers, JSON text (owner, 2026-10-01; a
-- typed schema follows the migration). Every SQLite INTEGER is bigint (SQLite integers are 8
-- bytes), REAL is double precision, and text is COLLATE "C" so ordering stays bytewise.
--
-- Schema `catalog`, not `public`: the image grants every new `public` table to anon,
-- authenticated and service_role, and PostgREST serves `public` (design D2). The app connects as
-- autologger_app; its LOGIN and password come from docker/supabase/migrate.sh, never this file.

create schema catalog;
revoke all on schema catalog from public;

create table catalog.users (
  id text collate "C" primary key,
  google_sub text collate "C" not null unique,
  email text collate "C" not null,
  given_name text collate "C" not null default '',
  family_name text collate "C" not null default '',
  picture_url text collate "C" not null default '',
  created_at_utc text collate "C" not null,
  disabled_at_utc text collate "C"
);
create index idx_users_email on catalog.users (email);

create table catalog.user_studio_memberships (
  user_id text collate "C" not null references catalog.users (id) on delete cascade,
  studio_id text collate "C" not null,
  role text collate "C" not null default 'member',
  primary key (user_id, studio_id)
);

create table catalog.user_prefs (
  user_id text collate "C" primary key references catalog.users (id) on delete cascade,
  active_studio_id text collate "C" not null default '',
  active_show_id text collate "C" not null default ''
);

create table catalog.studio_definitions (
  id text collate "C" primary key,
  display_name text collate "C" not null,
  sort_order bigint not null default 0,
  created_at_utc text collate "C" not null
);

create table catalog.shows (
  id text collate "C" primary key,
  studio_id text collate "C" not null,
  name text collate "C" not null,
  show_code text collate "C" not null,
  next_episode bigint not null default 1,
  categories_json text collate "C" not null default '[]',
  event_palette_json text collate "C" not null default '[]',
  event_palette_preset text collate "C" not null default 'custom',
  event_palette_custom_json text collate "C" not null default '[]',
  created_at_utc text collate "C" not null,
  title_suffix text collate "C" not null default 'date'
);

create table catalog.app_settings (
  key text collate "C" primary key,
  value text collate "C" not null
);

create table catalog.sessions (
  id text collate "C" primary key,
  show_id text collate "C" references catalog.shows (id),
  title text collate "C" not null default '',
  archived bigint not null default 0,
  frame_rate double precision not null default 24.0,
  start_offset_frames bigint not null default 0,
  episode text collate "C" not null default '',
  notes text collate "C" not null default '',
  started_at_utc text collate "C" not null default '',
  created_at_utc text collate "C" not null default '',
  episode_date text collate "C",
  ui_hidden bigint not null default 0,
  event_count bigint not null default 0,
  max_timecode_total_frames bigint,
  is_rolling bigint not null default 0,
  current_take bigint not null default 0,
  transport_elapsed_frames bigint not null default 0,
  roll_started_at_utc text collate "C"
);
create index idx_sessions_show on catalog.sessions (show_id);

create table catalog.kv (
  key text collate "C" primary key,
  value text collate "C" not null,
  expires_at bigint
);

create table catalog.team_invites (
  studio_id text collate "C" not null,
  email_norm text collate "C" not null,
  invited_by_user_id text collate "C" not null,
  invited_at_utc text collate "C" not null,
  primary key (studio_id, email_norm)
);

-- The two seed shows, as SQLite holds them after its migration 0005 (title_suffix 'episode').
insert into catalog.shows
  (id, studio_id, name, show_code, next_episode, categories_json, event_palette_json,
   event_palette_preset, event_palette_custom_json, created_at_utc, title_suffix)
values
  ('show-autolog-test', 'test-studios', 'Autolog Test Show', 'ATS', 1,
   '[{"id":"a1000000-0000-4000-8000-000000000001","name":"Scene","color":"#4a9fd4","type":"BUTTON","dropdown_options":[],"on_label":"","off_label":""},{"id":"a1000000-0000-4000-8000-000000000002","name":"Audio issue","color":"#a86bdc","type":"DROPDOWN","dropdown_options":[{"label":"Lav","needs_context":false},{"label":"Boom","needs_context":false}],"on_label":"","off_label":""},{"id":"a1000000-0000-4000-8000-000000000003","name":"Note","color":"#6bcf7a","type":"TEXT","dropdown_options":[],"on_label":"","off_label":""}]',
   '["#4a9fd4","#a86bdc","#6bcf7a","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
   'custom',
   '["#4a9fd4","#a86bdc","#6bcf7a","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
   '2024-01-01T00:00:00Z', 'episode'),
  ('show-the-something-podcast', 'test-studio-2', 'The Something Podcast', 'TSP', 1,
   '[{"id":"b2000000-0000-4000-8000-000000000001","name":"Note","color":"#7cb7ff","type":"TEXT","dropdown_options":[],"on_label":"","off_label":""},{"id":"b2000000-0000-4000-8000-000000000002","name":"Mark","color":"#f4a82e","type":"BUTTON","dropdown_options":[],"on_label":"","off_label":""}]',
   '["#7cb7ff","#f4a82e","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
   'custom',
   '["#7cb7ff","#f4a82e","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
   '2024-01-01T00:00:00Z', 'episode')
on conflict (id) do nothing;

-- The app role (design D3). Roles are cluster-wide, so it may already exist (the test setup
-- migrates two databases in one cluster); its attributes are reset either way, and a membership
-- in any role fails the migration. `begin`/`end` stay indented: migrate.sh refuses a line that
-- starts with transaction control.
-- role:begin
do $$
  begin
    if not exists (select from pg_roles where rolname = 'autologger_app') then
      create role autologger_app nologin;
    end if;
  end
$$;
-- `postgres` is not a superuser and has no REPLICATION, so it can reset only these three
-- attributes; the check below refuses a role that holds the other two.
alter role autologger_app nocreatedb nocreaterole nobypassrls connection limit 20;
alter role autologger_app set search_path = catalog;
alter role autologger_app set statement_timeout = '30s';
alter role autologger_app set idle_in_transaction_session_timeout = '15s';
do $$
  begin
    if exists (select from pg_auth_members where member = 'autologger_app'::regrole) then
      raise exception 'autologger_app must not be a member of any role';
    end if;
    if exists (select from pg_roles where rolname = 'autologger_app'
               and (rolsuper or rolreplication)) then
      raise exception 'autologger_app must not be a superuser or a replication role';
    end if;
  end
$$;
-- role:end

grant usage on schema catalog to autologger_app;
grant select, insert, update, delete on all tables in schema catalog to autologger_app;
alter default privileges for role postgres in schema catalog
  grant select, insert, update, delete on tables to autologger_app;
