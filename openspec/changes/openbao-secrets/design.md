# Design

## Context

- **Today (infisical-secrets, archived 2026-09-30).** Every compose target runs
  `docker/scripts/compose-run.mjs ENV STEP...` under `env -i`. It reads `.env.infisical.<env>`,
  logs in with Infisical universal auth, fetches `/api/v4/secrets`, validates every name and
  value against `docker/secrets-env.yaml` plus per-env compose keys, and runs the guards and
  compose with a child environment built from scratch and `--env-file /dev/null`.
  `docker/scripts/supabase-keys.mjs` creates missing Supabase keys with a writer identity.
- **Where the stacks are going.** One LXD VM per environment on `lxdbr0` (`10.88.0.0/24`):
  OpenBao `10.88.0.10`, stage `10.88.0.20`, dev `10.88.0.21`. The host and LAN reach OpenBao at
  `https://192.168.0.100:8200` through an LXD proxy device. `~/spark-infra` (Ansible) installs and
  configures OpenBao (raft, static-key auto-unseal, internal PKI), seeds KV, creates AppRoles,
  and renders `.env.openbao.<env>` on each VM.
- **OpenBao's API is Vault's.** AppRole login is `POST /v1/auth/approle/login`; the token is
  `auth.client_token`; requests carry `X-Vault-Token`; KV v2 reads are
  `GET /v1/<mount>/data/<path>` returning `data.data` and `data.metadata`; errors are
  `{"errors": [string...]}`; `POST /v1/auth/token/revoke-self` answers `204`.
- **KV v2 deletion.** `bao kv delete` soft-deletes the current version: a read then answers `404`
  with `data.data: null` and `data.metadata` still present, with a non-empty `deletion_time`
  (the field name is `deletion_time`). `bao kv destroy` sets `destroyed: true`. The older versions
  keep their keys: a deleted version can be restored with `bao kv undelete` or `bao kv rollback`,
  a destroyed one only by `bao kv rollback` to an older version. With `delete_version_after` set
  on the mount or path, a live version carries a *future* `deletion_time` and reads `200`.
- **Scope cut (owner, 2026-10-03, after the panel).** The database secrets engine, its port and
  dynamic psql credentials were cut to a follow-up change. `db`'s networks, the 16 static
  invariants and `make dev-psql` stay as they are on `supabase-migration`.

## Goals / Non-Goals

**Goals:**
- **One source for secrets,** OpenBao KV v2, one path per stack, read by that stack's AppRole only.
- **Same guarantees as today.** Every `infisical-secrets` hardening rule (H1-H12) holds with the
  provider swapped. No secret on argv, on disk, in output, or in a child process.
- **A stolen credentials file is worth little.** Secret ids are CIDR-bound to the VM; tokens are
  revoked after one read.
- **Relocatable.** Moving OpenBao means editing the credentials files only.

**Non-Goals:** as listed in proposal.md. In particular, dynamic Postgres credentials and any
database-engine port are deferred to a follow-up change that adds Postgres TLS (verify-full,
internal CA), no host route for `db`, dev/stage only, and no `database/creds` on stack AppRoles.

## Decisions

### D1. The wrapper talks to OpenBao (`compose-run.mjs`)

Steps, all in one Node process:

1. **Read `.env.openbao.<env>`** as plain `KEY=value` lines (never sourced or printed). Keys:
   `BAO_ADDR`, `BAO_CACERT`, `BAO_ROLE_ID`, `BAO_SECRET_ID`, `BAO_KV_PATH`. Refuse, before any
   request, when:
   - a key is missing or empty;
   - `BAO_ADDR` is not a bare `https://host[:port]` origin (no path, query, fragment or user);
   - `BAO_CACERT` names no file, a symlink, a group- or other-writable file, or a file over 64 KiB;
   - `BAO_KV_PATH` has fewer than two `/`-separated segments, any segment outside
     `[A-Za-z0-9_-]+` (so no `..`, no empty segment, no URL syntax), or a last segment that is not
     `ENV`. The first segment is the KV v2 mount;
   - the file is a symlink, not owned by the user, or readable by group or others.
2. **Log in.** `POST {BAO_ADDR}/v1/auth/approle/login` with `{"role_id", "secret_id"}`. The
   response must be JSON with a non-empty string `auth.client_token`.
3. **Read.** `GET {BAO_ADDR}/v1/<mount>/data/<rest>` with `X-Vault-Token`. The response must have
   an object `data.data`. A gone current version is refused: a `404` whose body carries
   `data.metadata`, or a `200` whose `metadata.destroyed` is true or whose `metadata.deletion_time` is non-empty and at or before now (a value that does not parse counts as passed, failing closed). A future `deletion_time` is a live version: KV v2 sets one when `delete_version_after` is configured. The message names `bao kv undelete` or `bao kv rollback`
   for a deleted version and only `bao kv rollback` for a destroyed one. `data.data` null and an
   empty object are refused too.
4. **Revoke.** `POST /v1/auth/token/revoke-self` with the same token, in a `finally` after step 3,
   so it runs whether the read succeeded or not. `204` is success. Any failure prints a warning
   naming the status only; the token still expires at the role's `token_ttl`.
5. **Validate, all or nothing.** Each entry of `data.data`: the key must match
   `/^[A-Za-z_][A-Za-z0-9_]*$/` and be in the allowed set (D3); the value must be a string with no
   NUL and, where the key has one, match its format. Reasons: `not-a-string`, `invalid-name`,
   `not-allowed`, `NUL`, `bad-format`. Infisical's `hidden-value` and `duplicate` reasons go:
   KV has no hidden values, and `JSON.parse` keeps one value per key.
6. **Build the child environment and run the steps** exactly as `infisical-secrets` D1 steps 5-7.
   The token, role id and secret id never enter it.

### D2. Hardening rules carried over

H1-H12 of `infisical-secrets` stay, with these provider changes:
- **H2.** `BAO_ADDR` is parsed with `new URL` and must be a bare `https:` origin.
  `rejectUnauthorized: true` and `ca` from `BAO_CACERT` only.
- **H3.** Status must be exactly `200`, except the revoke, which accepts `204` with an empty body.
  Same timeouts, 1 MiB cap and no compression.
- **H4.** On an OpenBao error, only the status is printed, plus the `errors` strings, joined,
  stripped of control characters and cut to 200 characters. A TLS error says to trust the
  OpenBao CA (`BAO_CACERT`), never to disable verification.
- **H5 (replaced).** Every value must be a string; KV v2 allows any JSON, so numbers, booleans,
  objects and null are refused as `not-a-string`.
- **H6.** The `data.data` object is walked with `Object.entries`, so `__proto__` and
  `constructor` keys are seen and refused by the allowlist `Set`.
- **H7.** As before, for `.env.openbao.<env>` and `BAO_CACERT`.
- **H10.** Test hooks unchanged (`AUTOLOGGER_TEST=1`, absolute `AUTOLOGGER_TEST_PATH` and
  `AUTOLOGGER_TEST_CRED_DIR`, refused for prod).
- **H8, H9, H11, H12** are unchanged.

Tests stay in `docker/scripts/compose-run.test.mjs`: the local HTTPS stand-in now answers the
AppRole login, KV read and revoke routes, and records every request, so tests assert the
`X-Vault-Token` header, the revoke, and that no request follows a refusal.

### D3. Allowed names

The allowlist keys from `docker/secrets-env.yaml`, plus per-env compose keys:

| Environment | Compose keys |
| --- | --- |
| dev | `DEV_PORT`, `DEV_COMPANION_PORT`, Supabase keys |
| stage | `STAGE_PORT`, Supabase keys |
| prod | `ROUTER_PORT`, `WEB_TAG`, `API_TAG`, `PUBLIC_BASE_URL`, Supabase keys |

Unchanged from `infisical-secrets` and the Supabase slices.

### D4. Generator (`supabase-keys.mjs`)

- Usage `supabase-keys.mjs ENV [--writer FILE]`. The admin token comes from `FILE` (same H7 checks;
  a `BAO_TOKEN=` line or one raw token line, so `~/.vault-token` works), else from `BAO_TOKEN`.
  Neither: refuse before any request.
- `BAO_ADDR`, `BAO_CACERT` and `BAO_KV_PATH` come from `.env.openbao.<env>`; the AppRole keys are
  not required.
- Read `GET /v1/<mount>/data/<path>`. KV v2 has no names-only listing, so the values arrive; the
  generator keeps only `Object.keys(data.data)` and `data.metadata.version`, and drops the rest.
  A `404` with no `data.metadata` means the path doesn't exist yet (version 0).
- **Deleted or destroyed current version: refuse.** If the read is a `404` that still carries
  `data.metadata` (in particular `metadata.version`), or any read whose `metadata.destroyed` is
  true or whose `metadata.deletion_time` is non-empty and at or before now (unparseable counts as
  passed), the generator exits non-zero before any write. It tells the operator to run
  `bao kv undelete` or `bao kv rollback` first (only `bao kv rollback` for a destroyed version).
  Treating that path as empty would write a fresh set of every database and JWT secret over the
  old ones (panel finding 6). The check uses KV v2's real field name, `deletion_time`, and the
  same rule as D1 step 3 (`deletedState` in `compose-run.mjs`): a future `deletion_time`
  (`delete_version_after`) is a live version and is written normally.
- Write once:
  - path exists: `PATCH /v1/<mount>/data/<path>`, `Content-Type: application/merge-patch+json`,
    body `{"options": {"cas": <version>}, "data": {missing keys}}`;
  - path missing: `POST /v1/<mount>/data/<path>`, body `{"options": {"cas": 0}, "data": {...}}`.

  A concurrent writer bumps the version, so the check-and-set fails and nothing is written. That
  keeps "all or nothing, never overwrite" from `supabase-db` D5. No retry.
- The trio rule, formats, and names-only output are unchanged.

### D5. Cutover, rollback and break-glass

- **Cutover order.** `~/spark-infra` exports Infisical into `kv/autologger/<env>` and diffs key
  names, creates the AppRoles, renders `.env.openbao.<env>`. Then `make dev-check` and a dev
  restart on the host against `https://192.168.0.100:8200`, before the VM migration.
- **Rollback** is reverting the change and restoring the `.env.infisical.<env>` files; Infisical
  stays running through the soak.
- **Break-glass.** Running containers are unaffected by an OpenBao outage. Static-key auto-unseal
  means a restart needs no human. Data loss: `bao operator raft snapshot restore`. Unrecoverable:
  rebuild with Ansible and re-seed KV from the owner's offline export. Stopping a stack:
  `docker stop`. No temporary `.env` files.

## Assumptions

| # | Assumption | How it is tested | Observed |
| --- | --- | --- | --- |
| A1 | OpenBao's KV v2 `PATCH` honours `options.cas` and refuses a stale version. | To verify at task 7.2: two `PATCH` calls with the same `cas` against the dev path | not yet observed |
| A2 | `revoke-self` answers `204` with an empty body. | To verify at task 7.2 against the real OpenBao (the unit test asserts the wrapper's handling of `204`) | not yet observed |
| A3 | A read of a soft-deleted current version answers `404` with `data.metadata.deletion_time` set and `data.metadata.version` present. | Panel run against a dev OpenBao server (finding 6: DELETE then re-run). To re-verify at task 7.2: `bao kv delete` on a scratch path, then `curl` the data path and list the metadata field names only | panel: 404 with metadata; field is `deletion_time` |
