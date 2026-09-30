# Tasks

The first commit on `supabase-1.1-infisical` is `openspec/changes/infisical-secrets/` only, staged
by path (AGENTS.md rule 6). The PR targets `supabase-migration`, not `main`.

**Tests.** The regression tests are committed:
- `docker/scripts/test_check_envs.sh` (shell, the static check);
- `docker/scripts/compose-run.test.mjs` (`node --test`, part of `npm test`, so CI runs it).

They don't count toward the size budget. The Node tests use a local HTTPS stand-in for Infisical
(throwaway CA) and a stub `docker` on `PATH` that records argv, env and stdin. Test hooks are
honored only with `AUTOLOGGER_TEST=1`. Each task names the case that is written first and seen
failing.

**Owner tasks.** Tasks marked **(owner)** need credentials or values. The owner runs them, for
example with `! make dev-up`, so the output lands in the session. Every owner command is
written to print names or exit codes only. The agent records that output and never sees a value.

## 1. Owner prerequisites

- [ ] 1.1 **(owner)** Confirm Node ≥22.12 is on `PATH` for `make` on this host and on the deploy
  host. Put `~/infisical/infisical-root-ca.crt` (or a copy of it) where `INFISICAL_CA_FILE` will
  point. Check: `node --version` on each host.
  (The Infisical CLI installed earlier is no longer needed by this design.)
- [ ] 1.2 **(owner)** Create the Infisical environments `dev`, `stage` and `prod`, and one
  universal-auth machine identity per environment, set up as in design D6:
  - read-only on its own environment;
  - access-token TTL 15 minutes, maximum TTL 1 hour;
  - Trusted IPs on the client secret and on the token.

  Check that the dev identity can't read prod. Once task 3.2 exists:
  1. On this host, which holds no prod credentials, temporarily copy `.env.infisical.dev` to
     `.env.infisical.prod` at the repo root (mode 600). The test hooks are not used, because H10
     refuses them for prod.
  2. Run `make prod-check`.
  3. It must fail at the fetch with a `403` status and message, and print no values. Paste only
     that line, then delete the copy.
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
- [ ] 3.2 Add `docker/scripts/compose-run.mjs` (design D1 and H1 to H12: Node, `node:` modules
  only). Delete the draft `compose-run.sh` and `test_compose_run.sh`. Add
  `node --test docker/scripts/compose-run.test.mjs` to the root `npm test`. Replace
  `compose-run.sh` with `compose-run.mjs` in the committed comments and sentinel
  (`docker/secrets-env.yaml`, `compose.yaml`, `docker/compose.dev.yaml`,
  `docker/compose.stage.yaml`). Write these `compose-run.test.mjs` cases first. They run against
  a local HTTPS stand-in bound to `127.0.0.1`, with a CA and certificate generated by `openssl`
  into a temp dir, and a stub `docker` on `PATH`:

  | Case | Expected |
  | --- | --- |
  | No credentials file | Non-zero; names `docker/infisical-credentials.example` |
  | `http://` domain | Non-zero; the stand-in gets no request |
  | Credentials file with mode 644 | Non-zero; names the mode |
  | A missing key, or a missing CA file | Non-zero; names the key |
  | The stand-in's certificate is not signed by `INFISICAL_CA_FILE` | Message says to trust the Infisical CA; no mention of `http` or disabling verification |
  | Login returns 401, or JSON without a string `accessToken` | Non-zero; prints only the status and message; no fetch |
  | Secrets contain `LD_PRELOAD` or `DOCKER_HOST` | Non-zero; prints the name, not the value; no `docker` call |
  | Secrets contain a non-string value, a duplicate key, a NUL, an invalid identifier (only counted), `[]`, or no `secrets` array | Non-zero; nothing spawned |
  | Fetch query | Has `expandSecretReferences=false`, `includeImports=false`, the `projectId` and `environment` |
  | Success | The stand-in saw the client secret only in the login body; the token only in `Authorization`; stub docker's argv has no secret or token; the env the wrapper spawns with is exactly `PATH`, `HOME`, `TERM`, `AUTOLOGGER_STACK` and the validated keys (the stub also sees `sh`'s `PWD` and stage's placeholders) (no ambient `API_TOKEN` set by the test, no `INFISICAL_*`, no `LD_*`); a value with a quote, `$`, a backtick and a newline arrives intact |
  | Multi-step call | Exactly one login and one fetch; the four `compose restart` calls run in order |
  | `compose exec` step | The stub docker reads the test's stdin (inherited) |
  | H1: `NODE_OPTIONS`, `NODE_DEBUG`, `NODE_TLS_REJECT_UNAUTHORIZED`, `HTTPS_PROXY` present in the wrapper's env | Refused at start-up, before any request |
  | H1: Node below 22.12 (version check with an injected version string) | Refused, naming the fix |
  | H2: stand-in cert signed by another CA while `NODE_TLS_REJECT_UNAUTHORIZED=0` is set (the start-up check bypassed in the test) | TLS error: explicit `rejectUnauthorized: true` wins |
  | H2: domain with a path, query, fragment or userinfo | Refused before any request |
  | H3: 302 or 500 response; body over 1 MiB; server that never answers | Refused (status, size, timeout), with no parse attempted on non-200 |
  | H4: truncated secrets body containing a sentinel value | Fixed message; the sentinel is absent from stdout and stderr |
  | H4: error `message` with escape sequences, or a 422 issue array | Control characters stripped and cut to 200; only `path`/`code` printed |
  | H5: a secret with `secretValueHidden: true` | Refused, naming the key; the query has `viewSecretValue=true` |
  | H6: keys `__proto__` and `constructor` | Refused as not allowed; nothing polluted |
  | H7: credentials file as a symlink, group-writable, or owned by another user; CA file that is a FIFO or over 64 KiB | Refused before reading |
  | H8: `reset` for `prod`; a failing guard before `compose down -v` | Refused; the compose step never runs |
  | H9: SIGTERM to the wrapper while a stub child runs | The child receives SIGTERM, and the wrapper exits with its status |
  | H10: hooks without `AUTOLOGGER_TEST=1`, a relative hook path, or hooks with `prod` | Ignored or refused; banner when active |
  | H11: a step word with a quote, `$` or `;` | Refused |
  | `resolved` / `urls` / `prod-tags` / `reset` | The same outcomes as the shell guards they replace: a wrong project name, a non-loopback port, 8080, or dev 80/443 is refused; `API_TAG=latest` is refused; `reset` without `CONFIRM=yes` is refused before any request |

- [ ] 3.3 Mark `envfile`, `urls`, `reset` and `prod-tags` in `make-guards.sh` as superseded by the
  wrapper, with a header note; they are left in place, to be deleted by `node-stack-tooling`
  (design Risks: size). Update the `compose-env.sh` header comment: ambient overrides no longer
  apply, and the wrapper is the only caller besides `check-envs.sh`. Check:
  - `grep -n 'make-guards.sh \(envfile\|urls\|reset\|prod-tags\)' Makefile` returns nothing;
  - `make check` still passes.
- [ ] 3.4 Rewrite the Makefile targets as single `node docker/scripts/compose-run.mjs` calls, and
  add `prod-check`.
  Each call is `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" TERM="$TERM" … node …`
  (H1). `dev-reset` and `stage-reset` pass `CONFIRM` through. Check:
  - `make help` lists every target, including `prod-check`;
  - `grep -n 'env_file\|\.env\.dev\|\.env\.stage\|compose_\(dev\|stage\|prod\) \.env' Makefile docker/scripts/make-guards.sh`
    returns nothing;
  - `make -n dev-restart` shows a single `compose-run.mjs` call with the four restart steps.
- [ ] 3.5 Add `docker/infisical-credentials.example`. Check:
  - `git check-ignore .env .env.dev .env.stage .env.infisical.dev .env.infisical.prod` lists all
    five;
  - `git check-ignore docker/infisical-credentials.example` lists nothing.
- [ ] 3.6 Owner-approved scope addition (2026-09-30): `.pre-commit-config.yaml` runs
  `check-yaml --unsafe` for the compose files only (a second entry with `files:`), and plain
  `check-yaml` excludes them. So committing `docker/compose.stage.yaml` (`!override`) works, and
  every other YAML file keeps duplicate-key detection. Check: a commit touching
  `docker/compose.stage.yaml` passes, and `pre-commit run check-yaml --files` on a scratch
  duplicate-key file outside the compose set fails.

## 4. Docs

- [ ] 4.1 In the README container sections, the cutover/rollback runbook and the dev/stage
  sections: replace env-file setup and hand-typed `docker compose` steps with `make` targets or
  `compose-run.mjs`, and link to `docs/infisical-secrets.md`. Check:
  `grep -n 'cp docker/\.env\|env_file\|docker compose up -d api\|docker compose pull' README.md`
  returns only lines that go through `compose-run.mjs`, plus migration notes.
- [ ] 4.2 Add `docs/infisical-secrets.md`. It covers:
  - Node ≥22.12, and the CA file (required, because Node doesn't use the system store);
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

  Also update ADR 0021's slice list to record the 1.1 to 1.4 split and the follow-up change
  `node-stack-tooling`, which ports `check-envs.sh`, `compose-env.sh` and `make-guards.sh`,
  amends the "Static invariant check" tooling clause, and moves `test_check_envs.sh` into
  `node --test`. Check: `grep -n -i infisical
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

- **Before cutover:** fill the Infisical `prod` environment, confirm Node ≥22.12, and put
  `.env.infisical.prod` on the deploy host, add the deploy host to the prod identity's Trusted
  IPs, and run `make prod-check` there.
- **After this reaches `main` at cutover,** and only after a verified Infisical backup and a
  restore test: delete `.env.dev`, `.env.stage` and prod's `.env`, and remove the
  `docker/.env*.example` templates in a tier 0 commit.
- Push the branch and open the PR into `supabase-migration` when asked.
