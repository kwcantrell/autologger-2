# Panel: retire-host-dev
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-09-30

Three fresh subagents reviewed v1 of 1.4b, after the combined 1.4 panel (recorded in
`archive/2026-09-30-retire-e2e/panel.md`, whose "moved to 1.4b" items this change carries). After
this panel the owner decided on 2026-09-30:
- LAN device testing is unavailable for now, with a follow-up to make stage proxy-ready;
- single-process production goes to the follow-up `retire-single-process-prod`.

Resolutions point to the v2 artifacts. Findings raised by two or more reviewers are merged.

## Assumption tester

- [x] [major] The `.server-lock.db` name breaks the documented live backup: `copyDataDir.ts` copies every `*.db` and fails `SQLITE_BUSY` on the held lock. Evidence: held lock, then `copyDataDir.ts` -> `FAIL .server-lock.db: database is locked`, `1 of 2 database(s) failed verification`, exit 1. Also raised by failure and abuse, and by scope. Resolved: the lock file is `.server.lock` (no `.db`), so the copier never opens it (D2, A9).
- [x] [major] Nothing tested that a second `createBindings` refuses before migrating or sweeping. Also raised by scope. Resolved: a server integration test with a held lock and a planted `youtube-import-x` that must survive, and no `catalog.db` (D2, task 1.2). The live check runs a data-free probe first (task 3.1).
- [x] [minor] better-sqlite3's default 5000 ms busy timeout delays refusal. Evidence: `after 5008 ms` vs `after 1 ms`. Resolved: `{ timeout: 0 }` (D2), with a test for refusal within 100 ms.
- [x] [minor] Locking before `mkdirSync` turns a missing `DATA_DIR` into an opaque error. Also raised by failure and abuse. Resolved: `mkdirSync(dir,{recursive:true})` first (D2), with a test.
- [x] [minor] A second `npm run dev` in a running container passes the guard and leaves a stray watcher. Also raised by scope. Resolved: `bootGuardCli` also probes the lock (D1). The scenario covers `npm run dev`, and task 3.1 checks it.
- [x] [minor] The `HOST` default disagrees with `loopbackHostname` (binds 127.0.0.1, but the checks treat `''` as `0.0.0.0`). Also raised by failure and abuse (major) and by scope (major). Resolved: one effective host resolved in `createBindings`, which `main.ts` binds and the predicates read (D3, D5), with a test. The spec says "one effective host value".
- [x] [minor] `server/.env.example` gives values the change refuses. Also raised by scope (major). Resolved: `DATA_DIR=/data` and `HOST` lines with "compose pins this" comments, and a header saying nothing reads `server/.env` (D4).
- [x] [minor] The spec's ":8787" is the gate's port; the app listens on 8786. Resolved: reworded to "one origin (`:8787`, through the dev gate)".
- [x] [minor] Replacing the lock file's inode while it's held voids the lock. Resolved: recorded in Risks. Restores require the api stopped.

## Failure and abuse

- [x] [major] A live backup breaks on the lock. Resolved: see the assumption tester's first major.
- [x] [major] Garbage collection of the lock handle silently drops the lock. Evidence: `lk4.mjs` drop case -> `locks=0`, second `LOCK OK`. Resolved: the handle is kept in a module-level `Set`. A `--expose-gc` child test keeps the lock across `gc()` (D2, A6).
- [x] [major] A read-only lock file fails open (READ lock; `BEGIN EXCLUSIVE` succeeds twice). Evidence: `chmod 444` -> `POSIX ADVISORY READ`, second `LOCK OK`. Resolved: refuse `db.readonly`, and write `PRAGMA user_version` inside the exclusive transaction (D2), with a test.
- [x] [major] The two `HOST` values disagree. Resolved: see the assumption tester's matching minor.
- [x] [major] The LAN workflow through the proxy to stage doesn't work as stage is configured (`localhost` URL, non-Secure cookies), and it would expose prod-seeded stage data. Resolved: (owner decision, 2026-09-30) LAN device testing is unavailable during the migration. The docs and AGENTS.md say so, and making stage proxy-ready is a follow-up (proposal Decisions, O.3).
- [x] [minor] A missing `DATA_DIR` gives an opaque error. Resolved: see the assumption tester's matching minor.
- [x] [minor] Any open and close of the lock file in-process drops the `fcntl` lock. Resolved: commented at the function, and recorded in Risks. Nothing walks the `DATA_DIR` root.
- [x] [minor] The live check in task 3.1 could itself cause the incident if the lock were broken. Resolved: a data-free lock probe runs first (task 3.1).
- [x] [minor] The Cursor rule has no fallback when `make dev-restart` fails. Resolved: the rule says to stop and ask, and never to `docker restart` or `exec` a server (spec delta, D4).
- [x] [minor] The deepgram key was typed inline. Resolved: a hidden `read -rs` prompt in the header and error message (D3).
- [x] [minor] A stale `ADMIN_TOKEN=<from .env>` README line was missed. Resolved: added to D4, and task 2.1's grep includes `<from \.env>`.
- [x] [minor] The sentinel comment says "informational", but it is now load-bearing. Resolved: the comment is updated, and a test checks `STACKS` equals compose-run's `ENVS` (D1).
- [x] [minor] merge-audio output landed on the data volume. Resolved: `--out /tmp/<name>` in the container, then `docker cp` (D3).
- [x] [minor] No test that the refusal message stays clean. Resolved: a unit assertion that the message contains no values (D1).
- [x] [minor] NFS caveat. Resolved: the assumption "local volume drivers, not NFS" is stated in D2.

## Scope and simplicity

- [x] [major] Single-process production: declined here, which contradicts 1.4a's hand-off, and the reworded standalone scenario lost its meaning. Resolved: (owner decision, 2026-09-30) the follow-up `retire-single-process-prod` is named in the proposal and design. The standalone-scenario rewording is dropped, so that scenario moves to the follow-up unchanged. The "covered by integration tests" claim is corrected in Risks.
- [x] [major] The lock name breaks copyDataDir. Resolved: see the assumption tester's first major.
- [x] [major] The `HOST` default only reached `main.ts`. Resolved: see the assumption tester's matching minor.
- [x] [major] The required `DATA_DIR` in `createBindings` wasn't in D1. Resolved: D1 states it, with a test in `config.test.ts`.
- [x] [major] `server/.env.example` contradicts the new rules. Resolved: see the assumption tester's matching minor.
- [x] [major] README drift was under-scoped and is the size risk. Resolved: D4 lists every section (871-880, 914-943, 947/979/1055, 1361, 1612, 1734-1776, 1824), with a cap of about 120 lines. Task 2.1's grep excludes `npm run build -w companion`.
- [x] [minor] Scenarios without automated tests. Resolved: `bootOrder.int.test.ts` covers the relative `DATA_DIR`. The `createBindings` ordering test covers the second server. The `npm run dev` host refusal is a manual check, plus the repo test's guard-CLI assertion.
- [x] [minor] The repo test pinned too much. Resolved: it checks only "no `--env-file`" and "server `dev` invokes `bootGuardCli`" (D3).
- [x] [minor] Simplicity verdicts (keep the guard CLI, the lock, and the absolute `DATA_DIR`). Resolved: kept. The "/data not writable" sentence is removed from D1.
- [x] [minor] The AGENTS.md rule duplicated what the code enforces. Resolved: one pointer line, which also states that `npm test` and `npm run typecheck` still run on the host (D4).
- [x] [minor] The capture script's error message was still stale. Resolved: added to D3.
- [x] [minor] No contract statement. Resolved: D5, and the proposal's Non-goals.
- [x] [minor] The prod sentinel check could run now. Resolved: kept as O.2. No prod stack runs on this host.
- [x] [minor] A second `npm run dev` in the container hangs. Resolved: see the assumption tester's matching minor (the guard CLI probes the lock).

## Approval 2026-09-30
The owner approved v2 (lock fixes, one effective host, LAN unavailable, single-process production to follow-up).
