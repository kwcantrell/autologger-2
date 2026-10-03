-- session-content-policies spike (design "Assumptions and evidence", A1-A5). Read-only in effect:
-- it runs the draft migration, creates its fixtures and runs every probe inside ONE transaction
-- that ends in ROLLBACK, so nothing is left behind. Run from the repo root against the dev
-- database (after `make dev-up`):
--
--   { echo 'begin; set local role postgres;'; \
--     cat openspec/changes/session-content-policies/spike/20261009000000_session_content_policies.sql \
--       openspec/changes/session-content-policies/spike/spike7b2.sql; } \
--     | docker exec -i autologger-dev-db-1 psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=0
--
-- It connects as the image's superuser only to switch roles: the draft runs as `postgres` (the
-- migrations' role, so the helper is owned by it, as migrate.sh leaves it), and each probe
-- switches to `catalog_user` or `catalog_system` as the app's bound transactions do.
--
-- Actors on the fixture session `:sid` (the first session whose team has an owner): the owner;
-- three users created here in the same team: a member with a grant on the show, a member with a
-- `can_write = 0` grant, and a member without a grant; and an outsider id with no membership.
select s.id as sid, s.show_id as show, sh.studio_id as team, m.user_id as owner
  from catalog.sessions s
  join catalog.shows sh on sh.id = s.show_id
  join catalog.user_studio_memberships m on m.studio_id = sh.studio_id and m.role = 'owner'
 order by s.id limit 1 \gset
\set granted 'spike7b2-granted'
\set readonly 'spike7b2-grant-cannot-write'
\set nogrant 'spike7b2-member-no-grant'
\set outsider 'spike-outsider-no-membership'
reset role;
\pset footer off

set local role catalog_system;
insert into catalog.users (id, google_sub, email, created_at_utc)
  select u, u, u || '@spike.invalid', '2026-10-03T00:00:00Z'
    from unnest(array[:'granted', :'readonly', :'nogrant']) u;
insert into catalog.user_studio_memberships (user_id, studio_id, role)
  select u, :'team', 'member' from unnest(array[:'granted', :'readonly', :'nogrant']) u;
insert into catalog.show_grants (user_id, show_id, can_write, granted_at_utc) values
  (:'granted', :'show', 1, '2026-10-03T00:00:00Z'),
  (:'readonly', :'show', 0, '2026-10-03T00:00:00Z');
insert into catalog.session_events (session_id, id, wall_time_utc, frame_rate, category, message)
  values (:'sid', 'spike7b2-ev', '2026-10-03T00:00:00Z', 24, 'Note', 'spike');
reset role;

\echo A1 helper: owner, security definer, config, execute grants
select p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig,
       has_function_privilege('catalog_user', p.oid, 'execute') as catalog_user,
       has_function_privilege('catalog_system', p.oid, 'execute') as catalog_system,
       has_function_privilege('autologger_app', p.oid, 'execute') as autologger_app,
       has_function_privilege('anon', p.oid, 'execute') as anon
  from pg_proc p
 where p.pronamespace = 'catalog'::regnamespace and p.proname = 'session_exists';
\echo A1 policies per session table (catalog_user)
select count(*) as user_policies, count(distinct tablename) as tables
  from pg_policies where schemaname = 'catalog' and tablename like 'session\_%'
   and 'catalog_user' = any (roles);
select count(*) as all_catalog_user_policies
  from pg_policies where schemaname = 'catalog' and 'catalog_user' = any (roles);

-- For each actor: sees the session row, locks it, reads its events, inserts content, runs the
-- 7b-1 projection statement, and the snapshot probe (inside a read-only transaction).
\echo A2-A5 per actor: row seen, row locked, events seen, insert, projection rows, probe ok, exists
\echo actor owner
savepoint act;
set local role catalog_user;
select set_config('app.user_id', :'owner', true) is not null as bound;
select 'owner' as who,
       (select count(*) from catalog.sessions where id = :'sid') as row_seen,
       (select count(*) from catalog.session_events where session_id = :'sid') as events_seen;
select count(*) as locked from (select 1 from catalog.sessions where id = :'sid' for update) x;
savepoint ins;
insert into catalog.session_meta (session_id, key, value) values (:'sid', 'spike7b2-owner', '1');
rollback to savepoint ins;
update catalog.session_meta set value = value where session_id = :'sid';
update catalog.sessions s set event_count = e.n, max_timecode_total_frames = e.mx,
    is_rolling = t.is_rolling, current_take = t.current_take,
    transport_elapsed_frames = t.elapsed_frames, roll_started_at_utc = t.roll_started_at_utc
  from (select count(*) as n, max(timecode_total_frames) as mx
          from catalog.session_events where session_id = :'sid') e, catalog.session_transport t
 where s.id = :'sid' and t.session_id = :'sid';
rollback to savepoint act;
savepoint probe;
set local transaction read only;
set local role catalog_user;
select set_config('app.user_id', :'owner', true) is not null as bound;
select exists (select 1 from catalog.sessions s where s.id = :'sid'
                 and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))) as probe_ok,
       catalog.session_exists(:'sid') as exists_real,
       catalog.session_exists('no-such-session-7b2') as exists_missing;
rollback to savepoint probe;

\echo actor granted
savepoint act;
set local role catalog_user;
select set_config('app.user_id', :'granted', true) is not null as bound;
select 'granted' as who,
       (select count(*) from catalog.sessions where id = :'sid') as row_seen,
       (select count(*) from catalog.session_events where session_id = :'sid') as events_seen;
select count(*) as locked from (select 1 from catalog.sessions where id = :'sid' for update) x;
savepoint ins;
insert into catalog.session_meta (session_id, key, value) values (:'sid', 'spike7b2-granted', '1');
rollback to savepoint ins;
update catalog.session_meta set value = value where session_id = :'sid';
update catalog.sessions s set event_count = e.n, max_timecode_total_frames = e.mx,
    is_rolling = t.is_rolling, current_take = t.current_take,
    transport_elapsed_frames = t.elapsed_frames, roll_started_at_utc = t.roll_started_at_utc
  from (select count(*) as n, max(timecode_total_frames) as mx
          from catalog.session_events where session_id = :'sid') e, catalog.session_transport t
 where s.id = :'sid' and t.session_id = :'sid';
rollback to savepoint act;
savepoint probe;
set local transaction read only;
set local role catalog_user;
select set_config('app.user_id', :'granted', true) is not null as bound;
select exists (select 1 from catalog.sessions s where s.id = :'sid'
                 and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))) as probe_ok,
       catalog.session_exists(:'sid') as exists_real,
       catalog.session_exists('no-such-session-7b2') as exists_missing;
rollback to savepoint probe;

\echo actor readonly
savepoint act;
set local role catalog_user;
select set_config('app.user_id', :'readonly', true) is not null as bound;
select 'readonly' as who,
       (select count(*) from catalog.sessions where id = :'sid') as row_seen,
       (select count(*) from catalog.session_events where session_id = :'sid') as events_seen;
select count(*) as locked from (select 1 from catalog.sessions where id = :'sid' for update) x;
savepoint ins;
insert into catalog.session_meta (session_id, key, value) values (:'sid', 'spike7b2-readonly', '1');
rollback to savepoint ins;
update catalog.session_meta set value = value where session_id = :'sid';
update catalog.sessions s set event_count = e.n, max_timecode_total_frames = e.mx,
    is_rolling = t.is_rolling, current_take = t.current_take,
    transport_elapsed_frames = t.elapsed_frames, roll_started_at_utc = t.roll_started_at_utc
  from (select count(*) as n, max(timecode_total_frames) as mx
          from catalog.session_events where session_id = :'sid') e, catalog.session_transport t
 where s.id = :'sid' and t.session_id = :'sid';
rollback to savepoint act;
savepoint probe;
set local transaction read only;
set local role catalog_user;
select set_config('app.user_id', :'readonly', true) is not null as bound;
select exists (select 1 from catalog.sessions s where s.id = :'sid'
                 and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))) as probe_ok,
       catalog.session_exists(:'sid') as exists_real,
       catalog.session_exists('no-such-session-7b2') as exists_missing;
rollback to savepoint probe;

\echo actor nogrant
savepoint act;
set local role catalog_user;
select set_config('app.user_id', :'nogrant', true) is not null as bound;
select 'nogrant' as who,
       (select count(*) from catalog.sessions where id = :'sid') as row_seen,
       (select count(*) from catalog.session_events where session_id = :'sid') as events_seen;
select count(*) as locked from (select 1 from catalog.sessions where id = :'sid' for update) x;
savepoint ins;
insert into catalog.session_meta (session_id, key, value) values (:'sid', 'spike7b2-nogrant', '1');
rollback to savepoint ins;
update catalog.session_meta set value = value where session_id = :'sid';
update catalog.sessions s set event_count = e.n, max_timecode_total_frames = e.mx,
    is_rolling = t.is_rolling, current_take = t.current_take,
    transport_elapsed_frames = t.elapsed_frames, roll_started_at_utc = t.roll_started_at_utc
  from (select count(*) as n, max(timecode_total_frames) as mx
          from catalog.session_events where session_id = :'sid') e, catalog.session_transport t
 where s.id = :'sid' and t.session_id = :'sid';
rollback to savepoint act;
savepoint probe;
set local transaction read only;
set local role catalog_user;
select set_config('app.user_id', :'nogrant', true) is not null as bound;
select exists (select 1 from catalog.sessions s where s.id = :'sid'
                 and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))) as probe_ok,
       catalog.session_exists(:'sid') as exists_real,
       catalog.session_exists('no-such-session-7b2') as exists_missing;
rollback to savepoint probe;

\echo actor outsider
savepoint act;
set local role catalog_user;
select set_config('app.user_id', :'outsider', true) is not null as bound;
select 'outsider' as who,
       (select count(*) from catalog.sessions where id = :'sid') as row_seen,
       (select count(*) from catalog.session_events where session_id = :'sid') as events_seen;
select count(*) as locked from (select 1 from catalog.sessions where id = :'sid' for update) x;
savepoint ins;
insert into catalog.session_meta (session_id, key, value) values (:'sid', 'spike7b2-outsider', '1');
rollback to savepoint ins;
update catalog.session_meta set value = value where session_id = :'sid';
update catalog.sessions s set event_count = e.n, max_timecode_total_frames = e.mx,
    is_rolling = t.is_rolling, current_take = t.current_take,
    transport_elapsed_frames = t.elapsed_frames, roll_started_at_utc = t.roll_started_at_utc
  from (select count(*) as n, max(timecode_total_frames) as mx
          from catalog.session_events where session_id = :'sid') e, catalog.session_transport t
 where s.id = :'sid' and t.session_id = :'sid';
rollback to savepoint act;
savepoint probe;
set local transaction read only;
set local role catalog_user;
select set_config('app.user_id', :'outsider', true) is not null as bound;
select exists (select 1 from catalog.sessions s where s.id = :'sid'
                 and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))) as probe_ok,
       catalog.session_exists(:'sid') as exists_real,
       catalog.session_exists('no-such-session-7b2') as exists_missing;
rollback to savepoint probe;

\echo A3 FOR SHARE in a read-only snapshot
savepoint ro;
set local transaction read only;
set local role catalog_user;
select set_config('app.user_id', :'owner', true) is not null as bound;
select 1 from catalog.sessions where id = :'sid' for share;
rollback to savepoint ro;

\echo A4 an owner insert for a session id that does not exist
savepoint miss;
set local role catalog_user;
select set_config('app.user_id', :'owner', true) is not null as bound;
insert into catalog.session_meta (session_id, key, value) values ('no-such-session-7b2', 'k', 'v');
rollback to savepoint miss;

rollback;
