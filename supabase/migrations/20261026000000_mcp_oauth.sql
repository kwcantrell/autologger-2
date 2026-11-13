-- The OAuth server's storage for custom session dashboards (ADR 0035 decisions 5, 16 and 17;
-- design docs/design/custom-session-dashboards.md section 4.7; job J2).
--
-- - `catalog.mcp_clients`: dynamically registered public clients (`POST /oauth/register`). The
--   name is client-supplied text, 1-100 characters. `redirect_uris_json` is the validated array of
--   1-5 URIs. `registered_from` is the IPv4 address or IPv6 /64 the registration limit counted.
--   `last_authorized_at_utc` stays null until the client's first successful consent (J3), and the
--   sweeper deletes a client still unauthorized 24 h after it registered.
-- - `catalog.mcp_grants`: one user's consent to one client. `expires_at_utc` is the 90-day hard
--   cap from creation (decision 16): not null, and no token outlives it.
-- - `catalog.mcp_access_tokens` and `catalog.mcp_refresh_tokens`: only the hex sha256 of each
--   token is stored. `successor_sealed` holds the refresh grace window's sealed successor
--   (decision 17): set at rotation, cleared by the sweeper once the window has passed. J3 decides
--   how it is sealed; J2 only stores and clears it.
-- - `catalog.mcp_rate_windows`: fixed rate-limit windows shared by every process, keyed by bucket
--   and window start, in the shape of `provider_test_windows`.
-- - Times are ISO-8601 UTC text from the server's Clock (`*_utc`), except the rate windows' epoch
--   milliseconds, as in the other system tables.
-- - Row-level security: every table is system-only, like `companion_devices`. Each has the
--   allow-all `<table>_system_all` policy for `catalog_system` and no `catalog_user` policy, and
--   `catalog_user`'s privileges are revoked, so a user binding gets 42501 before any policy. The
--   server reads and writes them under the reviewed system reasons `mcp-oauth` (the OAuth routes)
--   and `mcp-sweep` (the cleanup).
-- - Runs as `postgres`, so the catalog's default privileges grant `catalog_user` and
--   `catalog_system` all four privileges; the revokes below take `catalog_user`'s away. `anon`,
--   `authenticated` and `public` get none, as with every catalog table.
-- - With `CUSTOM_DASHBOARDS_ENABLED` off nothing writes these tables, so they stay empty.
-- - Rollback (a documented step, not a migration file), after reverting the code:
--   `drop table catalog.mcp_rate_windows; drop table catalog.mcp_refresh_tokens;
--    drop table catalog.mcp_access_tokens; drop table catalog.mcp_grants;
--    drop table catalog.mcp_clients;`
--   Every connector then has to register and connect again.

create table catalog.mcp_clients (
  id                     text collate "C" primary key,              -- alc_...
  client_name            text collate "C" not null check (char_length(client_name) between 1 and 100),
  redirect_uris_json     text collate "C" not null,                 -- validated array, 1-5
  registered_from        text collate "C" not null,
  created_at_utc         text collate "C" not null,
  last_authorized_at_utc text collate "C"                           -- null until first consent
);
create index idx_mcp_clients_created on catalog.mcp_clients (created_at_utc);

create table catalog.mcp_grants (
  id               text collate "C" primary key,
  user_id          text collate "C" not null references catalog.users (id) on delete cascade,
  client_id        text collate "C" not null references catalog.mcp_clients (id) on delete cascade,
  scope            text collate "C" not null,
  resource         text collate "C" not null,
  created_at_utc   text collate "C" not null,
  expires_at_utc   text collate "C" not null,                       -- created + 90 days, the cap
  last_used_at_utc text collate "C",
  revoked_at_utc   text collate "C"
);
create index idx_mcp_grants_user on catalog.mcp_grants (user_id);
create index idx_mcp_grants_client on catalog.mcp_grants (client_id);

create table catalog.mcp_access_tokens (
  token_hash     text collate "C" primary key,                      -- hex sha256
  grant_id       text collate "C" not null references catalog.mcp_grants (id) on delete cascade,
  expires_at_utc text collate "C" not null
);
create index idx_mcp_access_tokens_grant on catalog.mcp_access_tokens (grant_id);

create table catalog.mcp_refresh_tokens (
  token_hash       text collate "C" primary key,                    -- hex sha256
  grant_id         text collate "C" not null references catalog.mcp_grants (id) on delete cascade,
  issued_at_utc    text collate "C" not null,
  expires_at_utc   text collate "C" not null,
  used_at_utc      text collate "C",
  successor_sealed text collate "C"                                 -- nonce, ciphertext and tag
);
create index idx_mcp_refresh_tokens_grant on catalog.mcp_refresh_tokens (grant_id);

create table catalog.mcp_rate_windows (
  bucket          text collate "C" not null,
  window_start_ms bigint not null,
  count           int not null,
  primary key (bucket, window_start_ms)
);

alter table catalog.mcp_clients enable row level security;
alter table catalog.mcp_grants enable row level security;
alter table catalog.mcp_access_tokens enable row level security;
alter table catalog.mcp_refresh_tokens enable row level security;
alter table catalog.mcp_rate_windows enable row level security;

drop policy if exists mcp_clients_system_all on catalog.mcp_clients;
create policy mcp_clients_system_all on catalog.mcp_clients
  for all to catalog_system using (true) with check (true);

drop policy if exists mcp_grants_system_all on catalog.mcp_grants;
create policy mcp_grants_system_all on catalog.mcp_grants
  for all to catalog_system using (true) with check (true);

drop policy if exists mcp_access_tokens_system_all on catalog.mcp_access_tokens;
create policy mcp_access_tokens_system_all on catalog.mcp_access_tokens
  for all to catalog_system using (true) with check (true);

drop policy if exists mcp_refresh_tokens_system_all on catalog.mcp_refresh_tokens;
create policy mcp_refresh_tokens_system_all on catalog.mcp_refresh_tokens
  for all to catalog_system using (true) with check (true);

drop policy if exists mcp_rate_windows_system_all on catalog.mcp_rate_windows;
create policy mcp_rate_windows_system_all on catalog.mcp_rate_windows
  for all to catalog_system using (true) with check (true);

revoke all on catalog.mcp_clients from catalog_user;
revoke all on catalog.mcp_grants from catalog_user;
revoke all on catalog.mcp_access_tokens from catalog_user;
revoke all on catalog.mcp_refresh_tokens from catalog_user;
revoke all on catalog.mcp_rate_windows from catalog_user;
