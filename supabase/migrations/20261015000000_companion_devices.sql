-- Companion devices and presence (ADR 0021 slice 9d, OpenSpec change `companion-devices`,
-- design D1).
--
-- - `catalog.companion_devices`: each user's Companion devices. A device's token is shown once and
--   only its hex sha256 is stored (`token_hash`, unique). The device acts as `user_id`; deleting
--   the user deletes their devices. `last_used_at_utc` is null until first use and renews the
--   90-day idle expiry (design D2).
-- - `catalog.companion_presence`: one row per browser tab (`client_id`), owned by the user who
--   posted it. `session_id` is null when the tab has no session open, and a deleted session sets it
--   null. `updated_at_ms` is epoch milliseconds from the server's Clock, never the database's
--   `now()`; freshness (15 s) and the 60 s sweep are the server's (design D4).
-- - Row-level security: both tables are system-only, like `kv`. Each has the allow-all
--   `<table>_system_all` policy for `catalog_system` and no `catalog_user` policy, and
--   `catalog_user`'s privileges are revoked, so a user binding gets 42501 before any policy. One
--   system store serves the device-token lookup and the management routes, with the caller's user id
--   in every statement (design D2, D5); presence is written by the server after its own checks.
-- - Runs as `postgres`, so the catalog's default privileges grant `catalog_user` and
--   `catalog_system` all four privileges; the revokes below take `catalog_user`'s away. `anon`,
--   `authenticated` and `public` get none, as with every catalog table.
-- - The deployment-wide `companion:last_command` kv entry is no longer read (the last command is
--   per device, `companion:last_command:<device id>`, design D3) and has no expiry, so it is
--   deleted here.
-- - Rollback (a documented step, not a migration file), after reverting the code:
--   `drop table catalog.companion_presence; drop table catalog.companion_devices;`
--   Device tokens are then lost; the old global kv entry is not restored (the reverted code
--   rewrites it on the next Companion command).

create table catalog.companion_devices (
  id               text collate "C" primary key,              -- uuid string
  user_id          text collate "C" not null references catalog.users (id) on delete cascade,
  name             text collate "C" not null check (char_length(name) between 1 and 80),
  token_hash       text collate "C" not null unique,          -- hex sha256 of the token
  created_at_utc   text collate "C" not null,
  last_used_at_utc text collate "C"
);
create index idx_companion_devices_user on catalog.companion_devices (user_id);

create table catalog.companion_presence (
  client_id     text collate "C" primary key check (char_length(client_id) between 1 and 256),
  user_id       text collate "C" not null references catalog.users (id) on delete cascade,
  session_id    text collate "C" references catalog.sessions (id) on delete set null,
  visible       boolean not null,
  is_playing    boolean not null,
  updated_at_ms bigint not null
);
create index idx_companion_presence_user on catalog.companion_presence (user_id, updated_at_ms);

alter table catalog.companion_devices enable row level security;
alter table catalog.companion_presence enable row level security;

drop policy if exists companion_devices_system_all on catalog.companion_devices;
create policy companion_devices_system_all on catalog.companion_devices
  for all to catalog_system using (true) with check (true);

drop policy if exists companion_presence_system_all on catalog.companion_presence;
create policy companion_presence_system_all on catalog.companion_presence
  for all to catalog_system using (true) with check (true);

revoke all on catalog.companion_devices from catalog_user;
revoke all on catalog.companion_presence from catalog_user;

delete from catalog.kv where key = 'companion:last_command';
