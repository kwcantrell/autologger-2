## Why

`server/src/routers/` is a god-directory. Of its 27 production modules (7,642 LOC), 14
construct a `Hono` instance and one more (`sessionWs.ts`) registers a route on the app it
is handed. The remaining 12 register nothing — and 11 of them, **3,463 LOC, are the AI
runtime**: the MCP tool server, the Claude-CLI and Agent-SDK subprocess runners, the turn
orchestrator/relay, the shared per-session turn registry, the generation prompt builder,
and the process-group kill ladder. None of them is a router; none imports Hono, `AppEnv`,
or any route module.

That mismatch is not cosmetic, because the repo **publishes** a machine-generated
architecture atlas whose `routers` component globs `server/src/routers/**` and describes
it as the Hono route handlers. The atlas therefore asserts a falsehood about 3,463 LOC,
and the drift gate (`docs:check`) cannot detect it — the model is hand-authored and the
code matches the glob. Alongside it sit two smaller structural defects: `app.ts`, the
composition root's error mapper, imports `ApiError` **upward** out of `routers/_helpers.ts`
for its own error class; and `TimecodeCtx` is declared twice with an identical shape (a
recorded step-2 residual), with nothing compiling the two against each other.

This is step 3 of the modular-monolith campaign. **It is deliberately not justified as a
step-4 unblock** (gate ruling E1, 2026-08-07): the adversarial panel demonstrated that ten
of the eleven modules are extractable to a workspace package *today*, straight out of
`routers/`, and that an intermediate directory in fact adds churn a later package
extraction would undo. The change earns its place on the three defects above, each of
which stands on its own and survives the campaign changing shape.

## What Changes

- **The 11-module AI runtime moves to `server/src/ai-runtime/`**: `aiMcpServer`,
  `aiV2SdkSpawn`, `aiChatRunner`, `aiV2PendingQuestions`, `aiTurnOrchestrator`, `aiTurn`,
  `aiChatRelay`, `topicGenerate`, `aiChatRegistry`, `eventGeneratePrompt`,
  `processGroupKill` — with their 13 colocated unit test files (6,299 LOC).
  `processGroupKill.ts` rides along rather than landing in `server/src/node/`: its only two
  consumers move, and `node/` is app-internal, so parking it there would create a
  cross-boundary edge no manifest could legalize if the runtime is ever packaged.
- **Eight staying files get import rewrites** — the four route modules `ai.ts`, `aiV2.ts`,
  `events.ts`, `transcribe.ts`, **and four `*.int.test.ts` that stay in `routers/`**
  (`ai.int.test.ts`, `aiV2.int.test.ts`, `events.generate.int.test.ts`,
  `transcribe.int.test.ts`). **All four** hold namespace-import spies on moving modules
  (`vi.spyOn(aiTurnModule, 'driveAiTurn')` in two, `vi.spyOn(aiV2SdkSpawnModule,
  'attemptDesignTurnSpawn')` in one, `vi.spyOn(topicGenerateModule,
  'generateTopicsTurn')` in one), so the rewrite must keep test and route module resolving
  the same module instance. Because `ai-runtime/` and `routers/`
  are both direct children of `server/src`, every `../` specifier **and every
  `import.meta.url`-relative path literal** inside the moving files keeps its exact
  current meaning — the move is depth-preserving.
- **Two new architecture checks land in the boundary repo test**, so the rules this change
  establishes are enforced rather than asserted: (a) no production file under
  `server/src/ai-runtime/` may import `hono`, a `hono/*` subpath, `appEnv`, or any module
  under `server/src/routers/`; (b) every production module directly under
  `server/src/routers/` must import `hono`/`hono/*` or `appEnv`. Both are green from the
  commit that lands them. A third check asserts `SERVER_SRC_LAYER_DIRS` **matches the
  filesystem** (every production directory under `server/src` is enumerated or explicitly
  exempted) and that each enumerated directory is **non-vacuous** — closing the hole where
  a renamed or emptied directory silently drops out of the acyclicity guard while every
  gate stays green.
- **`ApiError` moves to `server/src/httpError.ts`**, retiring the upward
  `app.ts → routers/_helpers` edge. The rest of `_helpers.ts` (`requireSession`,
  `getSessionHub`, `timecodeCtx`, `parseOptionalMarkedAt`) stays — it is genuinely
  router-shared and uniformly Hono-typed.
- **`TimecodeCtx` stops being declared twice.** `routers/_helpers.ts` drops its duplicate
  and imports the type from `@autologger/session-core` for its own return annotation. **No
  re-export**: nothing imports `TimecodeCtx` from `_helpers` today, so a re-export would be
  a permanent shim serving nobody — exactly what the no-shim invariant forbids.
- **The boundary test's interface-only check is hardened** against three bypass classes in
  `checkInterfaceOnlyConsumption`: an exact-match specifier `Set` that a deep-subpath
  import walks past, an `import`-only clause regex that `export … from` walks past, and
  **wildcard clauses** (`import * as sc from '@autologger/session-core'` then
  `sc.SessionHub`; `export * from …`) that name no identifier at all — the last found
  independently by three reviewers and the most likely to be written by accident, since
  the barrels do `export * from './SessionHub'`. The check also gains the
  **synthetic-tree mutation test it has never had** (it is the only check in that file
  without one, and this change reshapes it).
- **The atlas gains an `ai-runtime` component**, and the `routers-to-claude-cli`
  relationship's **`from` endpoint** moves to it — not merely its evidence anchor. The
  evidence gate checks only that the file exists and contains the literals, never that it
  belongs to the `from` component, so re-anchoring alone would pass green while the atlas
  kept asserting that `routers` spawns the Claude CLI.

## Capabilities

### New Capabilities

None. The durable rules belong in the two existing architecture capabilities (design D5).

### Modified Capabilities

- `package-architecture`: gains a normative, **test-enforced** statement of the server-app
  module layout — `routers/` holds HTTP-layer modules only, the AI runtime's home is
  `server/src/ai-runtime/` and is Hono-free, the app-level HTTP error class is app-level,
  the layering-directory enumeration matches the filesystem and is non-vacuous, the
  architecture model attributes the runtime's files to a non-`routers` component, and the
  branch diff over `routers/` is import-only.
- `core-ports-architecture`: its "Interface-only consumption is continuously enforced"
  requirement is strengthened to defeat deep-subpath specifiers, `export … from`
  re-exports, and wildcard clauses, with mutation coverage — and its remaining bypasses
  recorded honestly rather than papered over with a shape-independence claim a regex scan
  cannot honor.

## Impact

**Contract impact: none.** No handler body is edited, no route registration moves, no
status code, JSON shape, header, export body, or WebSocket message or emission changes.
A delta scenario pins the **diff shape** (import-only changes in route modules), not just
"tests pass" — a behavior-preserving handler rewrite would satisfy the latter, and the
diff shape is what actually lets the layered audit skip re-reading 7,642 LOC.

- **Moved:** 24 files, ~9,762 LOC (11 production modules + 13 unit tests) from
  `server/src/routers/` to `server/src/ai-runtime/`; `ApiError` from
  `routers/_helpers.ts` to `server/src/httpError.ts`.
- **Rewritten imports:** 8 staying files (4 route modules + 4 `*.int.test.ts`), the
  `ApiError` importers (`app.ts`, 10 routers, 2 test files), and `_helpers.ts` itself. No
  permanent re-export shims (step-1 invariant).
- **Stale path comments (8, not the 5 the fact-check first found):** `aiV2/mcpTools.ts`,
  `node/ytdlp.ts` ×4, `packages/contract/src/schemas.ts`, plus `routers/aiV2.ts` (a
  *staying* file) and `aiV2SdkSpawn.test.ts` (a *moving* file, so `git mv` won't fix it).
  One of them — `ytdlp.ts`'s "`routers/aiChatRunner.ts` is router-layer" — is a
  **semantic** rewrite, not a path rewrite: the sentence is the recorded justification for
  a deliberate duplication, and this change falsifies it.
- **Enforcement:** `server/src/packageBoundaries.repo.test.ts` — extended, never forked;
  deltas land per phase with the code that needs them.
- **web-docs (a production consumer):** `model/components.ts` (new component, the
  `routers-to-claude-cli` `from` endpoint, **and a glob covering the new root-level
  `httpError.ts`** — root files are matched by exact-path lists, so a new one is an
  uncovered orphan that hard-fails `docs:check`), plus the regenerated committed snapshot
  `web-docs/model/edges.snapshot.json` (**not** `atlas.json`, which is git-ignored).
- **Unchanged:** `packages/**` apart from one comment, `web/`, `companion/`, `e2e/`, the
  README endpoint table (every module it names stays), and the vitest tier assignment of
  every `*.int.test.ts` (tiers are filename-glob-based, so location within `server/src` is
  free — though four of those files *are* edited, see above).

## Non-Goals

- **No welded-handler surgery.** `events/generate` (~195 lines), `youtube-import` (~145),
  `topics/generate` (~100), and `local-audio-import` (~65) keep their inline use-case
  bodies and their `Context<AppEnv>` weld. That is contract-adjacent reshaping needing
  characterization pinning and its own change.
- **No `aiV2/aggregates.ts` move** (gate ruling E2, 2026-08-07). The reason is **not** that
  the web test's relative dynamic import is hard to re-point — the panel correctly showed
  that is a one-line edit guarded by two gates. It is that `aggregates.ts` is pure
  computation deliberately hand-mirrored into `web/src/…/clientAggregates.ts`, so its
  correct home is a **shared** package that only step 5's web split can determine. Burying
  it inside an AI-runtime directory now would prejudge that. `aiV2/mcpTools.ts` stays with
  it, which is why `ai-runtime → aiV2` remains this change's one app-internal edge.
- **No package extraction.** `server/src/ai-runtime/` is a directory, not a workspace
  package.
- **No `sessionWs.ts` move.** It registers a route on the app `app.ts` hands it, and is
  Hono/`AppEnv`-typed — it belongs in `routers/` under this change's own rule.
- **No `_helpers.ts` dissolution** beyond `ApiError` and the `TimecodeCtx` duplicate.
- **No behavior change anywhere** — any observable difference is a defect, not a trade-off.
