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
