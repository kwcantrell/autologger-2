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
    `docker/scripts/compose-run.mjs`. It is plain Node with no npm packages.
  - The wrapper logs in to Infisical's HTTP API once per target, fetches that environment
    (`dev`, `stage` or `prod`) into memory, and checks every name and value. It then runs the
    guards and compose with an environment object built from only the validated keys, and passes
    `--env-file /dev/null`.
  - The secret-bearing guards (resolved config, prod tags, URLs, reset) move from
    `make-guards.sh` into the wrapper.
  - Tests run with `node --test`, as part of `npm test`, so CI runs them.
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
  - the CA file path, which is required because Node doesn't use the system trust store.

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
- **Delivery is a Node wrapper calling Infisical's HTTP API directly** (no CLI, no SDK), not an
  agent that renders env files. The owner decided this on 2026-09-30, after these steps:
  - `infisical run` let `LD_PRELOAD` act before any check (found in implementation);
  - shell `export`/`eval` had quoting bypasses (found in the re-panel);
  - the owner chose Node, and chose the direct API over `@infisical/sdk` because of its large
    dependency tree.
- **All the stack's shell tooling moves to Node** (owner, 2026-09-30). Because of the 400-line
  budget, this change converts only the wrapper and the secret-bearing guards. A follow-up change,
  `node-stack-tooling`, ports `check-envs.sh`, `compose-env.sh` and the rest of `make-guards.sh`.
- **Pre-commit `check-yaml` runs with `--unsafe`** (syntax only) for the compose files, so files
  with `!override` can be committed. Owner, 2026-09-30. This is a scope addition. The re-panel
  scoped it to compose files: every other YAML keeps duplicate-key detection, and the lifecycle
  `yaml` gate (ADR 0017) still enforces its rule.
- **One machine identity per environment.** A dev identity must not be able to read stage or prod.
- **Free-plan limits (found during setup, owner 2026-09-30):**
  - Infisical refuses custom project roles, so each environment is its own project
    (`autologger-dev`, `autologger-stage`, `autologger-prod`) with one `viewer` identity.
  - It also refuses Trusted IPs, so the network boundary is the Infisical proxy's LAN/Tailscale
    allowlist plus the 15-minute token lifetime.
  - The owner may revisit this, with Enterprise or a proxy IP rule.
- **The agent ran the dev and stage setup** (owner request, 2026-09-30). It used the owner's
  bootstrap identity (`~/.infisical-bootstrap`, organization access) to:
  - create the three projects and identities;
  - write the dev and stage client secrets straight into mode-600 `.env.infisical.<env>` files;
  - copy the allowed values from `.env.dev` and `.env.stage` into Infisical.

  No value, token or client secret was printed. No prod client secret was created on this host.
  The owner reduces or revokes the bootstrap identity afterwards.
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
- Entering prod secret values or creating the prod client secret. The owner does this on the
  deploy host. (The dev and stage setup moved into scope by the owner decision above.)
- Deleting the old env files and `docker/.env*.example` templates. That is owner-owed after
  cutover.
- Porting `check-envs.sh`, `compose-env.sh`, and the secret-free `make-guards.sh` guards to Node.
  That is the follow-up change `node-stack-tooling`.
- Deploying to prod. Prod targets still require `main`, so prod switches over at the ADR 0021
  cutover.

## Impact

- **Files:**
  - `Makefile`, `.pre-commit-config.yaml` (`check-yaml --unsafe`);
  - the new `docker/scripts/compose-run.mjs` and `docker/scripts/compose-run.test.mjs`, and the
    root `package.json` `test` script;
  - `docker/scripts/compose-env.sh`, `docker/scripts/make-guards.sh`,
    `docker/scripts/check-envs.sh`;
  - the new `docker/secrets-env.yaml`;
  - `compose.yaml`, `docker/compose.dev.yaml`, `docker/compose.stage.yaml`;
  - the new `docker/infisical-credentials.example`;
  - README, `docs/infisical-secrets.md`, `docs/security.md`, ADR 0021.
- **Size:** about 520 to 580 counted lines, over the 400 budget. The pieces can't land
  separately without breaking `make`, so the PR needs the owner's `size-override` label (decided
  at task 5.3). Trimmed where possible: superseded guards are left for `node-stack-tooling` to
  delete, and README points to `docs/infisical-secrets.md`.
- **Operators:**
  - have Node ≥22.12 on each host that runs `make`, including the deploy host;
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
