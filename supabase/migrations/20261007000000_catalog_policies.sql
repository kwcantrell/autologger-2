-- Catalog policies (ADR 0021 slice 6b-2, OpenSpec change `catalog-policies`, design D1, D2, D4,
-- D7).
--
-- Seven SECURITY DEFINER helpers read the membership facts the `catalog_user` policies need. They
-- are owned by `postgres` (which has BYPASSRLS), so each body reads every row and its `WHERE` is
-- the whole check. Each pins `search_path`, uses schema-qualified names only, and is executable by
-- `catalog_user` only. `enable_seqscan = off` holds inside the call only: on the catalog's small
-- tables the planner would otherwise scan sequentially, and under SERIALIZABLE a sequential scan
-- takes a relation-level predicate lock (design D1, A10).
--
-- A default settings row is stored for every team that has none (design D7): reads no longer
-- write, and the default blob draws fresh category ids on every call.
--
-- The `<table>_user_all` policies are replaced by 23 per-command `catalog_user` policies that hold
-- the team permission model (design D2; catalog-database "User policies enforce the team
-- permission model"), and `catalog_user`'s privileges narrow: none on `kv`; on `users`, `SELECT`
-- and `UPDATE (given_name, family_name)` only; no `INSERT` on memberships and invites (owner
-- decision B). `catalog_system` keeps its allow-all policies and full privileges.
--
-- No transaction-control lines: every `begin`/`end` inside a DO block stays indented (migrate.sh
-- refuses a line that starts with one).

-- Teams the user is a member of (any role). The membership PK (user_id, studio_id) serves it.
create or replace function catalog.member_studios(uid text) returns setof text
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  set enable_seqscan = off
  as $$ select m.studio_id from catalog.user_studio_memberships m where m.user_id = uid $$;

-- Teams the user manages (owner or admin).
create or replace function catalog.manager_studios(uid text) returns setof text
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  set enable_seqscan = off
  as $$ select m.studio_id from catalog.user_studio_memberships m
        where m.user_id = uid and m.role in ('owner', 'admin') $$;

-- Shows the user can access: owner/admin of the show's team, or a grant while still a member
-- (the same predicate as authStore's SHOW_ACCESS_PREDICATE, show-grants D2).
create or replace function catalog.accessible_shows(uid text) returns setof text
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  set enable_seqscan = off
  as $$ select s.id from catalog.shows s
        join catalog.user_studio_memberships m on m.studio_id = s.studio_id and m.user_id = uid
        where m.role in ('owner', 'admin')
           or exists (select 1 from catalog.show_grants g
                      where g.user_id = uid and g.show_id = s.id) $$;

-- Shows of the user's member teams (session and grant reads).
create or replace function catalog.member_shows(uid text) returns setof text
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  set enable_seqscan = off
  as $$ select s.id from catalog.shows s
        join catalog.user_studio_memberships m on m.studio_id = s.studio_id and m.user_id = uid $$;

-- Users who share a team with the user, the user included.
create or replace function catalog.co_members(uid text) returns setof text
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  set enable_seqscan = off
  as $$ select o.user_id from catalog.user_studio_memberships m
        join catalog.user_studio_memberships o on o.studio_id = m.studio_id
        where m.user_id = uid $$;

-- Existence checks for the two status-preserving probes (design D6).
create or replace function catalog.studio_exists(id text) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  set enable_seqscan = off
  as $$ select exists (select 1 from catalog.studio_definitions d where d.id = studio_exists.id) $$;

create or replace function catalog.show_exists(id text) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  set enable_seqscan = off
  as $$ select exists (select 1 from catalog.shows s where s.id = show_exists.id) $$;

revoke all on function catalog.member_studios(text) from public;
revoke all on function catalog.manager_studios(text) from public;
revoke all on function catalog.accessible_shows(text) from public;
revoke all on function catalog.member_shows(text) from public;
revoke all on function catalog.co_members(text) from public;
revoke all on function catalog.studio_exists(text) from public;
revoke all on function catalog.show_exists(text) from public;
grant execute on function catalog.member_studios(text) to catalog_user;
grant execute on function catalog.manager_studios(text) to catalog_user;
grant execute on function catalog.accessible_shows(text) to catalog_user;
grant execute on function catalog.member_shows(text) to catalog_user;
grant execute on function catalog.co_members(text) to catalog_user;
grant execute on function catalog.studio_exists(text) to catalog_user;
grant execute on function catalog.show_exists(text) to catalog_user;

-- Default settings for every team without a row (design D7): the shape of the server's
-- `validateSettingsBlob(defaultSettingsBlob(id))`, with fresh category ids. Stored rows stay.
-- backfill:begin
insert into catalog.app_settings (key, value)
select 'studio_config:' || d.id,
       jsonb_build_object(
         'categories', jsonb_build_array(
           jsonb_build_object('id', gen_random_uuid()::text, 'name', 'Scene', 'color', '#4a9fd4',
             'type', 'BUTTON', 'dropdown_options', '[]'::jsonb, 'on_label', '', 'off_label', ''),
           jsonb_build_object('id', gen_random_uuid()::text, 'name', 'Audio issue', 'color', '#a86bdc',
             'type', 'DROPDOWN', 'dropdown_options', jsonb_build_array(
               jsonb_build_object('label', 'Lav', 'needs_context', false),
               jsonb_build_object('label', 'Boom', 'needs_context', false)),
             'on_label', '', 'off_label', ''),
           jsonb_build_object('id', gen_random_uuid()::text, 'name', 'Note', 'color', '#6bcf7a',
             'type', 'TEXT', 'dropdown_options', '[]'::jsonb, 'on_label', '', 'off_label', '')),
         'show_title_format', '', 'default_frame_rate', 24.0)::text
from catalog.studio_definitions d
on conflict (key) do nothing;
-- backfill:end

-- The catalog_user policies (design D2). `me` is `catalog.app_user_id()`; each helper call is a
-- set subquery, evaluated once per statement as a hashed subplan. No policy, so no row: inserts
-- into studio_definitions, and deletes from shows and sessions. kv has no catalog_user policy and
-- no privilege (below), so a user-bound statement on it fails with 42501.
drop policy if exists users_user_all on catalog.users;
drop policy if exists user_studio_memberships_user_all on catalog.user_studio_memberships;
drop policy if exists user_prefs_user_all on catalog.user_prefs;
drop policy if exists studio_definitions_user_all on catalog.studio_definitions;
drop policy if exists shows_user_all on catalog.shows;
drop policy if exists app_settings_user_all on catalog.app_settings;
drop policy if exists sessions_user_all on catalog.sessions;
drop policy if exists kv_user_all on catalog.kv;
drop policy if exists team_invites_user_all on catalog.team_invites;
drop policy if exists show_grants_user_all on catalog.show_grants;

drop policy if exists users_user_select on catalog.users;
create policy users_user_select on catalog.users for select to catalog_user
  using (id = (select catalog.app_user_id()) or id in (select catalog.co_members(catalog.app_user_id())));

drop policy if exists users_user_update on catalog.users;
create policy users_user_update on catalog.users for update to catalog_user
  using (id = (select catalog.app_user_id()))
  with check (id = (select catalog.app_user_id()));

drop policy if exists user_studio_memberships_user_select on catalog.user_studio_memberships;
create policy user_studio_memberships_user_select on catalog.user_studio_memberships for select to catalog_user
  using (studio_id in (select catalog.member_studios(catalog.app_user_id())));

drop policy if exists user_studio_memberships_user_update on catalog.user_studio_memberships;
create policy user_studio_memberships_user_update on catalog.user_studio_memberships for update to catalog_user
  using (studio_id in (select catalog.member_studios(catalog.app_user_id())))
  with check (studio_id in (select catalog.member_studios(catalog.app_user_id())));

drop policy if exists user_studio_memberships_user_delete on catalog.user_studio_memberships;
create policy user_studio_memberships_user_delete on catalog.user_studio_memberships for delete to catalog_user
  using (studio_id in (select catalog.member_studios(catalog.app_user_id())));

drop policy if exists team_invites_user_select on catalog.team_invites;
create policy team_invites_user_select on catalog.team_invites for select to catalog_user
  using (studio_id in (select catalog.member_studios(catalog.app_user_id())));

drop policy if exists team_invites_user_update on catalog.team_invites;
create policy team_invites_user_update on catalog.team_invites for update to catalog_user
  using (studio_id in (select catalog.member_studios(catalog.app_user_id())))
  with check (studio_id in (select catalog.member_studios(catalog.app_user_id())));

drop policy if exists team_invites_user_delete on catalog.team_invites;
create policy team_invites_user_delete on catalog.team_invites for delete to catalog_user
  using (studio_id in (select catalog.member_studios(catalog.app_user_id())));

drop policy if exists user_prefs_user_all on catalog.user_prefs;
create policy user_prefs_user_all on catalog.user_prefs for all to catalog_user
  using (user_id = (select catalog.app_user_id()))
  with check (user_id = (select catalog.app_user_id()));

drop policy if exists studio_definitions_user_select on catalog.studio_definitions;
create policy studio_definitions_user_select on catalog.studio_definitions for select to catalog_user
  using (id in (select catalog.member_studios(catalog.app_user_id())));

drop policy if exists studio_definitions_user_update on catalog.studio_definitions;
create policy studio_definitions_user_update on catalog.studio_definitions for update to catalog_user
  using (id in (select catalog.member_studios(catalog.app_user_id())))
  with check (id in (select catalog.member_studios(catalog.app_user_id())));

drop policy if exists studio_definitions_user_delete on catalog.studio_definitions;
create policy studio_definitions_user_delete on catalog.studio_definitions for delete to catalog_user
  using (id in (select catalog.member_studios(catalog.app_user_id())));

drop policy if exists shows_user_select on catalog.shows;
create policy shows_user_select on catalog.shows for select to catalog_user
  using (studio_id in (select catalog.member_studios(catalog.app_user_id())));

drop policy if exists shows_user_insert on catalog.shows;
create policy shows_user_insert on catalog.shows for insert to catalog_user
  with check (studio_id in (select catalog.manager_studios(catalog.app_user_id())));

drop policy if exists shows_user_update on catalog.shows;
create policy shows_user_update on catalog.shows for update to catalog_user
  using (studio_id in (select catalog.manager_studios(catalog.app_user_id())))
  with check (studio_id in (select catalog.manager_studios(catalog.app_user_id())));

drop policy if exists sessions_user_select on catalog.sessions;
create policy sessions_user_select on catalog.sessions for select to catalog_user
  using (show_id in (select catalog.member_shows(catalog.app_user_id())));

drop policy if exists sessions_user_insert on catalog.sessions;
create policy sessions_user_insert on catalog.sessions for insert to catalog_user
  with check (show_id in (select catalog.accessible_shows(catalog.app_user_id())));

drop policy if exists sessions_user_update on catalog.sessions;
create policy sessions_user_update on catalog.sessions for update to catalog_user
  using (show_id in (select catalog.accessible_shows(catalog.app_user_id())))
  with check (show_id in (select catalog.accessible_shows(catalog.app_user_id())));

drop policy if exists app_settings_user_select on catalog.app_settings;
create policy app_settings_user_select on catalog.app_settings for select to catalog_user
  using (key in (select 'studio_config:' || s from catalog.member_studios(catalog.app_user_id()) s));

drop policy if exists app_settings_user_insert on catalog.app_settings;
create policy app_settings_user_insert on catalog.app_settings for insert to catalog_user
  with check (key in (select 'studio_config:' || s from catalog.manager_studios(catalog.app_user_id()) s));

drop policy if exists app_settings_user_update on catalog.app_settings;
create policy app_settings_user_update on catalog.app_settings for update to catalog_user
  using (key in (select 'studio_config:' || s from catalog.manager_studios(catalog.app_user_id()) s))
  with check (key in (select 'studio_config:' || s from catalog.manager_studios(catalog.app_user_id()) s));

drop policy if exists app_settings_user_delete on catalog.app_settings;
create policy app_settings_user_delete on catalog.app_settings for delete to catalog_user
  using (key in (select 'studio_config:' || s from catalog.manager_studios(catalog.app_user_id()) s));

drop policy if exists show_grants_user_all on catalog.show_grants;
create policy show_grants_user_all on catalog.show_grants for all to catalog_user
  using (show_id in (select catalog.member_shows(catalog.app_user_id())))
  with check (show_id in (select catalog.member_shows(catalog.app_user_id())));

-- Privileges narrow with the policies (design D2; owner decision B). A user-bound INSERT into
-- users, memberships or invites, a DELETE from users, or an UPDATE of any other users column
-- fails with 42501 before any policy is consulted.
revoke all on catalog.kv from catalog_user;
revoke insert, update, delete on catalog.users from catalog_user;
grant update (given_name, family_name) on catalog.users to catalog_user;
revoke insert on catalog.user_studio_memberships, catalog.team_invites from catalog_user;
