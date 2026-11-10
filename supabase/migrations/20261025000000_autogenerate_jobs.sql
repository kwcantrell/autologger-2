-- Batch autogenerate jobs (OpenSpec change `batch-autogenerate`, design D1, D2; ADR 0033).
--
-- - `catalog.autogenerate_jobs`: one row per batch job of a team (studio). It stores only the
--   initiator's user id and a name snapshot, never a credential. At most one `queued` or `running`
--   job per team (`idx_autogenerate_jobs_live`). `stop_reason` is set exactly when the job ended
--   `cancelled` (`cancelled`) or `failed` (one of the other reasons). `consecutive_*_failures`
--   count the processed sessions in a row whose speech-to-text / language-model step failed
--   (design D17). Times are epoch milliseconds from the app's Clock. Jobs go with their team
--   (`on delete cascade`).
-- - `catalog.autogenerate_items`: one row per session and selected step, with the session's
--   processing ordinal and step order, its status and classified outcome (the contract's fixed
--   codes, each only with its item status), the attempts, and the run ids and topic ids its
--   attempts wrote (comma lists written ahead of the work, design D7), the own rows it kept
--   because a person had edited them, and the wiki accept counts. No foreign key to the session:
--   the report outlives it.
-- - Row-level security on both, with the `<table>_system_all` policy for `catalog_system` (the
--   worker's reviewed reason `autogenerate-worker`). `catalog_user`: owners and admins of the team
--   select jobs and items; a user inserts only a `queued` job it initiates for a team it manages,
--   with no lease, cancel or stop column set, and `pending` items of its own `queued` job; it may
--   update only the cancel columns, `status`, `stop_reason`, `finished_at_ms` and `updated_at_ms`
--   of a job of a team it manages, and `autogenerate_jobs_user_guard` narrows that to a cancel
--   request (once, naming the caller, on a live job) and, for a `queued` job, ending it
--   `cancelled`. No user update on items; no user delete.
-- - Runs as `postgres`, so the catalog's default privileges grant `catalog_user` and
--   `catalog_system` all four privileges; the revokes below narrow `catalog_user`'s.
-- - No transaction-control lines: `begin`/`end` inside function bodies stay indented (migrate.sh).
-- - Rollback (a documented step, not a migration file), after cancelling live jobs and reverting
--   the code:
--   `drop table catalog.autogenerate_items; drop table catalog.autogenerate_jobs;
--    drop function catalog.autogenerate_jobs_user_guard();`
--   Wiki pages changed by batch accepts keep their revisions (note `(batch <job id>)`).

create table catalog.autogenerate_jobs (
  id                     text collate "C" primary key,
  team_id                text collate "C" not null
                           references catalog.studio_definitions (id) on delete cascade,
  initiator_user_id      text collate "C" not null references catalog.users (id),
  initiator_name         text collate "C" not null,
  scope                  text collate "C" not null check (scope in ('shows', 'sessions')),
  show_ids_json          text collate "C",
  steps                  text collate "C" not null,
  wiki_mode              text collate "C" not null check (wiki_mode in ('accept', 'pending')),
  status                 text collate "C" not null default 'queued'
                           check (status in ('queued', 'running', 'finished', 'cancelled', 'failed')),
  stop_reason            text collate "C" check (stop_reason in ('cancelled', 'initiator-unavailable',
                           'initiator-role-lost', 'not-approved', 'unconfigured-stt',
                           'unconfigured-llm', 'provider-failing')),
  consecutive_stt_failures smallint not null default 0,
  consecutive_llm_failures smallint not null default 0,
  session_count          integer not null check (session_count between 1 and 1000),
  locked_by              text collate "C",
  locked_until_ms        bigint,
  cancel_requested_at_ms bigint,
  cancel_requested_by_user_id text collate "C",
  cancel_requested_by_name    text collate "C",
  created_at_ms          bigint not null,
  started_at_ms          bigint,
  finished_at_ms         bigint,
  updated_at_ms          bigint not null,
  constraint autogenerate_jobs_stop_reason check (
    ((status in ('cancelled', 'failed')) = (stop_reason is not null))
    and ((status = 'cancelled') = (stop_reason is not distinct from 'cancelled')))
);
create unique index idx_autogenerate_jobs_live on catalog.autogenerate_jobs (team_id)
  where status in ('queued', 'running');
create index idx_autogenerate_jobs_team on catalog.autogenerate_jobs (team_id, created_at_ms desc);
create index idx_autogenerate_jobs_due on catalog.autogenerate_jobs (created_at_ms)
  where status in ('queued', 'running');

create table catalog.autogenerate_items (
  job_id          text collate "C" not null
                    references catalog.autogenerate_jobs (id) on delete cascade,
  session_id      text collate "C" not null,
  step            text collate "C" not null check (step in ('transcript', 'events', 'topics', 'wiki')),
  ordinal         integer not null,
  step_order      smallint not null,
  effective_date  text collate "C",
  status          text collate "C" not null default 'pending'
                    check (status in ('pending', 'running', 'done', 'skipped', 'failed', 'cancelled')),
  outcome         text collate "C",
  attempts        smallint not null default 0,
  run_ids         text collate "C" not null default '',
  own_topic_ids   text collate "C" not null default '',
  kept_edited     integer,
  wiki_accepted   integer,
  wiki_pending    integer,
  started_at_ms   bigint,
  finished_at_ms  bigint,
  primary key (job_id, session_id, step),
  -- The contract's 20 fixed codes; the detail text is looked up from the code, never stored.
  constraint autogenerate_items_outcome check (outcome is null or outcome in ('present',
    'no-audio', 'no-speech', 'no-transcript', 'no-anchors', 'no-instructions', 'busy',
    'access-lost', 'session-gone', 'earlier-step-failed', 'unconfigured', 'provider-failed',
    'rate-limited', 'too-large', 'missing-audio-file', 'unreadable', 'generation-failed',
    'interrupted', 'cancelled', 'job-stopped')),
  -- Each outcome only with its item status (contract "Batch autogenerate job object").
  constraint autogenerate_items_outcome_status check (case
    when status = 'skipped' then outcome is not null and outcome in ('present', 'no-audio',
      'no-speech', 'no-transcript', 'no-anchors', 'no-instructions', 'busy', 'access-lost',
      'session-gone', 'earlier-step-failed')
    when status = 'failed' then outcome is not null and outcome in ('unconfigured',
      'provider-failed', 'rate-limited', 'too-large', 'missing-audio-file', 'unreadable',
      'generation-failed', 'interrupted')
    when status = 'cancelled' then outcome is not null and outcome in ('cancelled', 'job-stopped')
    else outcome is null
  end)
);
create index idx_autogenerate_items_order on catalog.autogenerate_items (job_id, ordinal, step_order);
create index idx_autogenerate_items_session on catalog.autogenerate_items (session_id, step);

-- Row-level security: the system policy on each, then the catalog_user rules.
alter table catalog.autogenerate_jobs enable row level security;
alter table catalog.autogenerate_items enable row level security;

drop policy if exists autogenerate_jobs_system_all on catalog.autogenerate_jobs;
create policy autogenerate_jobs_system_all on catalog.autogenerate_jobs
  for all to catalog_system using (true) with check (true);
drop policy if exists autogenerate_items_system_all on catalog.autogenerate_items;
create policy autogenerate_items_system_all on catalog.autogenerate_items
  for all to catalog_system using (true) with check (true);

drop policy if exists autogenerate_jobs_user_select on catalog.autogenerate_jobs;
create policy autogenerate_jobs_user_select on catalog.autogenerate_jobs
  for select to catalog_user
  using (team_id in (select catalog.manager_studios(catalog.app_user_id())));

drop policy if exists autogenerate_jobs_user_insert on catalog.autogenerate_jobs;
create policy autogenerate_jobs_user_insert on catalog.autogenerate_jobs
  for insert to catalog_user
  with check (
    team_id in (select catalog.manager_studios(catalog.app_user_id()))
    and initiator_user_id = catalog.app_user_id()
    and status = 'queued'
    and stop_reason is null
    and locked_by is null and locked_until_ms is null
    and cancel_requested_at_ms is null and cancel_requested_by_user_id is null
    and cancel_requested_by_name is null
    and started_at_ms is null and finished_at_ms is null
    and consecutive_stt_failures = 0 and consecutive_llm_failures = 0);

drop policy if exists autogenerate_jobs_user_update on catalog.autogenerate_jobs;
create policy autogenerate_jobs_user_update on catalog.autogenerate_jobs
  for update to catalog_user
  using (team_id in (select catalog.manager_studios(catalog.app_user_id())))
  with check (team_id in (select catalog.manager_studios(catalog.app_user_id())));

drop policy if exists autogenerate_items_user_select on catalog.autogenerate_items;
create policy autogenerate_items_user_select on catalog.autogenerate_items
  for select to catalog_user
  using (exists (select 1 from catalog.autogenerate_jobs j where j.id = job_id
                 and j.team_id in (select catalog.manager_studios(catalog.app_user_id()))));

drop policy if exists autogenerate_items_user_insert on catalog.autogenerate_items;
create policy autogenerate_items_user_insert on catalog.autogenerate_items
  for insert to catalog_user
  with check (
    exists (select 1 from catalog.autogenerate_jobs j where j.id = job_id
            and j.initiator_user_id = catalog.app_user_id() and j.status = 'queued'
            and j.team_id in (select catalog.manager_studios(catalog.app_user_id())))
    and status = 'pending' and outcome is null and attempts = 0
    and run_ids = '' and own_topic_ids = ''
    and kept_edited is null and wiki_accepted is null and wiki_pending is null
    and started_at_ms is null and finished_at_ms is null);

revoke update, delete on catalog.autogenerate_jobs from catalog_user;
revoke update, delete on catalog.autogenerate_items from catalog_user;
grant update (cancel_requested_at_ms, cancel_requested_by_user_id, cancel_requested_by_name,
              status, stop_reason, finished_at_ms, updated_at_ms)
  on catalog.autogenerate_jobs to catalog_user;

-- The user's update (design D2): for catalog_user only, exactly
-- (a) setting the cancel columns once, naming the caller, on a `queued` or `running` job; and
-- (b) for a `queued` job in the same statement, `status -> cancelled`, `stop_reason -> cancelled`
--     and `finished_at_ms` set.
-- Anything else raises 42501. Other roles (catalog_system, postgres) are not bound.
create or replace function catalog.autogenerate_jobs_user_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
  declare
    uid text := nullif(current_setting('app.user_id', true), '');
  begin
    if current_user <> 'catalog_user' then
      return new;
    end if;
    if old.status in ('queued', 'running')
       and old.cancel_requested_at_ms is null
       and new.cancel_requested_at_ms is not null
       and uid is not null
       and new.cancel_requested_by_user_id is not distinct from uid
       and new.cancel_requested_by_name is not null then
      if new.status = old.status
         and new.stop_reason is not distinct from old.stop_reason
         and new.finished_at_ms is not distinct from old.finished_at_ms then
        return new;
      end if;
      if old.status = 'queued' and new.status = 'cancelled'
         and new.stop_reason is not distinct from 'cancelled'
         and new.finished_at_ms is not null then
        return new;
      end if;
    end if;
    raise exception 'autogenerate job update refused' using errcode = '42501';
  end
$$;
revoke all on function catalog.autogenerate_jobs_user_guard() from public;
drop trigger if exists autogenerate_jobs_user_guard on catalog.autogenerate_jobs;
create trigger autogenerate_jobs_user_guard before update on catalog.autogenerate_jobs
  for each row execute function catalog.autogenerate_jobs_user_guard();
