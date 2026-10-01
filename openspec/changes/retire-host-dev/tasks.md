# Tasks

The first commit on `supabase-1.4b-retire-host-dev` is `openspec/changes/retire-host-dev/` only.
The PR targets `supabase-migration`. Gates run with `GITHUB_BASE_REF=supabase-migration`.

## 1. Guards

- [x] 1.1 Write the tests first and see them fail (design D1):
  - `server/src/node/bootGuard.test.ts`: sentinel cases, `DATA_DIR` cases, a message with no
    values, `STACKS` equals compose-run's `ENVS`;
  - `server/src/node/bootOrder.int.test.ts`: spawns `main.ts` with no sentinel, and with a
    relative `DATA_DIR`;
  - `config.test.ts`: `createBindings` throws without `DATA_DIR` or with a relative one.
  Evidence: tests first: `npx vitest run bootGuard.test.ts bootOrder.int.test.ts config.test.ts` -> `Test Files  3 failed`, `Tests  3 failed | 3 passed` (bootGuard module missing; the old `main.ts` booted and hit the 30 s timeout; `createBindings` accepted no `DATA_DIR`). After: `Test Files  3 passed`, `Tests  11 passed`. Location: `packageBoundaries.repo.test.ts` allows only config/systemClock/presence/nextFrontend in `server/src/node/`, so the guard and its tests live in `server/src/` (`bootGuard.ts`, `bootGuard.test.ts`, `bootOrder.int.test.ts`). `npm test -w server` -> `Test Files  56 passed | 2 skipped`, `Tests  802 passed | 3 skipped`; `make check` -> `check-envs: ok (all)` (secrets-env.yaml sentinel comment updated).

  Then implement `bootGuard.ts`, the `main.ts` first-statement call, the `createBindings` check,
  and the `secrets-env.yaml` comment.
  - Check: `npm test -w server` passes. The integration test shows exit 1, the message, and no
    `data/` (A4).
- [x] 1.2 Write the storage lock tests first (design D2):
  - in-process `DataDirLockedError` within 100 ms;
  - release frees it;
  - a SIGKILLed child frees it;
  - a `--expose-gc` child keeps it across `gc()`;
  - a read-only file is refused;
  - a missing directory is created.
  Evidence: tests first: `vitest run src/dataDirLock.test.ts` -> `Cannot find module './dataDirLock'`; after -> `Tests  5 passed` (in-process refusal under 100 ms; another process refused while held, including after forced `gc()`; released on SIGKILL; a read-only lock file refused; a missing directory created). The first run's SIGKILL case failed because `tsx` runs the script in a child process, so killing `tsx` orphaned the holder; the tests now spawn `node --import tsx` as one process. `config.test.ts` ordering test first -> `× refuses a held DATA_DIR before migrating, creating or sweeping anything`; after wiring `acquireDataDirLock` first in `createBindings` (released in `close()`) -> `Tests  6 passed` (planted `tmp/youtube-import-planted` survives; no `catalog.db`, no `sessions/`; the same dir boots twice after close). `npm test -w server` -> `804 passed | 3 skipped`; `npm test -w packages/storage` -> `29 passed`. `bootGuardCli.ts` (in `server/src/`, same node/-directory rule as 1.1): no stack -> rc=1 with the guard message; a free dir -> rc=0; a dir held by another process -> `another AutoLogger server holds …`, rc=1.

  Also write the server integration test: a held lock, plus a planted `tmp/youtube-import-x`
  that survives, and no `catalog.db`. Then implement `acquireDataDirLock`, call it first in
  `createBindings`, release it in `close()`, and add `bootGuardCli.ts` (the guard plus a lock
  probe).
  - Check: `npm test -w packages/storage` and `npm test -w server` pass.
- [x] 1.3 Write `server/src/hostDev.repo.test.ts` first, and the effective-host test in
  `config.test.ts`. Then make the D3 changes (the host resolution, scripts, helper headers and
  messages, the `main.ts` warning).
  - Check:
    - `npm test` and `npm run typecheck` pass;
    - on the host, `npm run dev` exits 1 with the guard message in under 5 s, and nothing
      listens on :8787;
    - the `server/data` mtime is unchanged.
  Evidence: tests first: `vitest run src/hostDev.repo.test.ts src/node/config.test.ts` -> 4 failures (`--env-file` in scripts, dev without the guard, `HOST` empty in config). After D3 (effective host in `createBindings`, `main.ts` binds `bindings.config.HOST`, server `dev` = `tsx src/bootGuardCli.ts && … tsx watch …`, server `start` and root `build`/`start` removed, no `--env-file` anywhere, merge-audio requires `DATA_DIR`/`--data-dir`, capture script header and error use a hidden `read -rs` prompt, `main.ts` warning text) -> `Test Files  2 passed`, `Tests  10 passed`. `npm test` -> rc=0; `npm run typecheck` -> rc=0. Host: `env -i PATH HOME npm run dev` -> `autologger: AutoLogger runs only in a compose stack … make dev-up`, `rc=1 elapsed=290ms`; node listeners on :8787 -> 0; `server/data` mtime `1790636772` before and after.

## 2. Docs

- [ ] 2.1 README sections, `server/.env.example`, the `ai-runtime` comments, ADR 0021 and ADR
  0022 (design D4). The README stays at or under about 120 changed lines.
  - Check: `grep -nE "npm run (start|build)( |$|\`)|server/\.env([^.a-z]|$)|<from \.env>|\./data" README.md`
    finds only intended lines (`npm run build -w companion` is excluded by pattern).
- [ ] 2.2 AGENTS.md (the pointer line) and the Cursor rule (design D4).
  - Check: `scripts/check-change.sh --only guide-size` passes, and both files are read back.

## 3. Live verification

- [ ] 3.1 Rebuild and restart dev and stage.
  - Check:
    - all containers are healthy;
    - `make dev-restart` works;
    - `test_gateway.sh dev` passes, and `test_router.sh stage` passes;
    - first, a data-free lock probe in the dev container (a script that calls
      `acquireDataDirLock('/data')`) is refused;
    - only then, `npx tsx src/main.ts` in the container exits 1 naming the lock, and so does a
      second `npm run dev`;
    - the dev app keeps serving, and the `tmp/` listing is unchanged.

## 4. Verify

- [ ] 4.1 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`.
  - Check: green, with size within the budget.
- [ ] 4.2 Do the consistency read, appended to `panel.md`.
- [ ] 4.3 Archive with `/opsx:archive retire-host-dev`.
  - Check: `openspec validate --all --strict`.

## Owner-owed (not tracked as tasks)

- O.1 Confirm that every `server/.env` value is in Infisical, then delete `server/.env`.
- O.2 At cutover, confirm the prod `api` has `AUTOLOGGER_STACK` (`docker inspect`, name only).
- O.3 Follow-ups: `retire-single-process-prod`, and stage reachable through the upstream proxy
  for LAN testing.
