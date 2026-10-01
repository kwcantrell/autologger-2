# Tasks

The first commit on `supabase-1.4b-retire-host-dev` is `openspec/changes/retire-host-dev/` only.
The PR targets `supabase-migration`. Gates run with `GITHUB_BASE_REF=supabase-migration`.

## 1. Guards

- [ ] 1.1 Write the tests first and see them fail (design D1):
  - `server/src/node/bootGuard.test.ts`: sentinel cases, `DATA_DIR` cases, a message with no
    values, `STACKS` equals compose-run's `ENVS`;
  - `server/src/node/bootOrder.int.test.ts`: spawns `main.ts` with no sentinel, and with a
    relative `DATA_DIR`;
  - `config.test.ts`: `createBindings` throws without `DATA_DIR` or with a relative one.

  Then implement `bootGuard.ts`, the `main.ts` first-statement call, the `createBindings` check,
  and the `secrets-env.yaml` comment.
  - Check: `npm test -w server` passes. The integration test shows exit 1, the message, and no
    `data/` (A4).
- [ ] 1.2 Write the storage lock tests first (design D2):
  - in-process `DataDirLockedError` within 100 ms;
  - release frees it;
  - a SIGKILLed child frees it;
  - a `--expose-gc` child keeps it across `gc()`;
  - a read-only file is refused;
  - a missing directory is created.

  Also write the server integration test: a held lock, plus a planted `tmp/youtube-import-x`
  that survives, and no `catalog.db`. Then implement `acquireDataDirLock`, call it first in
  `createBindings`, release it in `close()`, and add `bootGuardCli.ts` (the guard plus a lock
  probe).
  - Check: `npm test -w packages/storage` and `npm test -w server` pass.
- [ ] 1.3 Write `server/src/hostDev.repo.test.ts` first, and the effective-host test in
  `config.test.ts`. Then make the D3 changes (the host resolution, scripts, helper headers and
  messages, the `main.ts` warning).
  - Check:
    - `npm test` and `npm run typecheck` pass;
    - on the host, `npm run dev` exits 1 with the guard message in under 5 s, and nothing
      listens on :8787;
    - the `server/data` mtime is unchanged.

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
