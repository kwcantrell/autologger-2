# Retire host dev: the server runs only in a compose stack

Tier: 2
Tier reason: adds boot refusals and a data-directory lock to the server, removes host scripts, and rewrites AGENTS.md's dev rule (process, high-risk paths).

Approved-by: Kalen 2026-09-30

## Why

ADR 0021 slice 1.4b, the second half of the owner's 1.4 split. 1.4a removed the Playwright
harness. This change retires running the app natively on the host, which today:
- reads `server/.env`;
- defaults `DATA_DIR` to `server/data` (ADR 0022's open risk);
- has no Supabase;
- bypasses every guard the stacks enforce.

The combined 1.4 panel also found that a second server started inside a running stack
(`make dev-shell`, `docker exec`) migrates the live database and deletes in-flight imports
before failing on the port.

## What Changes

- **The server boots only in a compose stack.**
  - A boot guard refuses (exit 1, naming `make dev-up`) unless `AUTOLOGGER_STACK` is `dev`,
    `stage` or `prod` and `DATA_DIR` is an absolute path.
  - `npm run dev` runs the same guard before `tsx watch`, so a refused host run exits instead of
    waiting for file changes.
- **One server per data directory.** `createBindings` first takes an exclusive lock on
  `DATA_DIR/.server.lock`, using SQLite's own file lock, which the OS releases when the process
  dies. A second server refuses before migrating, sweeping or creating anything, and so does a
  second `npm run dev` in a running container. The name has no `.db` suffix, so the live backup
  (`copyDataDir.ts`) is unaffected.
- **One effective host.** Outside production mode, `HOST` defaults to `127.0.0.1`. The same
  resolved value is used for the bind and for the open-network checks.
- **`server/.env` is never loaded.** `--env-file-if-exists=.env` is removed from every script.
  A repo test fails if any `package.json` script passes an env file. `server/.env.example` stays
  as the variable reference, with a header saying so.
- **BREAKING for developers: host scripts are removed.**
  - Root `build` and `start`, and server `start`, are removed. No container runs them.
  - `npm run dev` stays (the dev image's command) and refuses on the host.
  - The helper scripts `merge-audio` and `capture:deepgram-fixture` need explicit environment
    values.
- **Docs:**
  - **README:** quick start and dev flow use `make dev-up`. LAN device testing is unavailable
    during the migration. The env table has no `./data` default.
  - **AGENTS.md:** the loopback rule becomes "dev runs only in the dev stack".
  - **Cursor rule:** restart through `make dev-restart` (its scope stated), and never start a
    second server by hand.
  - **ADR 0022 follow-up:** notes that `server/.env.example` is kept.

## Decisions (owner, 2026-09-30)

- **Enforce in code** (AGENTS.md rule 8): boot refusal and a required `DATA_DIR`, not docs only.
- **Keep `server/.env.example`** as the variable reference.
- **LAN device testing** is unavailable during the migration. A follow-up makes stage reachable
  through the upstream proxy (public URL, Secure cookies, its own OAuth client), and the owner
  decides then about exposing stage data. (Revised after the panel, which showed stage pins
  `localhost` and non-Secure cookies.)
- **Single-process production** (one process serving the built frontend and API) stays in the
  specs and code, but nothing starts it. Follow-up change `retire-single-process-prod` decides
  whether to remove it or make it runnable in a stack. That includes "Same shell from both
  topologies", the standalone scenario and the router-parity reference. This closes 1.4a's
  hand-off of those scenarios to 1.4b.

## Non-goals

- **Single-process production and making stage proxy-ready.** Both are follow-ups (Decisions).
- **API contract.** No route, JSON shape, status, header or WebSocket message changes. The README
  endpoint table is untouched, and no `api-contract-freeze` delta is needed (design D5).
- **Moving `capture:deepgram-fixture` into a container.** Its fixtures aren't in the dev image,
  so it stays a host helper that takes `DEEPGRAM_API_KEY` explicitly.
- **`server/data` itself**, which stays the ADR 0022 rehearsal copy, and `copyDataDir.ts`.
- **Deleting `server/.env`** from this host. That is owner-owed, after confirming its values are
  in Infisical.
- **`docs/security.md`'s stale `.env` claim.** It belongs with the guardrail restore at
  cutover.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `web-frontend-platform`:
  - **Single-process development:** dev runs only in the dev stack. Host boot, a missing or
    relative `DATA_DIR`, and a second server on the same `DATA_DIR` are refused. Loopback is the
    default outside production, with one effective host. No script reads `server/.env`. LAN
    device testing is unavailable for now.
- `package-architecture`: the dev-loop scenario refers to the dev container.
- `cursor-agent-adapters`: the restart rule refers to `make dev-restart` and forbids
  hand-starting a server.

## Impact

- **Code:**
  - new `server/src/node/bootGuard.ts` (and a small CLI entry for the dev script);
  - `server/src/main.ts`, `server/src/node/config.ts`;
  - `packages/storage` (the data-directory lock);
  - `server/scripts/merge-session-audio.ts`, `server/scripts/capture-deepgram-fixture.mjs`.
- **Packages:** root and server `package.json`.
- **Tests:**
  - `bootGuard` unit tests;
  - a lock test in storage;
  - a boot-order integration test (spawns `main.ts` without the sentinel);
  - a repo test for env-file flags.
- **Docs:** `README.md`, `AGENTS.md`, `.cursor/rules/restart-server-yourself.mdc`,
  `server/.env.example`, ADR 0021 and 0022 notes.
- **Size:** about 300 counted lines, within the budget.
