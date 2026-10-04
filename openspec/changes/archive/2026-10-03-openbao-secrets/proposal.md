# Secrets from OpenBao for the dev, stage and prod stacks

Tier: 2
Tier reason: replaces the secret source and the credentials of every stack, including prod's (secrets handling, production-critical).

Approved-by: Kalen 2026-10-03 (re-approved after panel and re-panel; database engine deferred)

## Why

The stacks are moving off the Spark host into one LXD VM per environment, built from a new
Ansible repo (`~/spark-infra`). The owner chose OpenBao to replace the self-hosted Infisical
(owner decision, 2026-10-03). The project is still small, so now is the cheap moment to switch.
OpenBao gives us, in one service:
- KV v2 secrets, read with one AppRole per environment;
- secret ids bound to each VM's IP, which Infisical's free plan refused (Trusted IPs);
- later, dynamic Postgres credentials (a follow-up change, see Non-goals);
- PKI and an SSH CA for the VMs (managed in `~/spark-infra`, not here).

This change is the provider swap only: AppRole login and a KV v2 read in the compose wrapper, the
KV writer in the Supabase key generator, the credentials file `.env.openbao.<env>`, and the docs,
specs and tests that name Infisical. ADR 0025 records the decision and supersedes ADR 0021's
Infisical clause.

Infisical's touchpoints in this repo are few: the compose wrapper, the Supabase key generator,
one template, the static check, the Makefile, compose comments and the docs.

## What Changes

- **Secret delivery (BREAKING for operators).** `docker/scripts/compose-run.mjs` swaps the
  Infisical client for OpenBao's HTTP API:
  - AppRole login, `POST /v1/auth/approle/login` with `{role_id, secret_id}`;
  - KV v2 read, `GET /v1/<mount>/data/<path>` with `X-Vault-Token`;
  - token revoke, `POST /v1/auth/token/revoke-self`, right after the read.

  Everything else stays: secrets in memory only, `--env-file /dev/null`, the CA-file pinning,
  the `docker/secrets-env.yaml` allowlist, the `AUTOLOGGER_STACK` sentinel, the clean child
  environment, and every hardening rule of `infisical-secrets` (H1-H12). There is no dual-provider
  switch: Infisical code paths are removed.
- **Per-host credentials.** `.env.openbao.<env>` (mode 600, untracked) replaces
  `.env.infisical.<env>`. It holds `BAO_ADDR`, `BAO_CACERT`, `BAO_ROLE_ID`, `BAO_SECRET_ID` and
  `BAO_KV_PATH`. The template `docker/infisical-credentials.example` becomes
  `docker/openbao-credentials.example`. `BAO_KV_PATH`'s last segment must be the environment name,
  checked before any request.
- **Generator.** `docker/scripts/supabase-keys.mjs ENV [--writer FILE]` writes the missing keys
  with one KV v2 `PATCH` (merge patch) guarded by check-and-set, using an admin token from `FILE`
  or `BAO_TOKEN`. It still only adds keys and never prints a value. When the path's current
  version is soft-deleted or destroyed (KV v2 `metadata.deletion_time` at or before now,
  `destroyed: true`, or a `404` that still carries `metadata.version`), it refuses and names
  `bao kv undelete` / `bao kv rollback` (only `rollback` when destroyed), so it never writes a
  fresh set of database and JWT secrets over a deleted one. A future `deletion_time`
  (`delete_version_after`) is a live version. The compose wrapper applies the same rule.
- **Unchanged:** the compose topology, the static check's 16 invariants (wording only), and
  `make dev-psql`, which still opens the in-container superuser psql through the compose wrapper.
- **Docs.** `docs/infisical-secrets.md` becomes `docs/openbao-secrets.md` (setup, credentials,
  KV layout, AppRoles, break-glass). README, `docs/supabase.md`, `docs/security.md` (ASI03), the
  restart rule, compose comments, `server/.env.example` and the Deepgram fixture script are
  updated. New ADR 0025 supersedes ADR 0021's "Secrets live in a shared Infisical instance".

## Decisions (owner, 2026-10-03)

- **OpenBao replaces Infisical.** Infisical is not migrated as a service: its secrets are exported
  into OpenBao by `~/spark-infra/bin/infisical-export`, then it is decommissioned after a soak.
- **One KV v2 mount `kv`, one path per stack:** `kv/autologger/{dev,stage,prod}`, with the same
  keys as the Infisical projects.
- **One AppRole per environment VM.** The policy is `read` on `kv/data/autologger/<env>` only.
  Secret ids are CIDR-bound to the VM's IP, live 90 days, and are rotated by Ansible.
- **The database-engine feature is cut to a follow-up change** (owner, 2026-10-03, after the
  panel). The app keeps its static `APP_DB_PASSWORD` from KV.
- **The work happens in a separate worktree** on branch `openbao-secrets`, cut from
  `supabase-migration`, so the owner's main checkout is untouched. The PR targets
  `supabase-migration`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-container-environments`: modified requirements: Makefile entry points (OpenBao login),
  Dev environment, Dev isolation, Stage, Dev Companion, Prod targets, Static invariant check
  (OpenBao wording), Supabase secret generator (KV writer, deleted-version refusal).
  "Secrets come from Infisical, one environment per stack" is replaced (removed, then added) by
  "Secrets come from OpenBao, one KV path per stack".
- `container-deployment`: the compose topology requirement's secrets clause names OpenBao. Host
  exposure and network segmentation are unchanged.
- `cursor-agent-adapters`: the restart rule says `make dev-restart` reads secrets from OpenBao.

## Non-goals

- Running, configuring, backing up or unsealing OpenBao, its PKI, SSH CA, policies, AppRoles or
  database connections. That is `~/spark-infra`.
- Moving the stacks into VMs, migrating volumes, Portainer or Dokploy.
- Dynamic Postgres credentials / database-engine port — deferred to a follow-up change that adds
  Postgres TLS (verify-full, internal CA), no host route for db, dev/stage only, and no
  database/creds on stack AppRoles.
- Rotating the app's runtime database password through OpenBao (static roles). Follow-up.
- Renaming the scenario titles that still say "Infisical" ("Unnamed Infisical secrets stay out of
  the container", "Posture cannot be flipped from Infisical"). OpenSpec 1.13.2 refuses a MODIFIED
  block that drops a current scenario name, so they are renamed in `openspec/specs/` right after
  archive (tasks.md "Owner-owed after merge"); their bodies already say OpenBao.
- Exporting the Infisical secrets or decommissioning Infisical (owner, with `~/spark-infra`).
- Porting `check-envs.sh`, `compose-env.sh` and `make-guards.sh` to Node (`node-stack-tooling`).
- A `stage-psql` or `prod-psql` target. Prod still refuses `compose run` and `exec`.
- Editing archived OpenSpec changes, or the bodies of existing ADRs (ADR 0025 is new).

## Impact

- **Files:**
  - `docker/scripts/compose-run.mjs`, `docker/scripts/supabase-keys.mjs` and their tests;
  - comments and messages only in `docker/scripts/compose-env.sh`, `check-envs.sh` and
    `make-guards.sh`;
  - `docker/openbao-credentials.example` (renamed from `docker/infisical-credentials.example`);
  - comments, help text and messages in `Makefile`, `compose.yaml`, `docker/compose.dev.yaml`,
    `docker/compose.stage.yaml`, `docker/supabase-db.yaml`, `docker/secrets-env.yaml`;
  - README, `docs/openbao-secrets.md` (renamed), `docs/supabase.md`, `docs/security.md`,
    `.cursor/rules/restart-server-yourself.mdc`, `server/.env.example`,
    `server/scripts/capture-deepgram-fixture.mjs`, `server/src/bootGuard.ts` messages;
  - the new `docs/decisions/0025-openbao-replaces-infisical.md`.
- **Operators:**
  - seed `kv/autologger/<env>` from Infisical, create the AppRoles, render `.env.openbao.<env>`
    (all through `~/spark-infra`);
  - until then, `make dev-*` and `make stage-*` fail with a message naming
    `docker/openbao-credentials.example`.
- **Availability:** starting or restarting a stack through `make` needs OpenBao reachable and
  unsealed. Running containers are unaffected.
- No HTTP/WS contract change. No app behaviour change.
