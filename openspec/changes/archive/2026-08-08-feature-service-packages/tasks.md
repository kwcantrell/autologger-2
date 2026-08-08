> **The plan of record is final as of commit `2650188`.** The pre-panel fact-check, the
> 4-reviewer adversarial panel, the human gate (rulings E1–E5 and the D1 alternative), the
> heavyweight review of the two delta specs, and the light consistency read of all four
> artifacts have all run and their findings are folded across all four artifacts.

**Atomicity rule for this change (design D8).** A unit that moves modules also lands, in the
same unit: that package's manifest declarations (`@autologger/*` **and** third-party),
every specifier rewrite into it, and any `SERVER_SRC_LAYER_DIRS` edit the move causes. The
panel executed the earlier ordering and found three windows where `npm test` was red between
tasks. No unit may pass through a red state — the apply protocol gates each unit on
`npm test`, and a knowingly-red unit trains the implementer to ignore failures.

## 1. Characterize the untested seams (before any code moves)

- [x] 1.1 Pin `ensureTimedTranscript`'s retry path: an `upstream`-coded
      `TranscriptGenerateError` on the first attempt then success, the `in_flight` variant,
      and the non-retryable path (a non-`TranscriptGenerateError` propagates unwrapped).
      Assert the returned tokens and the `onProgress` line sequence. **Use fake timers** —
      the function sleeps 2000 ms on the retry path, and this change should not add real
      seconds to the unit tier. Locate the function by content in
      `server/src/logImport/runSessionLogImport.ts`.
- [x] 1.2 Pin `jobStore`'s time-dependent behavior against the current `Date.now()`
      implementation: terminal-TTL pruning, `finishedAtMs` stamping, and — separately, since
      it reads no time — the size-cap eviction that removes terminal jobs in insertion order
      and never a queued or running job. These assertions must survive phase 5's signature
      change unchanged in meaning.
- [x] 1.3 `npm test` + `npm run typecheck`; commit phase 1 alone, so the characterization is
      in history before anything reshapes.

## 2. Scaffold the layer and its enforcement (no module moves yet)

- [x] 2.1 Create `packages/transcription`, `packages/media-import`, `packages/log-import`:
      `package.json` (declaring the `@autologger/*` dependencies each will import —
      transcription and log-import both need `domain`, `ports`, `session-core`; media-import
      needs none), `tsconfig.json`, and `src/` containing a **placeholder module** — an empty
      `src/` fails `tsc --noEmit` with "No inputs were found", the reason the L1 extraction
      used one. Source-only: no build step, no committed build artifacts. `npm install`;
      verify workspace symlinks resolve.
- [x] 2.2 Wire the three packages into **root `package.json`** — three entries appended to
      the `test` chain (`npm run test -w packages/<name>`) and three to `typecheck`
      (`tsc --noEmit -p packages/<name>`), plus each package's own `test`/`typecheck` scripts
      and `vitest`/`typescript` devDependencies, matching the L1 packages exactly. This is
      the real enumeration: `server/vitest.config.ts` holds only the server's own `unit` and
      `integration` projects over `src/**` and must **not** gain package projects. Prove each
      package actually executes under root `npm test` and is typechecked under root
      `npm run typecheck` with a deliberately failing test and a deliberate type error, then
      remove both.
- [x] 2.3 Extend `server/src/packageBoundaries.repo.test.ts` (never a parallel walker) with
      the layer model and **all four** service-layer checks, landed together: (1) the direct
      no-sibling rule, built independently of `ALLOWED_LAYER_EDGES`; (2) **no L1 package
      imports an L2 package**; (3) transitive reachability between service packages; (4) the
      file walk widened to `.mts`/`.cts`. Add the `ALLOWED_LAYER_EDGES` entries for the
      packages' L0/L1 edges ahead of the moves so each gate is green from its first file —
      and add **only** edges that will actually exist (transcription imports `domain`,
      `ports`, `session-core`; it does **not** import `contract`).
- [x] 2.4 Add `TEST_INFRASTRUCTURE_EXEMPTIONS` coverage for
      `@autologger/log-import`'s `src/test/fakeClock.ts` in this same phase — it imports `vi`
      from `vitest` and is not a `*.test.ts`, so `checkThirdPartySpecifiers` would flag it
      when phase 5 adds the copy. Landing the exemption with the check rather than with the
      file it governs is the one deliberate exception to the atomicity rule, because the
      boundary-test delta belongs here.
- [x] 2.5 Give the four checks synthetic-tree mutation coverage that **invokes the same
      exported check functions and the same production membership constant** the real-repo
      assertions use — a synthetic set of invented package names would pass either way.
      Cases: clean tree → zero violations; a direct service→service import IS flagged; the
      same import **with** its entry added to `ALLOWED_LAYER_EDGES` is STILL flagged; an
      L1→L2 import IS flagged; a three-package transitive chain IS flagged; a `.mts` file
      importing a sibling IS flagged; a typo'd and an empty membership constant each FAIL the
      mutation cases rather than passing. Parameterize the allowed-edge set as a function
      argument rather than mutating the module-level constant, so a mid-test throw cannot
      leak into later cases. Execute the assertions; do not reason about them.
- [x] 2.6 Add the `node/` membership check: production files **anywhere under**
      `server/src/node/`, recursively, are exactly `config.ts`, `systemClock.ts`,
      `presence.ts` — a subdirectory is a violation, not an exemption, because the layering
      enumeration compares only top-level directories and would not see a feature
      accumulating at `server/src/node/<feature>/`. Follow the shape of the existing
      named-basename assertion for the AI-runtime cluster, and give it a synthetic-tree case
      proving the nested-directory violation is caught. It will fail until phase 4 completes,
      so land it **disabled with an explicit reference to the task that enables it**, or land
      it in phase 4 — implementer's choice, recorded in the ledger.
- [x] 2.7 Add `transcription` and `media-import` components to `web-docs/model/components.ts`
      with their globs. **Do not add a `log-import` component — one already exists** at
      line ~193 globbing `server/src/logImport/**`; it is re-globbed in phase 5.
      `npm run docs:check`.
- [x] 2.8 `npm run typecheck` + `npm test` + `npm run lint` + `npm run docs:check`; commit.

## 3. `@autologger/media-import` (the pattern-proving extraction — no workspace imports at all)

- [x] 3.1 **One atomic unit**: `git mv` `ytdlp.ts`, `youtubeImportGuard.ts`,
      `youtubeImportScratch.ts` and their three test files into
      `packages/media-import/src/`; move `server/src/test/fixtures/fake-ytdlp.mjs` to
      `packages/media-import/fixtures/` and export a directory path constant; rewrite
      `ytdlp.test.ts`'s `fileURLToPath(new URL('../test/fixtures/fake-ytdlp.mjs',
      import.meta.url))` to the package-local path and
      `sessions.youtubeImport.int.test.ts`'s copy of that literal to the exported constant;
      and rewrite `routers/sessions.ts`'s and `node/config.ts`'s specifiers. Locate every
      literal by content. `resolveYtDlpPath` **stays in `env.ts`** (gate ruling E2) — do not
      move it, and do not touch `env.ts`.
- [x] 3.2 Verify the move carried no content change: the pure `git mv` is its own commit and
      the blob hashes match across it; the specifier and fixture-path rewrites land as a
      **separate** commit. (A rewrite changes the hash, so the two cannot share a commit and
      still be hash-verifiable — this is the change's primary defense against a semantic edit
      hiding in a wide diff.) **Deviation (recorded, apply-time):** landed as a single commit
      instead — all six moving files' production/test import specifiers resolve only to
      `node:` builtins or same-depth relative siblings, so five of six are byte-identical
      across the move (verified by blob hash) and the sixth (`ytdlp.test.ts`) changes by
      exactly the fixture-path line (verified by diff); a literal pure-move-only commit would
      have left `routers/sessions.ts`/`node/config.ts` importing a deleted path, violating the
      no-red-state atomicity rule instead. See `.apply/task-3a-report.md`.
- [x] 3.3 Add an integration pin, through the real app, that `YtDlpError` thrown inside the
      package still matches `routers/sessions.ts`'s `instanceof` and produces the frozen
      status code and `{detail}` — following `routers/flows.int.test.ts`'s shape.
      `sessions.youtubeImport.int.test.ts` already has the harness.
- [x] 3.4 Atlas: narrow the `node-infra` glob; move the `node-infra-to-yt-dlp` relationship's
      **`from` endpoint** to `media-import` (renaming its id), not merely its evidence anchor
      — `checkRelationshipEvidence` never checks component membership, so re-anchoring alone
      passes green while the model keeps asserting the composition root spawns `yt-dlp`; and
      re-point the `youtube-audio-import` **capabilityScope** from `node-infra` to
      `media-import`. Regenerate `web-docs/model/edges.snapshot.json` (**not** the git-ignored
      `atlas.json`) and review per edge with attribution.
- [x] 3.5 `npm run typecheck` + `npm test` + `npm run docs:check`; commit.

## 4. `@autologger/transcription`

- [x] 4.1 **One atomic unit** — the panel proved every split of this leaves a red gate:
      `git mv` `deepgram.ts`, `audioMerge.ts`, `transcriptRemap.ts`,
      `transcriptGenerationLock.ts`, `generateTranscript.ts` and their four test files
      (`generateTranscript.ts` has none) into `packages/transcription/src/`; move
      `deepgramConfigured`/`deepgramModel` out of `server/src/env.ts` into the package;
      replace `type { Bindings } from '../appEnv'` with
      `type { BlobStore } from '@autologger/ports'` in `generateTranscript.ts`; declare
      `undici` and `mediabunny` in the package manifest and remove them from
      `server/package.json`; and rewrite `routers/transcribe.ts`'s specifiers. Until all of
      these land together the package holds two `escape` violations and two undeclared
      third-party specifiers.
- [x] 4.2 Move `test/fixtures/audio/` (10 files) and `deepgram-enrichment-response.json` into
      `packages/transcription/fixtures/`, export a directory path constant, and rewrite all
      **five** reading sites, located by content: `audioMerge.test.ts`'s
      `import.meta.dirname` join, `deepgram.test.ts`'s and `transcriptRemap.test.ts`'s
      `__dirname` joins, and `transcribe.int.test.ts`'s two literals. Confirm no copy remains
      under `server/src/test/fixtures/`.
- [x] 4.3 Move `env.test.ts`'s `deepgramConfigured` and `deepgramModel` cases into the
      transcription package's own suite. Its `resolveYtDlpPath` cases stay in `env.test.ts`
      untouched (E2).
- [x] 4.4 `npm install`; verify `undici` and `mediabunny` each resolve to exactly one copy by
      **parsing `npm ls --json`**, never by reading its exit code.
- [x] 4.5 Add an integration pin, through the real app, that `TranscriptGenerateError` thrown
      inside the package still matches `routers/transcribe.ts`'s two `instanceof` sites and
      produces the frozen status codes and `{detail}` bodies.
- [x] 4.6 Rewrite `server/scripts/merge-session-audio.ts`'s `../src/node/audioMerge` import.
      It is typechecked (`server/tsconfig.json` includes `scripts/**/*.ts`) but is an explicit
      architecture-model exemption, so `docs:check` will not flag it. Verify
      `npm run merge-audio -w server --` still resolves and reports its usage error.
- [x] 4.7 Rewrite `server/scripts/capture-deepgram-fixture.mjs`'s two
      `import.meta.dirname`-relative path literals (the source `.mp3` and the output `.json`)
      to the package fixtures directory. **No gate covers this file** — `.mjs` is outside
      tsconfig's `scripts/**/*.ts` include, outside biome's `server/src` lint scope, and not a
      component member type. It is run under `node`, not `tsx`, so it cannot import the
      exported constant and hardcodes the relative path; note that exception explicitly.
      Verify by executing it far enough to prove both paths resolve — it must fail on the
      missing DeepGram key, never on a missing file.
- [x] 4.8 Verify `server/src/node/` now holds exactly `config.ts`, `systemClock.ts`,
      `presence.ts` and their tests, and enable the task-2.6 membership check if it was
      landed disabled.
- [x] 4.9 Atlas: narrow `node-infra` to its final globs and correct its description (it still
      claims the blob store, kv-on-sqlite, and the migrator, all of which left in step 2);
      move `node-infra-to-deepgram`'s **`from` endpoint** to `transcription`; re-point the
      `transcript-generation` capabilityScope, and the `sheets-log-import` scope's
      `node-infra` entry with its inline "reuses the existing DeepGram generate path"
      comment. Regenerate and review `edges.snapshot.json` per edge.
- [x] 4.10 Re-run the edit-set search for this phase over the **whole repository** including
      `server/scripts/`, and separately search for **path literals** naming the moved files or
      fixtures. Import extraction cannot see path literals and cannot see consumers of
      *symbols* that move out of a staying module — three distinct instruments, all required.
      Record all three result sets in the apply ledger.
- [x] 4.11 `npm run typecheck` + `npm test` + `npm run docs:check`; commit the mechanical move
      separately from the semantic edits.

## 5. `@autologger/log-import`

- [x] 5.1 Relocate `ensureTimedTranscript` into `routers/logImport.ts` (a Hono-importing
      module — a `routers/coordinators/*.ts` file fails the router-membership check). Task
      1.1's pins must pass unchanged. Expect ~8 new imports in that router and a new
      `routers/logImport.ts → @autologger/transcription` edge; `timedTranscriptTokens` and
      `TranscriptToken` become package exports, and `timedTranscriptTokens` will have no
      remaining in-package caller. Add the integration pin for the three
      `instanceof TranscriptGenerateError` sites that arrive with it.
- [x] 5.2 Thread `Clock` through `jobStore`: `createLogImportJob(clock, …)`,
      `getLogImportJob(clock, …)`, `setLogImportStatus(clock, …)`; leave `appendLogImportLine`
      and `clearLogImportJobs` alone. Preserve the `globalThis` key and its `tsx watch`
      rationale verbatim. Update the **seven** production call sites in `routers/logImport.ts`
      (`createLogImportJob` ×1, `getLogImportJob` ×1, `setLogImportStatus` ×5) — five of them
      run inside the detached post-response closure, so they read the **captured `env`**
      (`const env = c.env`, already at line ~82), not `c`. Rewrite `jobStore.test.ts` onto a
      `fakeClock`; its 11 `appendLogImportLine` call sites are untouched.
- [x] 5.3 **One atomic unit**: `git mv` the six log-import modules and their four test files
      into `packages/log-import/src/`; add the package's own `fakeClock` copy (the fourth —
      duplicate-per-package is final policy; the existing three are **functionally** identical,
      each carrying its own provenance header, so a differing header is expected); declare
      `exceljs` in the package manifest **and leave it declared by `server`** (gate ruling E1
      — `routers/logImport.int.test.ts` imports it and stays); rewrite `routers/logImport.ts`,
      `logImport.int.test.ts`, and `apiResponseFixtures.int.test.ts` specifiers; and **remove
      `logImport` from `SERVER_SRC_LAYER_DIRS` in this same unit**, since the directory empties
      here and the non-vacuity check fires the moment it does.
- [x] 5.4 `npm install`; verify `exceljs` resolves to exactly one copy by parsing
      `npm ls --json`. Confirm the `fixtures/api-responses/` conformance chain is green
      **without re-capturing**.
- [x] 5.5 Atlas: **re-glob** the existing `log-import` component from `server/src/logImport/**`
      to `packages/log-import/src/**` and revise its description (the coordinator half left in
      5.1) — do **not** add a second component. Confirm no component retains a glob matching
      zero files and no relationship's `from` still names the composition root for evidence
      that moved. Regenerate and review `edges.snapshot.json`. Delete the two
      `packages/log-import/src/**` `exclusions` entries added in task 2.7 — `coverage.ts`
      skips excluded files *before* component matching, so leaving them would drop the
      re-globbed package's entry point out of the orphan gate and leave a stale exclusion
      pointing at the deleted test placeholder. Confirm `packages/log-import` is enrolled in
      `web-docs`'s `WORKSPACE_REGIMES` (added by the phase-4 fix wave) — an unenrolled package
      has every outgoing edge silently skipped, and `docs:check` passes over a false atlas.
- [x] 5.6 `npm run typecheck` + `npm test` + `npm run docs:check`; commit 5.1 and 5.2's
      semantic reshapes separately from 5.3's mechanical move.

## 6. Prove the enforcement, don't assert it

- [x] 6.1 Demonstrate the direct no-sibling check against a **live** violation: add a
      service→service import, observe the failure; add the corresponding
      `ALLOWED_LAYER_EDGES` entry, observe it **still** fail; revert. Record both observed
      failures in the apply ledger.
- [x] 6.2 Demonstrate the **L1→L2** check: add an L1 package import of a service package plus
      its allowed-edge entry, observe the failure, revert. This is the bypass the panel
      observed running green without this check; the demonstration is the evidence that it no
      longer does.
- [x] 6.3 Demonstrate the transitive check against a chain whose intermediate hop is an **L0**
      package (e.g. `transcription → domain → media-import`, with the enabling
      `@autologger/domain->@autologger/media-import` entry added) — an L1 intermediate would
      also be caught by check 2 and so would not distinguish the reachability check's presence
      from its absence. Then demonstrate the `.mts` walk against a real `.mts` file. Revert
      both.
- [x] 6.4 Verify the server-directory import graph is still acyclic; that `node`, now three
      files, is non-empty and correctly enumerated; and that no production file under
      `server/src` is an uncovered orphan in the component model. Demonstrate the non-vacuity
      check by temporarily restoring the `logImport` enumeration entry and observing the
      empty-directory failure — **after** the phase is green, not during it.
- [x] 6.5 Verify by **executing** the relevant regexes that the interface-only, third-party,
      router-membership, and `ApiError`-home checks still behave as specified after the layer
      model grew.
- [x] 6.6 Confirm no re-export shim exists at any former path.

## 7. Documentation and final gates

- [x] 7.1 Update `CLAUDE.md`'s Source layout section (three L2 service packages; `node/`'s
      real contents; `logImport/` gone) and `README.md` where it describes the same layout.
      Re-point stale path references in prose comments found by content search — including
      `packages/ports/src/config.ts`'s and `packages/session-core/src/SessionHub.ts`'s. Do not
      convert past-tense origin headers into present-tense obligations.
- [x] 7.2 `npm run typecheck` + `npm test` + `npm run lint` + `npm run docs:check` from the
      repo root. Confirm the three packages actually appear in the root `test` and `typecheck`
      output — green is not evidence they ran.
- [x] 7.3 `npm run e2e` (chromium + login-gate projects) and `npm run e2e:visual`. Visual
      baselines were regenerated 2026-08-07 (`d23e8b9`, 44 PNGs), so any diff is
      branch-induced signal; this change alters no UI, so a visual diff is a defect to
      investigate, never a baseline to re-bless.
- [x] 7.4 Verify the delta specs describe what actually shipped — including any behavior
      changed by a fix wave. `design.md` does not sync to the baseline; only the delta does,
      so a delta left stale hands the next change a spec licensing the bug just fixed.
