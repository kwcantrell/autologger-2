## Why

Three of the server's five feature clusters — DeepGram transcription, YouTube audio import,
and Sheets log import — are already self-contained: 14 production modules, 2,584 LOC, and
between them **zero** production imports of any other feature. Nothing records or enforces
that. They sit in `server/src/node/` and `server/src/logImport/`, and `server/src/node/`'s
declared role (`CLAUDE.md`: "composition-root wiring, `systemClock`, presence") covers 3 of
its 11 production files and 168 of its 2,011 LOC. The published architecture atlas repeats
a stale version of the same claim: `web-docs/model/components.ts` still describes
`node-infra` as holding "the blob store, kv-on-sqlite, the migrator", all three of which
left for `@autologger/storage` in `persistence-package-extraction`.

The campaign's stated goal is future-service seams. These three clusters are the ones that
already have the shape; extracting them turns a convention nobody checks into a layer graph
the boundary test enforces, and leaves `server/src/node/` matching its own description.

## What Changes

- **Three new source-only L2 packages**, extracted with no behavior change:
  - `@autologger/transcription` — `deepgram.ts`, `audioMerge.ts`, `transcriptRemap.ts`,
    `transcriptGenerationLock.ts`, `generateTranscript.ts` (1,252 LOC; `undici`,
    `mediabunny`)
  - `@autologger/media-import` — `ytdlp.ts`, `youtubeImportGuard.ts`,
    `youtubeImportScratch.ts` (591 LOC; Node stdlib only)
  - `@autologger/log-import` — `categoryMatch.ts`, `jobStore.ts`, `runSessionLogImport.ts`,
    `sheetTimecode.ts`, `sheetsFetch.ts`, `syncScore.ts` (741 LOC; `exceljs`)
- **A new L2 layer with a flat sibling rule** — a service package may import L0 and L1 and
  nothing else; **no service package imports another service package**. Enforced in
  `server/src/packageBoundaries.repo.test.ts` (extended, never forked) by four checks, not
  one: the direct-edge rule built independently of `ALLOWED_LAYER_EDGES`; a **no-L1→L2**
  rule, without which one allowed-edge entry plus a re-export through a persistence package
  launders a sibling dependency past every gate (the panel demonstrated this bypass running
  green); a **transitive reachability** check; and a walk widened to `.mts`/`.cts`, which no
  gate in the repo currently sees. The residual the mechanism genuinely cannot close — a
  service receiving another service's function **by injection**, which has no import edge at
  all — is recorded as a stated limit rather than claimed as covered.
- **`server/src/node/`'s restored role is enforced, not just restored.** Membership is
  pinned by name, as `routers/`'s is. The directory's documented role went false precisely
  because nothing checked it; restoring the sentence without a mechanism would schedule the
  same drift again.
- **The one service→service call is inverted into the router that already sequences it.**
  `logImport/runSessionLogImport.ts` exports two unrelated things: `ensureTimedTranscript`
  (an async coordinator that calls transcription, classifies `TranscriptGenerateError`, and
  retries once) and `runSessionLogImport` (the service proper, which takes `transcript`
  pre-resolved and imports nothing from transcription). `routers/logImport.ts` already calls
  them in sequence with every argument in hand; the coordinator moves there.
- **`logImport/jobStore.ts` reads time through the injected `Clock` port.** Its three
  `Date.now()` calls are terminal-TTL prune and `finishedAtMs` stamping — squarely inside
  the class `core-ports-architecture` forbids, and its scenario already covers "the
  workspace packages under `packages/`". `createLogImportJob`, `getLogImportJob`, and
  `setLogImportStatus` take a `Clock`; `appendLogImportLine` and `clearLogImportJobs` are
  unchanged. Seven production call sites, all in `routers/logImport.ts`, which already holds
  `c.env.ports.clock`. This closes a violation recorded as a residual since
  `package-split-foundation` rather than deferring it a fourth time.
- **Two modules stop reaching through the composition root for an L0 type.**
  `node/generateTranscript.ts` and `logImport/runSessionLogImport.ts` both import
  `type { Bindings }` from `../appEnv` solely to write `Bindings['ports']['audio']`, which
  resolves to `BlobStore` in `@autologger/ports`. They import `BlobStore` directly.
- **Only the config predicates a package's own code reads move.** `deepgramConfigured` and
  `deepgramModel` move into `@autologger/transcription` because `generateTranscript.ts`
  reads them itself — without the move the package would import `../env`.
  `resolveYtDlpPath` **stays** (gate ruling E2): it probes the host's `PATH` with
  `accessSync` and is called from `createBindings(procEnv)` at boot, which is the
  composition root's job of translating a host environment into configuration. A service
  receives its configuration; it does not reach into the deployment environment to discover
  it, so moving the probe into `@autologger/media-import` would be the wrong boundary, not a
  tidier one. Router-consulted deployment gates stay in `env.ts` — `ytDlpConfigured`
  because it reads the field the composition root populates, and
  `youtubeImportOpenNetworkRefused`/`sheetsLogImportOpenNetworkRefused` because they are two
  of the four callers of one shared open-network refusal helper.
- **Third-party dependencies follow their sole importer.** `undici` and `mediabunny` move
  from `server/package.json` into `@autologger/transcription`, where
  `checkThirdPartySpecifiers` already enforces declaration. **`exceljs` is declared by both**
  (gate ruling E1): `routers/logImport.int.test.ts` builds a workbook fixture with it and
  stays in the app, so removing the server declaration would leave a real import resolving
  only through workspace hoisting. The rule is scoped to dependencies imported by exactly
  one service, and the resulting confinement is stated honestly as declaration-side only —
  nothing scans the app's sources against the server manifest.
- **Test fixtures move with the service that owns them**, exposed by an exported directory
  constant so the integration tests that stay in `server/src/routers/` keep one copy —
  following the `packages/catalog/migrations` precedent. Four moving tests reach fixtures by
  `__dirname`/`import.meta.url`-relative paths that are not depth-invariant.
- **The architecture atlas is corrected across all three of its drift dimensions**, not
  merely re-anchored. Two **new** components (`transcription`, `media-import`) plus a
  **re-glob** of the `log-import` component that already exists pointing at
  `server/src/logImport/**`; `node-infra` narrowed and its stale description fixed; the two
  relationships whose evidence files move take their **`from` endpoint** with them; and the
  three **capability-to-component mappings** that name `node-infra` for transcription,
  YouTube import, and Sheets log import are re-pointed. None of the last three properties is
  machine-checked — the evidence gate never relates a file to its component and the
  capability check only verifies that a named component exists — so `docs:check` stays green
  while the published model asserts the composition root implements DeepGram transcription.
  `edges.snapshot.json` is regenerated and reviewed per edge.
- **`server/src/logImport/` ceases to exist** and leaves `SERVER_SRC_LAYER_DIRS`; `node/`
  retains `config.ts`, `systemClock.ts`, `presence.ts`.

**No breaking changes.**

## Capabilities

### New Capabilities

None. The rules this change introduces are layering rules, and `package-architecture`
already reasons over both the package layer graph and the `server/src` directory graph.
Splitting a second layering rulebook out would force every remaining campaign step to
choose between two homes — the reasoning `router-directory-decomposition` recorded as its
D5, applied unchanged.

### Modified Capabilities

- `package-architecture`: adds the L2 service layer and its flat sibling rule (enforced, not
  asserted); records that a service package's third-party surface is its own manifest;
  extends the existing process-wide-singleton requirement to cover the three singletons this
  change relocates (the log-import job map, the transcript-generation lock, the YouTube
  import guard); pins fixture ownership across the move.
- `core-ports-architecture`: the log-import job store's TTL reads move onto the injected
  `Clock`, closing the standing exception to the "No decision-making `Date.now()` remains"
  scenario.

## Impact

**Contract impact: none.** No route, JSON shape, status code, header, export body, or
WebSocket message changes. `deepgramConfigured` and `deepgramModel` keep their behavior at
their new home; `systemClock` reads the same source the job store's direct `Date.now()`
calls did, and no job time value is observable on the wire. The frozen surface is untouched
by construction — this change edits no handler body.

**Moving** (14 production files, 2,584 LOC; 11 co-moving test files):

```
server/src/node/         → packages/transcription/src/   5 prod, 4 tests
                         → packages/media-import/src/    3 prod, 3 tests
server/src/logImport/    → packages/log-import/src/      6 prod, 4 tests
```

**Edited in place** (12 files), arrived at through four successive corrections — the count
is stated with that history because three prior campaign changes each under-counted this
set, and so did this one, twice. Import-specifier extraction over `server/src`, `web/src`,
`e2e/`, and `companion/` found 8. The fact-check pass found a 9th by widening the scan to
`server/`. A path-literal search — which no import scan can perform — found a 10th. The
panel found an **11th** (`env.test.ts`, missed because the scan looked for consumers of
*moving modules* and `env.ts` does not move; only two of its exports do — a third
edit-set class) and a **12th** (root `package.json`, missed because the artifacts named the
wrong file as the package test/typecheck enumeration). `routers/transcribe.test.ts` imports
only `./transcribe` and is *not* in this set.

- `server/src/node/config.ts` — composition root; specifier rewrites for the moved
  media-import module
- `server/src/routers/transcribe.ts`, `sessions.ts`, `logImport.ts` — specifier rewrites;
  `logImport.ts` additionally gains `ensureTimedTranscript` and threads `Clock` into seven
  job-store calls
- `server/src/routers/transcribe.int.test.ts`, `sessions.youtubeImport.int.test.ts`,
  `logImport.int.test.ts`, `apiResponseFixtures.int.test.ts` — specifier and fixture-path
  rewrites; the last is part of the `fixtures/api-responses/` conformance chain
- `server/scripts/merge-session-audio.ts` — the live `npm run merge-audio` maintenance CLI
  imports `mergeAudioSegments`. It is typechecked (`server/tsconfig.json` includes
  `scripts/**/*.ts`) but is deliberately exempt from the architecture model, so `docs:check`
  will not flag it
- `server/scripts/capture-deepgram-fixture.mjs` — regenerates
  `deepgram-enrichment-response.json` from `audio/deepgram-enrichment-source.mp3`, addressing
  **both** moving fixtures by `import.meta.dirname`-relative path literal. As `.mjs` it is
  outside tsconfig's `scripts/**/*.ts` include, outside biome's `server/src` lint scope, and
  not a component member type: **no gate in the repo would catch a stale path here**, so it
  is verified by running it against a recorded request rather than by any automated check
- `server/src/env.test.ts` — asserts `deepgramConfigured` and `deepgramModel`, both of which
  move; those cases move into the transcription package's own suite
- root `package.json` — **the** enumeration that gives a package root `npm test` and
  `npm run typecheck` coverage (`server/vitest.config.ts` holds only the server's own
  `unit`/`integration` projects over `src/**`). Without three entries in each chain the new
  packages are never tested and never typechecked **while every phase gate reports green** —
  the failure mode the baseline's "every package covered by the root commands" requirement
  exists to prevent

**Also touched:** `server/src/env.ts` (two exports leave), `server/src/appEnv.ts`
(unchanged, but two former consumers stop importing it), `server/package.json`, three new
`packages/*/package.json` + `tsconfig.json` (each declaring its `@autologger/*` dependencies
as well as its third-party ones), `server/src/packageBoundaries.repo.test.ts`,
`web-docs/model/components.ts`, `web-docs/model/edges.snapshot.json`, `CLAUDE.md`'s Source
layout section, `README.md`.

**Dependencies:** `undici` and `mediabunny` relocate to `@autologger/transcription`;
`exceljs` is added to `@autologger/log-import` and **retained** by the server (E1). No
version changes, no additions to or removals from the tree. None is checked by nominal
`instanceof` across a package boundary, so none needs the `peerDependency` treatment `zod`,
`better-sqlite3`, and `jose` carry. Two package-owned error classes **do** become
cross-boundary `instanceof` subjects and each gets its own integration pin:
`TranscriptGenerateError` (already matched at two sites in `routers/transcribe.ts`, plus
three more that arrive with `ensureTimedTranscript`) and `YtDlpError` (matched in
`routers/sessions.ts`, whose own header notes callers branch on nothing else).

## Non-Goals

- **`auth` is not extracted.** Investigation showed it is not a logical service: `oauth_google.ts`
  is a port adapter (`GoogleIdentityVerifier implements IdentityVerifier`), while
  `identity.ts` is request-path plumbing consumed by `middleware/auth.ts` on every request,
  and it carries HTTP routing policy (`apiRequestRequiresLogin` knows `/api/profile`,
  `/api/admin/*`, `/api/`). Splitting it is an adapter-package question, recorded as a
  residual.
- **`ai-runtime` is not extracted.** It is 4,048 LOC (including `aiV2/`, whose `mcpTools.ts`
  is AI-runtime code filed in the wrong directory) and carries every remaining hard residual:
  `aggregates.ts`'s shared home, `processGroupKill`'s raw `Date.now()`, the
  `procEnv ?? process.env` / `homedir()` ambient defaults, and
  `topicGenerate.real.test.ts`'s `../env` escape. It follows as its own change, on the
  pattern this one establishes.
- **No handler bodies are edited.** The welded route handlers (`events/generate`,
  `youtube-import`, `topics/generate`, `local-audio-import`) stay welded; that remains a
  separate change requiring characterization pinning.
- **`Config` is not sliced.** All 40 `env.ts` exports were mapped to their consumers: it is
  a router-layer concern, and after this change **no** package imports it beyond the `Config`
  type itself. The 31-field interface blocks nothing here.
- **`resolveYtDlpPath` does not move** (gate ruling E2, reversing the draft). It is
  composition-root work — `PATH` probing with `accessSync`, called once from
  `createBindings(procEnv)` — and a service package should receive its configuration rather
  than discover it from the host environment. Moving it would also have split a documented
  producer/consumer pair (`env.ts`'s header and `ytDlpConfigured` cross-reference each other
  in both directions) and given `@autologger/media-import` an export no module in that
  package calls.
- **`transcriptGenerationLock`'s `Date.now()` is not "fixed".**
  `tryAcquire(sessionId, nowMs = Date.now())` stamps a `startedAtMs` on which no control
  flow, expiry decision, ordering, or persisted state depends — the lock never expires by
  time and is cleared in a `finally`. It is *not* merely a message: `GET
  /api/transcript-generation/status` serializes it as the **frozen** `started_at` field,
  which makes converting it a contract risk taken for no requirement. The reasoning is
  recorded rather than the code silently changed.
- **No re-export shims.** Old paths die with the move, per the standing campaign invariant.
