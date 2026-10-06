-- Session leases (ADR 0021 slice 8a, OpenSpec change `session-leases`, design D1).
--
-- - `catalog.session_leases`: one row per held lease, keyed by session and kind (catalog-database
--   "Session leases are stored in the catalog"). 8a has one kind, `recording`; 8b replaces the named
--   kind check. Times are epoch milliseconds from the server's Clock, never the database's `now()`
--   (design D2). `holder_user_id` is null only when a reviewed system task holds the lease.
-- - Row-level security: the allow-all system policy every catalog table has, and one user policy
--   per command. `R` is the session content rule (a session of one of the binding's accessible
--   shows). Users read and update leases under `R`, and insert, update to or delete only leases
--   naming their own id; they can never write a null holder. The update policy's USING is `R`
--   alone, so a takeover of an expired lease by the server's claim upsert passes (design A2).
--   RLS does not tie a *live* lease to its holder: the database has no Clock time, so the server's
--   statements, the only writers, enforce the holder (design D1, D3).
-- - The table starts empty. The `lease_holder` / `lease_seen_ms` meta rows stay in place for a
--   later cleanup migration, with `events_stream_revision`.
--
-- Runs as `postgres`, so the catalog's default privileges grant catalog_user and catalog_system
-- all four privileges (design A6).

create table catalog.session_leases (
  session_id       text collate "C" not null references catalog.sessions (id),
  kind             text collate "C" not null,
  holder_client_id text collate "C" not null,
  holder_user_id   text collate "C",            -- null: a reviewed system task holds it
  heartbeat_at_ms  bigint not null,
  expires_at_ms    bigint not null,
  primary key (session_id, kind),
  constraint session_leases_kind_check check (kind in ('recording')),
  constraint session_leases_client_check check (holder_client_id <> '' and length(holder_client_id) <= 256)
);

alter table catalog.session_leases enable row level security;

drop policy if exists session_leases_system_all on catalog.session_leases;
create policy session_leases_system_all on catalog.session_leases
  for all to catalog_system using (true) with check (true);

drop policy if exists session_leases_user_select on catalog.session_leases;
create policy session_leases_user_select on catalog.session_leases
  for select to catalog_user using (
    exists (select 1 from catalog.sessions s where s.id = session_id
            and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))));

drop policy if exists session_leases_user_insert on catalog.session_leases;
create policy session_leases_user_insert on catalog.session_leases
  for insert to catalog_user with check (
    exists (select 1 from catalog.sessions s where s.id = session_id
            and s.show_id in (select catalog.accessible_shows(catalog.app_user_id())))
    and holder_user_id = catalog.app_user_id());

drop policy if exists session_leases_user_update on catalog.session_leases;
create policy session_leases_user_update on catalog.session_leases
  for update to catalog_user
  using (
    exists (select 1 from catalog.sessions s where s.id = session_id
            and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))))
  with check (
    exists (select 1 from catalog.sessions s where s.id = session_id
            and s.show_id in (select catalog.accessible_shows(catalog.app_user_id())))
    and holder_user_id = catalog.app_user_id());

drop policy if exists session_leases_user_delete on catalog.session_leases;
create policy session_leases_user_delete on catalog.session_leases
  for delete to catalog_user using (
    exists (select 1 from catalog.sessions s where s.id = session_id
            and s.show_id in (select catalog.accessible_shows(catalog.app_user_id())))
    and holder_user_id = catalog.app_user_id());
