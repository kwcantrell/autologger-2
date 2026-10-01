# Retire the Playwright e2e harness, keep the router checks as a shell test

Tier: 2
Tier reason: removes a test tier and a container-deployment requirement, and touches AGENTS.md and `server/src/routers/**` (process, high-risk paths).

Approved-by: Kalen 2026-09-30

## Why

ADR 0021 slice 1.4 retires host dev. The owner split it on 2026-09-30:
- **1.4a `retire-e2e`** (this change) deletes the Playwright e2e harness;
- **1.4b `retire-host-dev`** refuses host boots and moves dev docs to the stack.

Every Playwright suite boots a throwaway server on the host (`npm run start`), and so does the
container runner's parity reference. That host path is what 1.4b retires. ADR 0021 had already
set `e2e:container` aside for the migration. The owner chose to drop e2e now and rebuild it
against the Supabase stack later.

The router's security behaviour was tested only by `e2e/container-routing.spec.ts`. It keeps a
behavioural test as a non-browser shell script.

## What Changes

- **BREAKING for tests: removed.**
  - Files: `e2e/` (all suites, harnesses, visual snapshots, `container/run.sh`,
    `container/compose.e2e.yaml`) and `playwright.config.ts`.
  - Root scripts: `e2e`, `e2e:container`, `e2e:visual`, `e2e:visual:update`, `teardown`.
  - The `e2e` part of `typecheck` and `lint`, and the `@playwright/test` devDependency.
  - Untracked e2e state (`e2e/.data*`, `test-results/`) is deleted before its ignore lines are
    removed.
- **Removed:**
  - `scripts/teardown.mjs`. It kills whatever listens on :8787, :8791 and :8792, and :8791 is
    now the stage Supabase gateway.
  - The AI v2 test seam `AI_V2_SDK_EXECUTABLE_PATH` (only Playwright set it), and its fake-agent
    fixture.
- **New `docker/scripts/test_router.sh ENV`.** It is a curl and raw-TCP test against a running
  stack's router. It ports the security cases of the routing suite:
  - shell routes;
  - the parity request list, checked against a committed expectation table;
  - stray-upgrade closure;
  - traversal with `API_TOKEN`;
  - `API_TOKEN` scope, including the WebSocket;
  - `web` unable to reach `api`;
  - the port unreachable off loopback.
- **Static check.** `make check` no longer resolves the prod + e2e overlay, so invariant 14 has
  no exemption.
- **Docs:** README e2e sections, the AGENTS.md `e2e:container` line, and stale comments.

## Decisions (owner, 2026-09-30)

- **Drop all e2e** rather than keep a hermetic host harness.
- **Split 1.4.** 1.4b (boot guard, scripts, dev docs) follows this change.
- **Size exception.** This change runs about 1,250 counted lines, almost all deletions of e2e
  harnesses and config, against ADR 0021's "each slice under 400". The owner accepts this one
  exception, recorded in the ADR 0021 slice list, and the PR carries `size-override`.
- **Keep the router's security cases** as `test_router.sh`.
- **Slice order.** 1.4 runs before 1.3 `postgres-backups`.

## Non-goals

- **Host serving** (`npm run start`, `build`), the boot guard, `DATA_DIR`, `server/.env`, and dev
  docs. All of that is 1.4b.
- **Rebuilding browser e2e.** A later change does this against the Supabase stack.
- **Cases that need a browser, a sign-in, an IP-allowlist overlay, or recreating containers.**
  These are recorded as risks, not ported:
  - the live session WebSocket;
  - the forged `X-Forwarded-For` case;
  - encoding parity;
  - state surviving recreation;
  - the scale refusal;
  - visual, login gate and Companion flows.
- **Spec text that names `e2e/` only as an example consumer:** `api-contract-freeze` "Unconsumed
  surface stays frozen" and the `package-architecture` fixture rule stay true without it, and
  are left unchanged.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `container-deployment`:
  - "Container e2e project" is removed.
  - The disposition-matrix parity scenario compares against a recorded expectation table.
  - New requirement: "Router behaviour is checked without a browser".
  - Purpose: "container e2e project" becomes "router test".
- `local-container-environments`:
  - **Static invariant check:** invariant 14 has no exemption.
  - **Coexistence:** the router-defaults scenario uses invariant 13 and `test_router.sh`.
- `web-frontend-platform`: in "Split-container serving topology", the standalone scenario no
  longer cites the e2e suites.

## Impact

- **Deleted:** `e2e/**`, `playwright.config.ts`, `scripts/teardown.mjs`,
  `server/src/test/fixtures/ai-v2-fake-agent.mjs`.
- **Changed:**
  - `package.json` and the lockfile;
  - `server/src/routers/aiV2.ts` (the seam);
  - `.gitignore`, `.pre-commit-config.yaml`;
  - `docker/scripts/{check-envs.sh,compose-env.sh,test_check_envs.sh}`;
  - `packages/ai-runtime/src/fixturesDir.ts` and `web/src/noAgentAuthoredMarkup.repo.test.ts`
    (stale e2e references);
  - `README.md`, `AGENTS.md`, the ADR 0021 slice list.
- **New:** `docker/scripts/test_router.sh` (a test file, excluded from size).
- **CI:** `typecheck` stops compiling `e2e`. CI never ran Playwright.
- **Coverage lost until e2e is rebuilt:** browser smoke, visual, login gate, Companion, session
  WebSocket, encoding parity, forged XFF, and state-across-recreation.
