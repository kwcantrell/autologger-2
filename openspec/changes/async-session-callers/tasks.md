# Tasks

The first commit on `supabase-3a-async-session-callers` is `openspec/changes/async-session-callers/`
only. The PR targets `supabase-migration`. Gates run with `GITHUB_BASE_REF=supabase-migration`.

## 1. The check first

- [ ] 1.1 Promise-hygiene repo test (design D3).
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

- [ ] 2.1 KV port and adapter (design D2).
  - **Tests first** in `packages/storage/src/kvStore.test.ts`: the cases await, and an expired
    `get` returns null and removes the row after the awaited delete.
  - **Then:** `packages/ports/src/kvStore.ts` and `packages/storage/src/kvStore.ts` become async.
- [ ] 2.2 Presence port and adapter (design D2).
  - **Tests first** in `server/src/node/presence.test.ts`: the cases await, and pruning is
    unchanged.
  - **Then:** `packages/ports/src/presenceRegistry.ts` and `server/src/node/presence.ts` become
    async.
- [ ] 2.3 Startup purge (design D2).
  - **Tests first:**
    - `config.test.ts`: an expired row survives `createBindings`;
    - a boot-helper test: a purge that resolves runs before listen; a purge that rejects logs a
      warning and boot continues.
  - **Then:** move the purge to an awaited boot helper in `main.ts`, wrapped in try/catch.

## 3. Callers

- [ ] 3.1 Gate helpers and session-side routers (design D1, D3).
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
- [ ] 3.2 Event-generation window (design D4).
  - **Test first:** a source-inspection test asserts no `await` and no `catalog.` between the
    word snapshot and `aiChatTurns.tryAcquire`. It fails today (catalog read at :477).
  - **Then:** hoist the categories read. The existing 400-detail generate tests pass unchanged.
- [ ] 3.3 Companion (design D4, D5).
  - **Tests first:**
    - `/command` stores `last_command` before calling `broadcastCommand` (a spy on the hub
      observes the stored command when the broadcast runs);
    - `/state` reads presence once.
  - **Then:** reorder `/command`; `/state` reuses one `list()`.
- [ ] 3.4 In-flight 409 redaction (design D5).
  - **Tests first:** a `packages/transcription` unit test: the in-flight error carries
    `holderSessionId` equal to the id in its detail. A route test: the lock holder changes
    between refusal and catch, and the non-member still gets the generic detail.
  - **Then:**
    - add the field;
    - `transcribe.ts` checks membership against it;
    - `resolveSessionTitle` may return a Promise and is awaited.
  - **Check:** the existing redaction tests pass unchanged.
- [ ] 3.5 Log import (design D5).
  - **Test first:** `runSessionLogImport` resolves only after an async `projectLive` resolves.
  - **Then:** make it async, give `projectLive` an expression body at `logImport.ts`, and await
    it.

## 4. Docs and verification

- [ ] 4.1 ADR 0021: record the slice 3 scope (catalog, KV, presence; the session hub in slice 7),
  the 3a-3d split, and the slice 4 hazard list (design D6).
- [ ] 4.2 At archive, change the `core-ports-architecture` Purpose from
  "synchronous-hub / synchronous-catalog posture (embedded-only, no Cloudflare-shaped or
  async-costume APIs)" to: "synchronous session hub (until ADR 0021 slice 7); catalog, key/value
  and presence ports converging on asynchronous APIs (ADR 0021 slice 3); no Cloudflare-shaped
  APIs".
- [ ] 4.3 Run `npm run typecheck`, `npm test` and
  `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`.
  - Size is at most 400 (design D7).
  - `git diff -- '*.test.ts'` shows only added awaits and new cases, with no changed expected
    responses.
- [ ] 4.4 Live check: `make dev-restart`, then through the dev gate:
  - `GET /api/sessions`;
  - a session detail;
  - an export;
  - `GET /api/companion/state` with the token;
  - a session WebSocket connects.
- [ ] 4.5 Consistency read, archive (sync specs), commit.
