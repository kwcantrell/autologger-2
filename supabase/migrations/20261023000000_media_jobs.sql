-- Media jobs, resumable uploads and recording seams (OpenSpec change `media-worker`, design D1,
-- D2, D5, D7, D12, D18).
--
-- - `catalog.media_jobs`: the durable queue of audio post-processing (`ingest` per new segment,
--   `merge` per finished recording). At most one live (`queued`, `running`, `done`) job per kind,
--   session and target (`idx_media_jobs_live`, so enqueues coalesce with `ON CONFLICT DO
--   NOTHING`). `input_bytes` is the inputs' total size (the worker's lanes and low-disk rule);
--   `result_json` is at most 256 KiB. Times are epoch milliseconds from the app's Clock.
-- - `catalog.media_uploads`: resumable parts uploads staged under `BLOB_DIR/.tmp/upload-<id>`;
--   one sha256 per part declared at create, received parts recorded as they arrive.
-- - `catalog.session_audio_seams`: one row per accepted chunk window, keyed by `(session_id,
--   recording_ordinal, started_at_utc)`, pointing at the segment holding its audio with its
--   media offset and the original chunk's blob key. It is the index behind the idempotent
--   segment POST (D18); deleting a segment deletes its seams (the import rollback).
-- - `catalog.session_audio_segments` gains `duration_ms`, `media_status` (`pending`, `done`,
--   `failed`; existing rows stay null, the browser-decode fallback) and `media_error`.
-- - Row-level security on the three tables, each with the `<table>_system_all` policy.
--   `catalog_user`: `media_jobs` insert and select for sessions it can access (jobs are enqueued
--   inside user transactions; update and delete revoked); `media_uploads` every command on the
--   uploads it created on sessions it can access; `session_audio_seams` like the session tables.
--   The session-access rule is the session tables' (`accessible_shows`).
-- - Runs as `postgres`, so the catalog's default privileges grant `catalog_user` and
--   `catalog_system` all four privileges; the revokes below narrow `catalog_user`'s.
-- - No transaction-control lines: `begin`/`end` inside DO blocks stay indented (migrate.sh).
-- - Rollback (a documented step, not a migration file), after reverting the code:
--   `drop table catalog.media_jobs; drop table catalog.media_uploads;
--    drop table catalog.session_audio_seams;
--    alter table catalog.session_audio_segments drop column duration_ms,
--      drop column media_status, drop column media_error;`
--   then the worker role (below): `drop owned by autologger_media; drop role autologger_media;`
--   (cluster-wide: only once no database of the cluster still uses it). Staged uploads under
--   `BLOB_DIR/.tmp/upload-*` and worker output under `BLOB_DIR/media/` can then be deleted; blobs
--   under `BLOB_DIR/.trash/` are restored by moving them back (README "Media jobs").

create table catalog.media_jobs (
  id              text collate "C" primary key,
  kind            text collate "C" not null check (kind in ('ingest', 'merge')),
  session_id      text collate "C" not null references catalog.sessions (id),
  target          text collate "C" not null,
  status          text collate "C" not null default 'queued'
                    check (status in ('queued', 'running', 'done', 'applied', 'failed', 'cancelled')),
  attempts        integer not null default 0,
  max_attempts    integer not null default 5,
  input_bytes     bigint not null check (input_bytes >= 0),
  run_after_ms    bigint not null,
  locked_by       text collate "C",
  locked_until_ms bigint,
  result_json     text collate "C",
  error           text collate "C",
  created_at_ms   bigint not null,
  updated_at_ms   bigint not null,
  applied_at_ms   bigint,
  constraint media_jobs_result_json_size check (octet_length(result_json) <= 262144),
  -- The classified codes only (D2): never a path or tool output.
  constraint media_jobs_error_code check (error is null or error in ('decode-failed',
    'mixed-codecs', 'verify-mismatch', 'interleaved-input', 'missing-blob', 'timeout', 'low-disk',
    'internal', 'invalid-result', 'inputs-changed'))
);
create unique index idx_media_jobs_live on catalog.media_jobs (kind, session_id, target)
  where status in ('queued', 'running', 'done');
create index idx_media_jobs_due on catalog.media_jobs (run_after_ms, created_at_ms)
  where status = 'queued';
create index idx_media_jobs_status on catalog.media_jobs (status, updated_at_ms);

create table catalog.media_uploads (
  id                 text collate "C" primary key,
  session_id         text collate "C" not null references catalog.sessions (id),
  created_by_user_id text collate "C" not null references catalog.users (id) on delete cascade,
  content_type       text collate "C" not null check (char_length(content_type) between 1 and 255),
  size_bytes         bigint not null check (size_bytes > 0),
  part_size          bigint not null check (part_size > 0),
  parts_total        integer not null check (parts_total between 1 and 10000),
  part_sha256_json   text collate "C" not null,
  received_json      text collate "C" not null default '[]',
  status             text collate "C" not null default 'open' check (status in ('open', 'complete')),
  expires_at_ms      bigint not null,
  created_at_ms      bigint not null
);
create index idx_media_uploads_user on catalog.media_uploads (created_by_user_id, status);
create index idx_media_uploads_expiry on catalog.media_uploads (expires_at_ms);

alter table catalog.session_audio_segments
  add column duration_ms bigint check (duration_ms >= 0),
  add column media_status text collate "C" check (media_status in ('pending', 'done', 'failed')),
  add column media_error text collate "C" check (char_length(media_error) <= 64);

create table catalog.session_audio_seams (
  session_id        text collate "C" not null references catalog.sessions (id),
  recording_ordinal bigint not null,
  started_at_utc    text collate "C" not null,
  ended_at_utc      text collate "C",
  segment_id        text collate "C" not null,
  offset_ms         bigint not null default 0 check (offset_ms >= 0),
  source_key        text collate "C" not null,
  primary key (session_id, recording_ordinal, started_at_utc),
  foreign key (session_id, segment_id)
    references catalog.session_audio_segments (session_id, id) on delete cascade
);
create index idx_session_audio_seams_segment on catalog.session_audio_seams (session_id, segment_id);

-- Row-level security: the system policy on each, then the catalog_user rules.
do $$
  declare t text;
  begin
    foreach t in array array['media_jobs', 'media_uploads', 'session_audio_seams'] loop
      execute format('alter table catalog.%I enable row level security', t);
      execute format('drop policy if exists %I on catalog.%I', t || '_system_all', t);
      execute format('create policy %I on catalog.%I for all to catalog_system using (true) with check (true)', t || '_system_all', t);
    end loop;
  end
$$;

drop policy if exists media_jobs_user_select on catalog.media_jobs;
create policy media_jobs_user_select on catalog.media_jobs
  for select to catalog_user using (
    exists (select 1 from catalog.sessions s where s.id = session_id
            and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))));
drop policy if exists media_jobs_user_insert on catalog.media_jobs;
create policy media_jobs_user_insert on catalog.media_jobs
  for insert to catalog_user with check (
    exists (select 1 from catalog.sessions s where s.id = session_id
            and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))));
revoke update, delete on catalog.media_jobs from catalog_user;

drop policy if exists media_uploads_user_all on catalog.media_uploads;
create policy media_uploads_user_all on catalog.media_uploads
  for all to catalog_user
  using (
    created_by_user_id = catalog.app_user_id()
    and exists (select 1 from catalog.sessions s where s.id = session_id
                and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))))
  with check (
    created_by_user_id = catalog.app_user_id()
    and exists (select 1 from catalog.sessions s where s.id = session_id
                and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))));

drop policy if exists session_audio_seams_user_all on catalog.session_audio_seams;
create policy session_audio_seams_user_all on catalog.session_audio_seams
  for all to catalog_user
  using (
    exists (select 1 from catalog.sessions s where s.id = session_id
            and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))))
  with check (
    exists (select 1 from catalog.sessions s where s.id = session_id
            and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))));

-- The media worker's role (D1, D2). Created NOLOGIN here; migrate.sh's password phase grants LOGIN
-- and sets the password from MEDIA_DB_PASSWORD, as for autologger_app, so a database the runner
-- never migrated has no login for it. It is a member of no role (the catalog roles' membership
-- guard, "only autologger_app and postgres", still holds) and is reset to no special attribute.
-- Its privileges are exactly: USAGE on catalog; SELECT and an eight-column UPDATE on media_jobs;
-- SELECT on session_audio_segments and session_audio_seams; each with a permissive policy.
do $$
  begin
    if not exists (select from pg_roles where rolname = 'autologger_media') then
      create role autologger_media nologin;
    end if;
  end
$$;
alter role autologger_media nocreatedb nocreaterole nobypassrls noreplication connection limit 4;
alter role autologger_media set search_path = catalog;
alter role autologger_media set statement_timeout = '30s';
alter role autologger_media set idle_in_transaction_session_timeout = '15s';
do $$
  begin
    if exists (select from pg_roles where rolname = 'autologger_media' and rolsuper) then
      raise exception 'autologger_media must not be a superuser';
    end if;
    if exists (select from pg_auth_members where member = 'autologger_media'::regrole) then
      raise exception 'autologger_media must not be a member of any role';
    end if;
  end
$$;

-- Roles are cluster-wide: in a second database the role exists, but these grants are new.
grant usage on schema catalog to autologger_media;
grant select on catalog.media_jobs, catalog.session_audio_segments, catalog.session_audio_seams
  to autologger_media;
grant update (status, locked_by, locked_until_ms, attempts, run_after_ms, result_json, error,
              updated_at_ms)
  on catalog.media_jobs to autologger_media;

drop policy if exists media_jobs_media_select on catalog.media_jobs;
create policy media_jobs_media_select on catalog.media_jobs
  for select to autologger_media using (true);
drop policy if exists media_jobs_media_update on catalog.media_jobs;
create policy media_jobs_media_update on catalog.media_jobs
  for update to autologger_media using (true) with check (true);
drop policy if exists session_audio_segments_media_select on catalog.session_audio_segments;
create policy session_audio_segments_media_select on catalog.session_audio_segments
  for select to autologger_media using (true);
drop policy if exists session_audio_seams_media_select on catalog.session_audio_seams;
create policy session_audio_seams_media_select on catalog.session_audio_seams
  for select to autologger_media using (true);

-- The worker's transitions (D2). For autologger_media only: `queued → running` (a claim: the
-- lease free or expired, a holder named, one more attempt), `running → running` (a renewal) and
-- `running → queued | done | failed`, the last three keeping the holder and the attempt count
-- (a re-queue may give back the claim's attempt: the worker's `release`).
-- Anything else raises 42501. All workers share the role, so the trigger cannot tell them apart:
-- each worker's statements are fenced on `locked_by = <its id>` (packages/storage mediaJobs.ts),
-- and the trigger stops any statement from moving a job to another holder outside a claim. The
-- lease clock is the database's. Other roles (catalog_system, postgres) are not bound.
create or replace function catalog.media_jobs_worker_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
  declare
    now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  begin
    if current_user <> 'autologger_media' then
      return new;
    end if;
    -- Bounded values (the app's clocks may lead the database's by a few minutes): a lease at most
    -- 15 min ahead (10 min lease + slack), a new run-after at most 2 h ahead (1 h backoff cap +
    -- slack), so no statement can park a job or hold its lease indefinitely.
    if new.locked_until_ms > now_ms + 900000
       or (new.run_after_ms is distinct from old.run_after_ms
           and new.run_after_ms > now_ms + 7200000) then
      raise exception 'media worker value out of bounds' using errcode = '42501';
    end if;
    if old.status = 'queued' and new.status = 'running' then
      if (old.locked_by is null or old.locked_until_ms is null or old.locked_until_ms <= now_ms)
         and new.locked_by is not null and new.attempts = old.attempts + 1 then
        return new;
      end if;
    elsif old.status = 'running' and new.status in ('running', 'queued', 'done', 'failed') then
      -- A release (`running → queued` without counting the attempt) may give the attempt back,
      -- only under a live lease (its holder, before expiry; a sweep of an expired one may not).
      if new.locked_by is not distinct from old.locked_by
         and (new.attempts = old.attempts
              or (new.status = 'queued' and new.attempts = old.attempts - 1 and old.attempts > 0
                  and old.locked_until_ms > now_ms)) then
        return new;
      end if;
    end if;
    raise exception 'media worker transition % -> % refused', old.status, new.status
      using errcode = '42501';
  end
$$;
revoke all on function catalog.media_jobs_worker_guard() from public;
drop trigger if exists media_jobs_worker_guard on catalog.media_jobs;
create trigger media_jobs_worker_guard before update on catalog.media_jobs
  for each row execute function catalog.media_jobs_worker_guard();
