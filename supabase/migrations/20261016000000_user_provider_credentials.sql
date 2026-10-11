-- Per-user provider credentials (OpenSpec change `byo-ai-providers`, design D1).
--
-- - `catalog.user_provider_credentials`: one row per user and kind (`llm`, `stt`). The API key is
--   stored only as AES-256-GCM parts (`key_nonce`, `key_ciphertext`, `key_tag`) under
--   `key_version`; the server encrypts and decrypts, and only `key_last4` is ever shown back.
--   `base_origin` is the normalized origin of `base_url` (null exactly when `base_url` is null); it
--   is part of the ciphertext's additional data, so a key never decrypts for another host (design
--   D2). `test_window_start_ms` / `test_count` are the connection-test window, updated atomically
--   by the server (Clock milliseconds, never the database's `now()`; design D1 `takeTestSlot`).
--   Deleting the user deletes their credentials.
-- - `catalog.provider_key_check`: a single row (`id` = 1) holding a keyed digest that ties the
--   stored keys to the deployment's `PROVIDER_KEYS_SECRET`; the server refuses to boot with a
--   secret that does not match it (design D2). It is never the secret itself.
-- - Row-level security: both tables are system-only, like `kv` and the Companion tables. Each has
--   the allow-all `<table>_system_all` policy for `catalog_system` and no `catalog_user` policy,
--   and `catalog_user`'s privileges are revoked, so a user binding gets 42501 before any policy.
--   One system store serves every statement, with the caller's user id in each (design D1).
-- - Runs as `postgres`, so the catalog's default privileges grant `catalog_user` and
--   `catalog_system` all four privileges; the revokes below take `catalog_user`'s away. `anon`,
--   `authenticated` and `public` get none, as with every catalog table.
-- - Rollback (a documented step, not a migration file), after reverting the code:
--   `drop table catalog.provider_key_check; drop table catalog.user_provider_credentials;`
--   Stored keys are then lost and users re-enter them.

create table catalog.user_provider_credentials (
  user_id              text collate "C" not null references catalog.users (id) on delete cascade,
  kind                 text collate "C" not null
                         constraint user_provider_credentials_kind_check check (kind in ('llm', 'stt')),
  provider             text collate "C" not null
                         constraint user_provider_credentials_provider_check
                         check (char_length(provider) between 1 and 64),
  base_url             text collate "C"
                         constraint user_provider_credentials_base_url_check
                         check (char_length(base_url) <= 2048),
  base_origin          text collate "C",
  model                text collate "C" not null
                         constraint user_provider_credentials_model_check
                         check (char_length(model) between 1 and 200),
  key_nonce            bytea not null,
  key_ciphertext       bytea not null,
  key_tag              bytea not null,
  key_version          smallint not null,
  key_last4            text collate "C" not null
                         constraint user_provider_credentials_key_last4_check
                         check (char_length(key_last4) between 1 and 4),
  test_window_start_ms bigint,
  test_count           smallint not null default 0,
  created_at_utc       text collate "C" not null,
  updated_at_utc       text collate "C" not null,
  primary key (user_id, kind),
  constraint user_provider_credentials_origin_check
    check ((base_url is null) = (base_origin is null))
);

create table catalog.provider_key_check (
  id             smallint primary key constraint provider_key_check_id_check check (id = 1),
  check_value    text collate "C" not null,
  created_at_utc text collate "C" not null
);

alter table catalog.user_provider_credentials enable row level security;
alter table catalog.provider_key_check enable row level security;

drop policy if exists user_provider_credentials_system_all on catalog.user_provider_credentials;
create policy user_provider_credentials_system_all on catalog.user_provider_credentials
  for all to catalog_system using (true) with check (true);

drop policy if exists provider_key_check_system_all on catalog.provider_key_check;
create policy provider_key_check_system_all on catalog.provider_key_check
  for all to catalog_system using (true) with check (true);

revoke all on catalog.user_provider_credentials from catalog_user;
revoke all on catalog.provider_key_check from catalog_user;
