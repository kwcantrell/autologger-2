## ADDED Requirements

### Requirement: Provider credentials are stored in the catalog
The migration `20261016000000_user_provider_credentials.sql` SHALL create
`catalog.user_provider_credentials`. The recorded schema expectation of "The catalog schema lives
in Postgres schema `catalog`" SHALL gain it in the same change. Every text column SHALL be `text`
with `COLLATE "C"`.

**Columns:**
- `user_id`, non-null, referencing `catalog.users (id)` `on delete cascade`;
- `kind`, non-null, checked to `llm` or `stt`;
- the primary key `(user_id, kind)`;
- `provider`, non-null, checked to 1 to 64 characters;
- `base_url`, nullable, checked to at most 2048 characters;
- `base_origin`, nullable, the normalized origin of `base_url`, checked to be null exactly when
  `base_url` is null;
- `model`, non-null, checked to 1 to 200 characters;
- `key_nonce`, `key_ciphertext` and `key_tag`, non-null `bytea`;
- `key_version`, a non-null `smallint`;
- `key_last4`, non-null, checked to 1 to 4 characters;
- `created_at_utc` and `updated_at_utc`, non-null ISO-8601 text.

The API key in plaintext SHALL NOT be stored in any column.

The migration `20261017000000_provider_test_windows.sql` SHALL drop the two connection-test
window columns the first migration added to `user_provider_credentials`, and SHALL create
`catalog.provider_test_windows`, one row per user, so deleting a credential does not reset the
window:
- `user_id`, the primary key, referencing `catalog.users (id)` `on delete cascade`;
- `window_start_ms`, a non-null `bigint` of epoch milliseconds from the Clock port;
- `test_count`, a non-null `smallint`.

It gets the same access rules as the credentials table.

The first migration SHALL also create `catalog.provider_key_check`, which holds the master-key check
value (provider-credentials "Provider keys are encrypted at rest and write-only"):
- a single row, with `id` a `smallint` primary key checked to equal 1;
- `check_value`, non-null text;
- `created_at_utc`, non-null ISO-8601 text.

It is never the secret itself. It gets the same access rules as the credentials table.

**Access.** Row-level security SHALL be enabled on all three tables, and all three SHALL be system-only, like
`companion_devices`:
- `catalog_system` SHALL have a permissive policy allowing every command;
- no table SHALL have a `catalog_user` policy, and `catalog_user`'s privileges on each SHALL be
  revoked;
- `anon`, `authenticated` and `public` SHALL have no privileges on any of them.

**Rollback** drops the three tables after the code is reverted. Stored keys are then lost and users
re-enter them.

#### Scenario: Credentials are invisible to users
- **WHEN** a `catalog_user` binding selects from, inserts into or deletes from
  `user_provider_credentials`, `provider_key_check` or `provider_test_windows`
- **THEN** each is refused with `42501`

#### Scenario: One credential per user and kind
- **WHEN** `catalog_system` inserts a second row with an existing `(user_id, kind)`
- **THEN** the insert fails with a unique violation (`23505`)

#### Scenario: A deleted user takes their credentials
- **WHEN** a user with an `llm` and an `stt` credential is deleted
- **THEN** both rows are gone
