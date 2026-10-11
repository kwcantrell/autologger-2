-- The connection-test window moves to one row per user (OpenSpec change `byo-ai-providers`,
-- design D1, re-panel 2026-10-08).
--
-- - The window kept on `catalog.user_provider_credentials` was reset by deleting and re-saving the
--   credential, so the 5-tests-per-minute limit could be bypassed. `catalog.provider_test_windows`
--   holds one window per user across both kinds, kept when credentials are deleted; the server
--   updates it with one atomic upsert (`takeTestSlot`), with times from its Clock in epoch
--   milliseconds. Deleting the user deletes their window.
-- - The two window columns on `user_provider_credentials` are dropped.
-- - Row-level security: system-only, like the credentials table. The allow-all
--   `provider_test_windows_system_all` policy for `catalog_system`, no `catalog_user` policy, and
--   `catalog_user`'s privileges revoked. `anon`, `authenticated` and `public` get none.
-- - Rollback (a documented step, not a migration file), after reverting the code:
--   `drop table catalog.provider_test_windows;` and
--   `alter table catalog.user_provider_credentials add column test_window_start_ms bigint,
--    add column test_count smallint not null default 0;`

create table catalog.provider_test_windows (
  user_id         text collate "C" primary key references catalog.users (id) on delete cascade,
  window_start_ms bigint not null,
  test_count      smallint not null
);

alter table catalog.user_provider_credentials
  drop column test_window_start_ms,
  drop column test_count;

alter table catalog.provider_test_windows enable row level security;

drop policy if exists provider_test_windows_system_all on catalog.provider_test_windows;
create policy provider_test_windows_system_all on catalog.provider_test_windows
  for all to catalog_system using (true) with check (true);

revoke all on catalog.provider_test_windows from catalog_user;
