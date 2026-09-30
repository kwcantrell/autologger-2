# Tasks

The first commit on `supabase-1.1-infisical` is `openspec/changes/infisical-secrets/` only, staged
by path (AGENTS.md rule 6). The PR targets `supabase-migration`, not `main`.

**Tests.** These are shell scripts and compose files. The regression tests are new committed
scripts, `docker/scripts/test_compose_run.sh` and `docker/scripts/test_check_envs.sh`. They
match `test_globs`, so they don't count toward the size budget. They use:
- a stub `infisical` on `PATH` that records its argv and environment to a scratch file;
- an `AUTOLOGGER_TEST=1` hook that points the credentials file and the repo root at a scratch
  directory.

Each task names the test case that is written first and seen failing.

**Owner tasks.** Tasks marked **(owner)** need credentials or values. The owner runs them, for
example with `! make dev-up`, so the output lands in the session. Every owner command is
written to print names or exit codes only. The agent records that output and never sees a value.

## 1. Owner prerequisites

- [x] 1.1 **(owner)** Install the Infisical CLI (arm64) on this host. Check: `infisical --version`
  prints a version.
  Evidence: `command -v infisical; infisical --version` -> `/usr/bin/infisical`, `infisical version 0.43.138`
- [ ] 1.2 **(owner)** Create the Infisical environments `dev`, `stage` and `prod`, and one
  universal-auth machine identity per environment, set up as in design D6:
  - read-only on its own environment;
  - access-token TTL 15 minutes, maximum TTL 1 hour;
  - Trusted IPs on the client secret and on the token.

  Check that the dev identity can't read prod:
  `infisical export --env=prod --projectId=… >/dev/null 2>&1; echo "exit=$?"`, logged in as the
  dev identity. Paste only the `exit=` line. It must be non-zero.
- [ ] 1.3 **(owner)** List today's key names without values:
  `grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env.dev | sort`, then the same for `.env.stage`. Compare
  them with the allowed names in `docs/infisical-secrets.md` (written in 4.2). Record a decision
  for each name that isn't allowed: add it (a scope edit handled by the consistency read) or drop
  it. Check: the name lists and the decisions are pasted.

## 2. Static invariants first (`check-envs.sh`)

- [x] 2.1 Invariant 14: no `env_file` in the dev, stage or prod projects; prod plus the e2e
  overlay is exempt. Test first: a `test_check_envs.sh` case runs the check on the current files
  and expects a failure naming invariant 14 for dev `app` and prod `api`. A second case expects
  the prod plus e2e resolve not to be flagged.
  Evidence: before 3.1, `sh docker/scripts/check-envs.sh all` -> `FAIL [invariant 14] dev: a service has an env_file ...` (also stage, prod), prod+e2e not flagged; after 3.1, `sh docker/scripts/test_check_envs.sh` -> `ok   env_file on prod api is caught`, `ok   env_file on dev app is caught`, `ok   clean tree passes (prod + e2e overlay env_file exempt)`
- [x] 2.2 Invariant 15: the line-matched keys of `docker/secrets-env.yaml` equal the
  null-passthrough names of the resolved prod `api` and dev `app`, excluding each service's
  literal pins. It is read with `--no-interpolate`, and handles both the map form and the array
  form. Test first: a case adds a passthrough directly to a scratch copy of `compose.yaml` `api`
  and expects a failure naming invariant 15.
  Evidence: before 3.1 -> `FAIL [invariant 15] dev: docker/secrets-env.yaml is missing` (and prod); after, `test_check_envs.sh` -> `ok   passthrough added outside the allowlist is caught`, `ok   dev app without the allowlist is caught`
- [x] 2.3 Remove the `env_file` bookkeeping from invariant 6. Strip the allowlist keys and
  `AUTOLOGGER_STACK` from the check's environment and give them placeholders. Add
  `.env.infisical.*` to the never-read list. Check: `grep -n env_file docker/scripts/check-envs.sh`
  shows only invariant 14.
  Evidence: `grep -n env_file docker/scripts/check-envs.sh` -> only the header comment and invariant 14 (`check_no_env_file`, lines 150-154, 242, 332, 390-391); header now names `.env.infisical.*`; allowlist keys unset and `AUTOLOGGER_STACK=check` exported before resolving
## 3. Allowlist, compose files, wrapper, Makefile

- [x] 3.1 Add `docker/secrets-env.yaml` (design D2, plus the D4 `AUTOLOGGER_STACK` sentinel).
  In `compose.yaml` `api` and `docker/compose.dev.yaml` `app`, add `extends` and remove
  `env_file`. Remove the stage `env_file: !override`. Fix the comments and `:?` messages that name
  `.env` (for example `compose.yaml:4,73`, `compose.dev.yaml:5-10`, `compose.stage.yaml:7-10`).
  Check:
  - `make check` passes invariants 1 to 15 and the 2.x test cases pass;
  - a hand-typed `WEB_TAG=x API_TAG=x PUBLIC_BASE_URL=x docker compose -f compose.yaml --env-file /dev/null config -q`
    fails naming the Makefile.
  Evidence: `sh docker/scripts/check-envs.sh all` -> `check-envs: ok (all)`; `sh docker/scripts/test_check_envs.sh` -> `5 passed, 0 failed`; `WEB_TAG=x API_TAG=x PUBLIC_BASE_URL=x docker compose -f compose.yaml --env-file /dev/null config -q` -> `required variable AUTOLOGGER_STACK is missing a value: run compose through make (docker/scripts/compose-run.sh) ...` rc=1
- [ ] 3.2 Add `docker/scripts/compose-run.sh` (design D1). Write these `test_compose_run.sh` cases
  first, using the stub `infisical`:

  | Case | Expected |
  | --- | --- |
  | No credentials file | Non-zero; names `docker/infisical-credentials.example` |
  | `http://` domain | Non-zero; the stub is never called |
  | Credentials file with mode 644 | Non-zero; names the mode |
  | CLI missing from `PATH` | Non-zero; names the install docs |
  | Stub login fails with a TLS error | Message says to trust the CA, and does not mention `http` or skipping verification |
  | Stub injects `LD_PRELOAD` | Non-zero; prints `LD_PRELOAD`, not its value; no `docker` call |
  | Stub injects a name that is not a valid identifier | Only a count is printed |
  | Success | Recorded argv has no client secret or token; `run` got `INFISICAL_DOMAIN` and `--expand=false`; the child env has no `INFISICAL_*`, no `SSL_CERT_FILE`, and no ambient `API_TOKEN` exported by the test |
  | Multi-step call | Exactly one login |

- [ ] 3.3 Update `make-guards.sh`:
  - `envfile` becomes `resolved`, run inside the inner stage;
  - `urls` and `reset` resolve with `/dev/null` inside the inner stage;
  - `prod-tags` reads the environment.

  Update the `compose-env.sh` header comment: ambient overrides no longer apply. Test first, with
  the stub: `API_TAG=latest` fails `prod-tags`, and `urls` prints the Infisical-provided
  `DEV_PORT`.
- [ ] 3.4 Rewrite the Makefile targets as single `compose-run.sh` calls, and add `prod-check`.
  `dev-reset` and `stage-reset` read `CONFIRM` in the outer stage. Check:
  - `make help` lists every target, including `prod-check`;
  - `grep -n 'env_file\|\.env\.dev\|\.env\.stage\|compose_\(dev\|stage\|prod\) \.env' Makefile docker/scripts/make-guards.sh`
    returns nothing;
  - a test case runs `make dev-restart` with the stub and records one login and four
    `compose restart` calls, in order.
- [ ] 3.5 Add `docker/infisical-credentials.example`. Check:
  - `git check-ignore .env .env.dev .env.stage .env.infisical.dev .env.infisical.prod` lists all
    five;
  - `git check-ignore docker/infisical-credentials.example` lists nothing.

## 4. Docs

- [ ] 4.1 In the README container sections, the cutover/rollback runbook and the dev/stage
  sections: replace env-file setup and hand-typed `docker compose` steps with `make` targets or
  `compose-run.sh`, and link to `docs/infisical-secrets.md`. Check:
  `grep -n 'cp docker/\.env\|env_file\|docker compose up -d api\|docker compose pull' README.md`
  returns only lines that go through `compose-run.sh`, plus migration notes.
- [ ] 4.2 Add `docs/infisical-secrets.md`. It covers:
  - installing the CLI and trusting the CA;
  - the credentials file;
  - the allowed names per environment, and the `WEB_TAG`/`API_TAG` format;
  - "never reuse prod secrets";
  - identity hardening (D6);
  - ambient overrides no longer applying;
  - `prod-check`;
  - break-glass (D7).

  Check: `grep -c '^## ' docs/infisical-secrets.md` shows every section.
- [ ] 4.3 Update `docs/security.md` ASI03 with:
  - Infisical, one read-only identity per environment, short TTL and Trusted IPs;
  - the residuals: credentials readable with `Bash` `cat`, container env through `docker
    inspect`/`exec`, and `/proc/*/environ`. The Read deny rule is not the boundary.

  Also update ADR 0021's slice list to record the 1.1 to 1.4 split. Check: `grep -n -i infisical
  docs/security.md` shows the row, and `grep -n '1\.1' docs/decisions/0021-*.md` shows the split.

## 5. Verify

- [ ] 5.1 **(owner)** Fill the Infisical `dev` environment from `.env.dev` (plus `DEV_PORT` and
  `DEV_COMPANION_PORT`), put `.env.infisical.dev` in place (mode 600), then run `make dev-up`.
  Check, repeating the verification from the containerized-dev-env archive:
  - the app and Companion URLs load;
  - DeepGram transcript generation returns 200;
  - the AI chat answers;
  - `docker exec autologger-dev-app env | cut -d= -f1 | sort` shows only the allowlist, the
    pins, `AUTOLOGGER_STACK` and the image's own variables.
- [ ] 5.2 **(owner)** Fill the Infisical `stage` environment from `.env.stage`, then run
  `make stage-up`. Check:
  - Google sign-in round-trips on `http://localhost:8788`;
  - the scoped `API_TOKEN` gets 200 on `/api/companion/state` and 401 on `/api/sessions`.
- [ ] 5.3 Run `scripts/check-change.sh --stage pr --base supabase-migration` and record the gate
  list. Every gate passes except `tasks` until this is ticked, and `size` is at most 400.

## 6. Archive

- [ ] 6.1 Run the consistency read (tier 2) if any artifact changed after approval, then
  `/opsx:archive`. Check: `openspec validate --all --strict` and
  `openspec validate --archived --no-interactive` pass.

## Owner-owed after merge (no checkbox)

- **Before cutover:** fill the Infisical `prod` environment, install the CLI and put
  `.env.infisical.prod` on the deploy host, add the deploy host to the prod identity's Trusted
  IPs, and run `make prod-check` there.
- **After this reaches `main` at cutover,** and only after a verified Infisical backup and a
  restore test: delete `.env.dev`, `.env.stage` and prod's `.env`, and remove the
  `docker/.env*.example` templates in a tier 0 commit.
- Push the branch and open the PR into `supabase-migration` when asked.
