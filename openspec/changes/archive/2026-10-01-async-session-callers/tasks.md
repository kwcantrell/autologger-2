# Tasks

The first commit on `supabase-3a-async-session-callers` is `openspec/changes/async-session-callers/`
only. The PR targets `supabase-migration`. Gates run with `GITHUB_BASE_REF=supabase-migration`.

## 1. The check first

- [x] 1.1 Promise-hygiene repo test (design D3).
  Evidence: `npx vitest run src/promiseHygiene.repo.test.ts` first run -> 6 fixture cases flagged as expected (dropped gate call, aliased `presence.list()`, port-interface call, `!asyncFn()`, ternary, `c.json` field) and the tree check failed with `[ 'src/main.ts:130 dropped promise' ]` (one `!x` fixture double-reported; deduplicated). `main.ts:130` now `void Promise.all(...)` (neither input rejects) -> `Tests  8 passed (8)`; no listed exceptions.
  - **Write `server/src/promiseHygiene.repo.test.ts` first:**
    - it builds a TypeScript `Program` from `server/tsconfig.json` and walks the non-test files
      under `server/src`;
    - it flags dropped promises and misused promises (condition, `!`, `&&`/`||` in a condition,
      template, `c.json` field);
    - in-memory fixture cases prove it catches: a dropped gate call, a dropped aliased
      `presence.list()`, `!asyncFn()`, and a dropped port-interface call.
  - **Run it against the current tree.** Fix or list (with a reason) any existing violation,
    starting with `main.ts:130`.
  - **Check:** the fixtures fail as expected, and the tree passes.

## 2. Ports and adapters

- [x] 2.1 KV port and adapter (design D2).
  Evidence: tests first -> `× every operation returns a promise`, `Tests  1 failed | 7 passed (8)`; after async port + adapter (lazy-expiry delete awaited; expired get removes the row, asserted on the raw table) -> `Tests  8 passed (8)`; `packages/storage` `Tests  31 passed (31)`.
  - **Tests first** in `packages/storage/src/kvStore.test.ts`: the cases await, and an expired
    `get` returns null and removes the row after the awaited delete.
  - **Then:** `packages/ports/src/kvStore.ts` and `packages/storage/src/kvStore.ts` become async.
- [x] 2.2 Presence port and adapter (design D2).
  Evidence: tests first -> `Tests  1 failed | 3 passed (4)`; after -> `Tests  4 passed (4)`.
  - **Tests first** in `server/src/node/presence.test.ts`: the cases await, and pruning is
    unchanged.
  - **Then:** `packages/ports/src/presenceRegistry.ts` and `server/src/node/presence.ts` become
    async.
- [x] 2.3 Startup purge (design D2).
  Evidence: tests first -> config `AssertionError: expected { n: +0 } to deeply equal { n: 1 }` and `Cannot find module './startupPurge'`; after (`server/src/startupPurge.ts`, awaited in `main.ts` after `createBindings`, before `serve(`; failure logs `startup KV purge failed (SqliteError)` and resolves) -> `Tests  12 passed (12)`. Live: dev app boots and logs `listening on http://127.0.0.1:8786`.
  - **Tests first:**
    - `config.test.ts`: an expired row survives `createBindings`;
    - a boot-helper test: a purge that resolves runs before listen; a purge that rejects logs a
      warning and boot continues.
  - **Then:** move the purge to an awaited boot helper in `main.ts`, wrapped in try/catch.

## 3. Callers

- [x] 3.1 Gate helpers and session-side routers (design D1, D3).
  Evidence: non-member WS upgrade test added first (passes before and after: a regression guard for the gate becoming async). 108 awaits added across the 11 router files; `requireSession`, `guardAiV2Route`, `exportRows`, `requireActiveSession`, `resolveCatalogSessionTitle`, `requesterCanViewSession` async; `primarySession` stays sync over one presence snapshot. One precedence slip (`await x()?.categories`) found by grep and fixed with parentheses. `npx tsc --noEmit -p server` -> no errors; promise-hygiene `8 passed`; `npm test` -> server `826 passed | 3 skipped`, all workspaces green; `git diff --cached -- '*.int.test.ts'` removes only the vitest import line (adds `vi`).
  - `requireSession`, `guardAiV2Route`, `exportRows`, `primarySession`,
    `requireActiveSession`, `resolveCatalogSessionTitle` and `requesterCanViewSession` become
    async.
  - Await every call in `sessionWs.ts`, `events.ts`, `sessions.ts`, `companion.ts`,
    `transcribe.ts`, `logImport.ts`, `exports.ts`, `audio.ts`, `ai.ts` and `aiV2.ts`, and every
    catalog, KV and presence call in those files.
  - **Check:** the promise-hygiene test passes; `npm test -w server` passes with no changed
    expectations.
  - **New test first:** a non-member WebSocket upgrade to another studio's session is refused
    (`companion-ws.int.test.ts`).
- [x] 3.2 Event-generation window (design D4).
  Evidence: `eventsGenerateWindow.test.ts` first -> `× has no await and no catalog call between the snapshot and tryAcquire`; after hoisting `(await catalog.sessions.getSessionShowCategories(id))?.categories` above the snapshot -> passes; `events.generate.int.test.ts` passes unchanged (in the 826).
  - **Test first:** a source-inspection test asserts no `await` and no `catalog.` between the
    word snapshot and `aiChatTurns.tryAcquire`. It fails today (catalog read at :477).
  - **Then:** hoist the categories read. The existing 400-detail generate tests pass unchanged.
- [x] 3.3 Companion (design D4, D5).
  Evidence: tests first -> `× /command stores last_command before broadcasting it`, `× /state takes one presence snapshot`; after (`kv.put` then `broadcastCommand`; `/state` derives both values from one `list()`) -> both pass; existing companion and companion-ws suites pass unchanged.
  - **Tests first:**
    - `/command` stores `last_command` before calling `broadcastCommand` (a spy on the hub
      observes the stored command when the broadcast runs);
    - `/state` reads presence once.
  - **Then:** reorder `/command`; `/state` reuses one `list()`.
- [x] 3.4 In-flight 409 redaction (design D5).
  Evidence: tests first -> transcription unit `× awaits an async title lookup and carries the named holder id`; route `AssertionError: expected 'A transcript generation run is alread…' not to contain 'Foreign Swapped Title'` (the leak, with the lock swapped after the detail was built). After (`TranscriptGenerateError.holderSessionId`; the route checks it) -> both pass; transcription `Tests  67 passed`; the existing redaction tests pass unchanged.
  - **Tests first:** a `packages/transcription` unit test: the in-flight error carries
    `holderSessionId` equal to the id in its detail. A route test: the lock holder changes
    between refusal and catch, and the non-member still gets the generic detail.
  - **Then:**
    - add the field;
    - `transcribe.ts` checks membership against it;
    - `resolveSessionTitle` may return a Promise and is awaited.
  - **Check:** the existing redaction tests pass unchanged.
- [x] 3.5 Log import (design D5).
  Evidence: test first -> `× returns a promise that rejects on an untimed transcript`; after (async `runSessionLogImport`, `await input.projectLive`, expression-bodied callback at `logImport.ts`) -> log-import `Tests  33 passed`; the success-path int test (`Created 2, skipped 0`) passes.
  - **Test first:** `runSessionLogImport` resolves only after an async `projectLive` resolves.
  - **Then:** make it async, give `projectLive` an expression body at `logImport.ts`, and await
    it.

## 4. Docs and verification

- [x] 4.1 ADR 0021: record the slice 3 scope (catalog, KV, presence; the session hub in slice 7),
  the 3a-3d split, and the slice 4 hazard list (design D6).
  Evidence: `docs/decisions/0021-migrate-to-self-hosted-supabase.md` slice 3 entry now lists the scope, 3a-3d and seven slice 4 hazards.
- [x] 4.2 At archive, change the `core-ports-architecture` Purpose from
  "synchronous-hub / synchronous-catalog posture (embedded-only, no Cloudflare-shaped or
  async-costume APIs)" to: "synchronous session hub (until ADR 0021 slice 7); catalog, key/value
  and presence ports converging on asynchronous APIs (ADR 0021 slice 3); no Cloudflare-shaped
  APIs".
  Evidence: `openspec/specs/core-ports-architecture/spec.md` Purpose now reads "a synchronous session hub (until ADR 0021 slice 7), with the catalog, key/value and presence ports converging on asynchronous APIs (ADR 0021 slice 3) and no Cloudflare-shaped APIs".
- [x] 4.3 Run `npm run typecheck`, `npm test` and
  `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`.
  Evidence: hook stage -> all PASS, `size  370/400 changed lines`, `risk-floor  15 high-risk path(s) touched`, `commands  ran ['typecheck', 'test']`; `npx biome check server/src packages` -> `Found 2 warnings` (the same 2 as the base, in `compression.int.test.ts`).
  - Size is at most 400 (design D7).
  - `git diff -- '*.test.ts'` shows only added awaits and new cases, with no changed expected
    responses.
- [x] 4.4 Live check: `make dev-restart`, then through the dev gate:
  - `GET /api/sessions`;
  - a session detail;
  - an export;
  - `GET /api/companion/state` with the token;
  - a session WebSocket connects.
  Evidence: `make dev-restart`; via `127.0.0.1:8787`: `GET /api/sessions 200`, unknown session `404`, `GET /api/companion/state 200` (token piped from the container env, never printed); a scratch show and session created through the API, then detail `200`, `export.csv 200`, events `200`, `ws open`.
- [x] 4.5 Consistency read, archive (sync specs), commit.
  Evidence: consistency read appended to `panel.md` (no scope change; one recorded deviation: `primarySession` stays sync over one snapshot). Specs synced: the two ADDED requirements are appended to `openspec/specs/core-ports-architecture/spec.md` and the Purpose is reworded; `openspec validate --all --strict` passes; the change moved to `archive/2026-10-01-async-session-callers`.
