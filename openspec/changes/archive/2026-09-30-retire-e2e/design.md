# Design

## Context

- **Every suite runs a host server.** Every Playwright project except `container` reaches a host
  server started by `playwright.config.ts` `webServer` (`npm run start -w server`, ports
  8791/8792). The `container` project targets a router URL, and its runner
  (`e2e/container/run.sh`) also starts a host `npm run start` reference for differential
  parity.
- **CI never ran Playwright.** CI runs `npm ci` and `scripts/check-change.sh` (test, typecheck,
  audit). `typecheck` does compile `e2e` (`tsc --noEmit -p e2e`, A2).
- **Things that refer to e2e** outside `e2e/`:

  | File | Reference |
  | --- | --- |
  | root `package.json` | scripts `e2e*` and `teardown`, the `lint`/`lint:fix` globs, `typecheck`, `@playwright/test` |
  | `.gitignore` | lines 28-34 (e2e state, `test-results`, `playwright-report`) |
  | `.pre-commit-config.yaml:11` | the compose exclude naming `e2e/container/compose.e2e.yaml` |
  | `docker/scripts/compose-env.sh` | `AL_E2E_OVERLAY` and its comment |
  | `docker/scripts/check-envs.sh` | `compose_prod_e2e`, the prod+e2e loop, the invariant 14 exemption, the invariant 10 grep of the overlay, `E2E_*` unsets |
  | `server/src/routers/aiV2.ts:355-361` | the `AI_V2_SDK_EXECUTABLE_PATH` seam |
  | `server/src/test/fixtures/ai-v2-fake-agent.mjs` | the fake agent behind that seam |
  | `packages/ai-runtime/src/fixturesDir.ts:15` | comment |
  | `web/src/noAgentAuthoredMarkup.repo.test.ts:43` | `SCAN_DIR_NAMES` includes `e2e` |
  | `README.md` | e2e sections |
  | `AGENTS.md:96` | the `e2e:container` warning |
  | `scripts/teardown.mjs` | kills :8787, :8791 and :8792 |

  `.gitleaksignore:4` and `.dockerignore:31` (`**/e2e`) stay: harmless, and still correct if e2e
  returns.
- **Untracked e2e state on disk:** `e2e/.data` (9.5 MB), `e2e/.data-oauth`, `test-results/`
  (A3).

## Goals / Non-Goals

**Goals:**
- **No e2e residue.** Remove the e2e harness and every reference to it, leaving no dangling
  config or broken gate.
- **Keep router security tested.** The router's security behaviour stays covered by a
  repeatable test.

**Non-Goals:** as in proposal.md.

## Decisions

### D1. Deletion order (`git status` must stay clean of e2e state)

1. `rm -rf e2e/.data e2e/.data-oauth test-results playwright-report`. This is untracked,
   disposable test state.
2. `git rm -r e2e playwright.config.ts scripts/teardown.mjs
   server/src/test/fixtures/ai-v2-fake-agent.mjs`.
3. Remove the `.gitignore` e2e lines. `.playwright-mcp/` stays: it belongs to the interactive
   browser tool.

**Check:** `git status --porcelain` lists no `e2e/`, `test-results` or `playwright-report`
path.

### D2. Packages

- **Root `package.json`:**
  - remove the scripts `e2e`, `e2e:container`, `e2e:visual`, `e2e:visual:update` and
    `teardown`;
  - remove `&& tsc --noEmit -p e2e` from `typecheck`;
  - remove `e2e playwright.config.ts` from the `lint` and `lint:fix` globs.
- **`@playwright/test`:** removed with `npm uninstall @playwright/test --package-lock-only`.
  The host `node_modules` has drifted, and a full uninstall would also change 44 packages
  (A4). The lockfile diff is about 59 deletions, and the audit result is unchanged.

### D3. The AI v2 seam

- **`aiV2.ts`:** remove `pathToClaudeCodeExecutable: process.env.AI_V2_SDK_EXECUTABLE_PATH ||
  undefined` and its comment. `pathToClaudeCodeExecutable` stays unset, which matches every
  deployment today, since no container sets the variable (A5).
- **The fixture** is deleted.
- **Contract:** none affected. The HTTP/WS surface doesn't change, and the variable was never in
  the secrets allowlist.

### D4. Static check

- **`check-envs.sh`:**
  - prod is resolved once, with no overlay;
  - invariant 14 applies to every project;
  - invariant 10 stops grepping the overlay;
  - `E2E_ENV_FILE` and `E2E_IP_ALLOWLIST` leave the unset list.
- **`compose-env.sh`** drops `AL_E2E_OVERLAY`.
- **`test_check_envs.sh`:** rename the clean-tree case.
  - Test first: add a case where an `env_file` on prod `api` fails invariant 14. That case
    already exists, so the new check is that no exemption path remains:
    `grep -c compose_prod_e2e check-envs.sh` gives 0.

### D5. `docker/scripts/test_router.sh ENV`

Like `docker/supabase/test_gateway.sh`, it runs by hand against a running stack (default stage).
It reads `API_TOKEN` from the `api` container into a mode-600 curl header file and never prints
it. It prints case names and statuses only.

**Cases ported from `e2e/container-routing.spec.ts`:**

| Group | Cases |
| --- | --- |
| Shell served by web | `GET` `/`, `/sessions/abc`, `/teams` → 200, `text/html`, no `Set-Cookie` |
| Parity request list (from the spec scenario) | each request's status and the presence/values of `Set-Cookie`, `X-Powered-By`, `Location`, `Content-Type` (prefix) and `Cache-Control`, compared with a committed table in the script |
| Stray upgrade | raw TCP `GET /teams` and `/` with `Upgrade: websocket` → connection closed with 0 bytes |
| Stray upgrade, control | `Upgrade` on `/api/sessions/x/ws` gets a status line |
| Traversal with a valid `API_TOKEN` | `/api/companion/%2e%2e/sessions`, `/api/companion/.%2E/admin/users`, `POST /api/companion/%2e%2e/sessions` → the server's own 404 |
| Query cannot smuggle a dot-segment | `?x=/../` → 404 |
| `API_TOKEN` scope | `/api/companion/state` → 200; `/api/sessions` → 401 `Login required.`; `/api/admin/users` → the same status as anonymous; WS `/api/sessions/x/ws?role=companion` → the same response as unauthenticated |
| Topology | `docker exec <web> node -e fetch('http://api:8787')` fails; the router port on the host's non-loopback address is refused |

The expectation table holds the dispositions the e2e suite proved equal to the single-process
server. They are recorded from the current router at implementation, and the e2e suite's last
passing run is the reference.

**Not ported** (each needs a browser, a sign-in, an overlay, or a container recreate):
- the live session WebSocket frames;
- the forged `X-Forwarded-For` client IP, which needs the e2e IP-allowlist overlay;
- encoding parity against `api` addressed directly;
- state surviving recreation;
- the scale refusal.

These are listed in Risks.

### D6. Docs and Purpose text

- **README:** remove "e2e smoke and visual", the `e2e:container` section, the Companion
  `npm run e2e -- --project=companion` line, and the `npm run typecheck  # server + web + e2e`
  comment. Add one line: "Browser e2e is retired during the Supabase migration; the router is
  checked by `docker/scripts/test_router.sh stage`."
- **AGENTS.md:** delete the `npm run e2e:container` bullet.
- **ADR 0021 slice list:**
  - 1.4 is split into 1.4a and 1.4b;
  - the size exception for 1.4a is recorded;
  - 1.4 runs before 1.3.
- **Purpose edits at archive.** These are exact, and the human approves this text:
  - **`container-deployment`:** "…the explicit configuration required behind a TLS-terminating
    proxy; and the container e2e project that guards the routing." becomes "…the explicit
    configuration required behind a TLS-terminating proxy; and the non-browser router test that
    guards the routing."
  - **`api-contract-freeze`:** "…the separately-deployed Bitfocus Companion module, the `e2e/`
    Playwright suite, and external API clients…" becomes "…the separately-deployed Bitfocus
    Companion module, and external API clients…".

## Assumptions

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | Nothing but Playwright and the container runner starts a host server | panel: `git grep "npm run start"` and the playwright `webServer` | only `playwright.config.ts:39-141` and `e2e/container/run.sh:63-72` |
| A2 | `typecheck` compiles e2e, so deleting it would break the gate | panel: `grep typecheck package.json`; `npx tsc --noEmit -p e2e_does_not_exist` | `… && tsc --noEmit -p e2e && …`; `error TS5058 … exit=1` |
| A3 | Untracked e2e state exists | panel: `git check-ignore -v test-results e2e/.data`; `du -sh e2e/.data*` | ignored at `.gitignore:29,33`; 9.5M and 216K |
| A4 | A full `npm uninstall` mutates unrelated packages; `--package-lock-only` doesn't | panel: `npm uninstall @playwright/test --dry-run`; a copy with `--package-lock-only` | `added 17, removed 9, changed 44 packages`; lockfile `59 deletions`, audit unchanged |
| A5 | No container sets `AI_V2_SDK_EXECUTABLE_PATH` | panel: `docker exec autologger-dev-app printenv AI_V2_SDK_EXECUTABLE_PATH`; `grep AI_V2 docker/secrets-env.yaml` | exit 1; only `AI_V2_ENABLED`/`API_KEY`/`MAX_BUDGET_USD` |
| A6 | `teardown.mjs` would now hit the stack's docker-proxy | panel: `ps -C docker-proxy -o cmd` | `-host-port 8791 … -container-port 8000` (the stage Supabase gateway) |
| A7 | Lint already fails on two warnings unrelated to e2e | panel: `npm run lint` | `compression.int.test.ts:58:29 lint/style/noNonNullAssertion` (and :62), exit 1 |

## Risks / Trade-offs

- **[Coverage lost until e2e is rebuilt]** → Accepted by the owner:
  - browser smoke, visual and login gate;
  - Companion headless;
  - the live session WebSocket;
  - encoding parity;
  - forged-XFF client-IP resolution, of which `trusted_proxies_strict` is the router half;
  - state surviving `api` recreation;
  - the scale refusal.

  The router's own rules (traversal, stray upgrades, token scope, topology and dispositions)
  stay covered by `test_router.sh`. `server` unit and integration tests remain.
- **[`test_router.sh` isn't in CI]** → Same as `test_gateway.sh` (CI has no docker). It runs
  against stage, and 1.4b's docs and the Cursor rule point to it.
- **[The expectation table can go stale]** → A router change that alters a disposition fails
  the test. The table is then updated deliberately, in the same change.

## Migration Plan

1. Merge. Nothing to do on hosts, except that the untracked e2e state is already removed (D1).
2. Rollback: revert the PR. The files return; `e2e/.data*` doesn't, since it was disposable.
