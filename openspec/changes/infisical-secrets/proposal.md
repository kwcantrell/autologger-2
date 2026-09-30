# Secrets from Infisical for the dev, stage and prod stacks

Tier: 2
Tier reason: changes how every stack receives its secrets, including prod's, and the prod start procedure (secrets handling, production-critical).

Approved-by: Kalen 2026-09-30

## Why

ADR 0021 (slice 1.1) moves the stacks' secrets into the owner's shared Infisical instance. Today
each stack reads a hand-kept env file (`.env.dev`, `.env.stage`, and prod's `.env`).

Doing this first means the Supabase secrets that the next slices add go straight into Infisical,
never into env files:
- the JWT secret;
- the anon and service-role keys;
- the Postgres password;
- the restic password.

## What Changes

- **Secret delivery (BREAKING for operators).**
  - Every Makefile target that touches a compose project goes through one wrapper,
    `docker/scripts/compose-run.sh`.
  - The wrapper logs in to Infisical once per target and fetches that environment (`dev`,
    `stage` or `prod`) into memory with `infisical export`. One jq program checks every name and
    value and writes the exports. Only then does the wrapper run the guards and compose, in a
    clean environment with `--env-file /dev/null`.
  - `env_file:` is removed from dev `app` and prod and stage `api`.
- **A single allowlist.**
  - A new `docker/secrets-env.yaml` lists every key an app container may receive, as null
    passthroughs. Dev `app` and prod `api` `extends` it. Posture pins stay literal and still win.
  - A secret added to Infisical for another service, such as Supabase's service-role key in
    slice 1.2, doesn't reach the app unless it is added there.
- **Hostile names are refused.** The wrapper refuses to run if Infisical injects any name outside
  that environment's allowed set (the allowlist plus a few compose-interpolation keys). This
  blocks names like `LD_PRELOAD`, `DOCKER_HOST` or `COMPOSE_PROJECT_NAME`, and it prints names
  only.
- **Per-host credentials.** Each host holds one untracked, mode-600 file per environment it runs,
  `.env.infisical.<env>`. It contains:
  - the machine identity's client id and secret;
  - the project id;
  - the `https://` Infisical URL;
  - optionally, a CA file.

  The Infisical host is configuration, not a repo constant, so moving Infisical later means
  editing these files only. The client secret and token never appear on a command line or on disk.
- **Hand-typed compose fails loudly.** It no longer starts `api` silently with no secrets.
- **New target: `make prod-check`.** A prod dry run the deploy host can run before cutover.
- **Static check.** `check-envs.sh` gains two invariants:
  - no `env_file` (the e2e overlay is exempt);
  - the allowlist file matches the resolved passthroughs.
- **Docs.**
  - README container sections switch to the Infisical invocation.
  - A new `docs/infisical-secrets.md` covers setup, the key list, identity hardening and
    break-glass.
  - `docs/security.md` ASI03 is updated.
  - ADR 0021 records the 1.1 to 1.4 split.

## Decisions (owner, 2026-09-30)

- **The Infisical instance already runs** in Docker at `https://192.168.0.100`, from
  `~/infisical`, with Caddy's internal CA. It stays there for the whole migration and may move
  afterwards.
- **Delivery is `infisical export` into memory,** not an agent that renders env files. The owner
  changed this from `infisical run` on 2026-09-30, after implementation showed `run` lets
  `LD_PRELOAD` act before any check.
- **Pre-commit `check-yaml` runs with `--unsafe`** (syntax only) for the compose files, so files
  with `!override` can be committed. Owner, 2026-09-30. This is a scope addition. The re-panel
  scoped it to compose files: every other YAML keeps duplicate-key detection, and the lifecycle
  `yaml` gate (ADR 0017) still enforces its rule.
- **One machine identity per environment.** A dev identity must not be able to read stage or prod.
- **Slice 1 is split four ways,** in the order 1.1 Infisical, 1.2 Supabase stack, 1.3 backups, 1.4
  retiring host dev. The order is the agent's recommendation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-container-environments`: modified requirements: Makefile entry points, Dev environment,
  Dev isolation, Stage, Prod targets (adds `prod-check`), Static invariant check (invariants 14
  and 15). "Env files are untracked and templated" is replaced (removed, then added under a new
  name) by "Secrets come from Infisical, one environment per stack". The replacement keeps the
  ignore rules for the old env files while they still exist.
- `container-deployment`: in the compose topology requirement, the secrets clause changes from
  "an env file that is not tracked" to "Infisical, delivered through the shared allowlist".

## Non-goals

- Supabase services, Postgres, backups, or any app code change. Those are slices 1.2 to 1.4 and
  later.
- Retiring `server/.env`, `server/.env.example`, or host `npm run dev`. That is slice 1.4.
- The `e2e:container` harness (`e2e/container/`). ADR 0021 sets it aside, and invariant 14 exempts
  it.
- The Claude login mounts: the dev credentials bind, and the stage and prod `/home/node` volumes.
- Running, upgrading, backing up or moving the Infisical instance itself (`~/infisical`).
- Entering any secret value or configuring identities. The owner does this.
- Deleting the old env files and `docker/.env*.example` templates. That is owner-owed after
  cutover.
- Deploying to prod. Prod targets still require `main`, so prod switches over at the ADR 0021
  cutover.

## Impact

- **Files:**
  - `Makefile`, `.pre-commit-config.yaml` (`check-yaml --unsafe`);
  - the new `docker/scripts/compose-run.sh`;
  - `docker/scripts/compose-env.sh`, `docker/scripts/make-guards.sh`,
    `docker/scripts/check-envs.sh`;
  - the new `docker/secrets-env.yaml`;
  - `compose.yaml`, `docker/compose.dev.yaml`, `docker/compose.stage.yaml`;
  - the new `docker/infisical-credentials.example`;
  - README, `docs/infisical-secrets.md`, `docs/security.md`, ADR 0021.
- **Size:** estimated at about 350 counted lines, which fits the 400-line budget. `docs/**`
  and `openspec/**` are excluded. The template deletions are deferred.
- **Operators:**
  - install the Infisical CLI on each host;
  - configure the identities (read-only, short TTL, Trusted IPs);
  - copy the env file values into Infisical;
  - put the credentials files in place;
  - until all of that is done, `make dev-*` and `make stage-*` fail with a message naming the
    fix.
- **Availability:** starting or restarting a stack through `make` needs Infisical reachable.
  Running containers are unaffected.
- **Behaviour:** ambient overrides such as `DEV_PORT=9000 make dev-up` stop working. Ports are set
  in Infisical.
- No HTTP/WS contract change, and no app code change.
