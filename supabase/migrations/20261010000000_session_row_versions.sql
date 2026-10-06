-- Session row versions (ADR 0021 slice 7c-1, OpenSpec change `session-row-versions`, design D1).
--
-- - `version` on the three hand-edited session tables (events, transcript words, topics): 1 for
--   every existing and new row, and every update sets it to the stored version plus one (the
--   server's statements; api-contract-freeze "Session content rows carry their version").
-- - `catalog.sessions.revision`: the session's revision, advanced once per session write
--   transaction (api-contract-freeze "The session revision advances once per session write"). It
--   starts at each session's `events_stream_revision` meta value, or 0 when that value is missing
--   or not a plain non-negative integer. The meta rows stay: the server stops reading and writing
--   them, and a later cleanup migration drops them, so a revert of this slice loses no data.
-- - `catalog.session_overwrites`: one row per audited overwrite (catalog-database "Session
--   overwrites are recorded in the catalog"). Row-level security with the allow-all system policy
--   every catalog table has, and one user policy for insert only: the row names the binding's own
--   user and a session of one of that user's accessible shows (the session content rule).
--   `catalog_user` holds the insert privilege only (the catalog's default privileges grant all four).
--
-- Adding a column with a constant default is metadata-only, so no table is rewritten.

alter table catalog.session_events add column version bigint not null default 1;
alter table catalog.session_transcript_words add column version bigint not null default 1;
alter table catalog.session_topics add column version bigint not null default 1;

alter table catalog.sessions add column revision bigint not null default 0;
update catalog.sessions s set revision = m.value::bigint
  from catalog.session_meta m
  where m.session_id = s.id and m.key = 'events_stream_revision' and m.value ~ '^[0-9]{1,18}$';

create table catalog.session_overwrites (
  session_id text collate "C" not null references catalog.sessions (id),
  id text collate "C" not null,
  table_name text not null check (table_name in
    ('session_events', 'session_transcript_words', 'session_topics')),
  row_id text collate "C" not null,
  user_id text collate "C" not null,
  at_utc text not null,
  replaced_version bigint not null,
  before_json text not null,
  after_json text,
  primary key (session_id, id)
);

alter table catalog.session_overwrites enable row level security;

drop policy if exists session_overwrites_system_all on catalog.session_overwrites;
create policy session_overwrites_system_all on catalog.session_overwrites
  for all to catalog_system using (true) with check (true);

drop policy if exists session_overwrites_user_insert on catalog.session_overwrites;
create policy session_overwrites_user_insert on catalog.session_overwrites
  for insert to catalog_user with check (
    user_id = catalog.app_user_id()
    and exists (select 1 from catalog.sessions s where s.id = session_id
                and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))));

revoke select, update, delete on catalog.session_overwrites from catalog_user;
