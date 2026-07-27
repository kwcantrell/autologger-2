# Tasks: code-health-consolidation

> **PROVISIONAL until the adversarial panel + gate pass** (see design.md Panel & review
> log). Finding numbers reference `docs/reviews/2026-07-27-full-repo-review.md`; design
> decisions reference design.md. file:line anchors in both are orientation only — locate
> code by content before editing. Every task's commit is gated by
> `npm run typecheck` + `npm test`.

## 1. Preconditions and behavior-pinning tests

- [ ] 1.1 Confirm `quick-fixes-2026-07` is merged to `main` (owner-gated); rebase check —
      re-locate this change's touch points against the merged tree and note any moved
      anchors in `.apply/` notes
- [ ] 1.2 Pin current success-path broadcast behavior: int tests asserting the exact
      broadcast types/payload shapes/relative order for one representative mutation per
      broadcasting store (events, transport, audio, lease) and for both
      `suppressBroadcast` composite RPCs
- [ ] 1.3 Pin both AI paths' observable SSE sequences: tests capturing the full
      event-frame sequence for a chat turn and a design turn (success, timeout, abort,
      error) against the current implementations

## 2. Broadcast atomicity (contract-surface phase — per-phase review required)

- [ ] 2.1 Implement the core broadcast queue per D1 (enqueue-in-txn, flush-on-outermost-
      commit, discard-on-rollback; zero `await`s) with unit tests incl. nested-txn and
      mid-txn-throw cases
- [ ] 2.2 New failure-path test: forced commit-time failure emits no broadcast (delta
      spec scenario 1); success-path pins from 1.2 stay green unchanged
- [ ] 2.3 Delete both `suppressBroadcast` flags + compensating comments; composite RPC
      tests from 1.2 stay green byte-identical

## 3. Zero-byte suffix range (contract-surface phase — per-phase review required)

- [ ] 3.1 Blob-store range computation raises `InvalidRangeError` for suffix ranges on
      zero-byte blobs per D7; unit test + int test asserting `416` end-to-end (delta
      spec scenarios); existing satisfiable-range tests unchanged

## 4. AI process lifecycle (concurrency-sensitive phase — per-phase review required)

- [ ] 4.1 Extract the v2 group-liveness kill ladder into a shared module per D2; unit
      test for the leader-exits-member-survives case; both paths consume it; delete the
      chat-path leader-exit ladder
- [ ] 4.2 Extract the shared turn orchestrator per D3 (emit-guard swallows for both
      paths; scrubbing stays per-path parameter); SSE pins from 1.3 stay green for both
      paths
- [ ] 4.3 Cap `issuedClaudeSessionIds` per D4 with insertion-order eviction + unit test

## 5. Server consolidations

- [ ] 5.1 Deck title: `events.ts` + `companion.ts` call `sessionDeckDisplayTitle`
      (finding 2.4); output-equality tests for both call sites
- [ ] 5.2 `core.eventCounts()` per D10; transportStore/eventStore consume it; statusLive
      results pinned before/after (finding 2.10)
- [ ] 5.3 `guardAiV2Route` helper replacing the five copied prologues (finding 2.11);
      route-behavior tests unchanged
- [ ] 5.4 Store helpers: shared patch-builder + ordinal-seed helpers (topic/transcript
      stores), `freeLease()`, bidirectional mime↔ext table, `SELECT 1` existence checks
      (findings 2.12, review §1 low items folded there)
- [ ] 5.5 Companion payload typed server-side per D11 (type-only; wire bytes pinned by
      existing companion int tests)
- [ ] 5.6 Delete PUT `internal` dead branch per D9 (frozen 400 untouched; comment records
      why the branch was unreachable) (finding 3.8)
- [ ] 5.7 Catalog cleanups per finding 5.7 / D12: `authSetPrefs` upsert, `tx()` on the
      two read-modify-write pairs, `getStudioSettingsBlob` `resetToDefault()`,
      profile assembly single `listShowsForStudio`; behavior pinned by existing tests +
      new upsert test

## 6. De-async sweep

- [ ] 6.1 `requireSession` synchronous per D8; remove the ~44 spurious hub-RPC `await`s
      and both sync `Promise.all` wraps across transcribe/events/audio/companion/
      exports/sessions; make `server/src/test/helpers.ts` seeds sync; typecheck is the
      completeness check, frozen-contract int suites the behavior check

## 7. Web consolidations

- [ ] 7.1 `useSseTurn` hook + shared composer per D5; AiChat and AiV2Design consume;
      component tests for both tabs' vocabularies; dedupe `safeJsonParse`/
      `extractErrorDetail` (finding 2.1)
- [ ] 7.2 Internal-audio grammar: recording.ts imports predicates/parse/sort from
      audioClips.ts (finding 2.3); grammar unit tests consolidated
- [ ] 7.3 Shared marker-grouping util consumed by Timeline + MarkerNav (finding 2.6)
      with a group-equality test over a mixed fixture
- [ ] 7.4 `useGatedGenerate` + shared toolbar fragment for Transcribe/Topics feeds
      (finding 2.5); latch behavior tests preserved
- [ ] 7.5 Single `normalizePalette9` + `DEFAULT_PALETTE` export consumed by
      HomeSettingsModal + EventButtonsTable (finding 2.7); reconcile the two
      implementations' diff explicitly in the test
- [ ] 7.6 `sessionStatusKeys`/`audioSegmentsKeys` factories replacing all bare literals
      per D6 (finding 2.8); grep-clean assertion that no bare
      `'session-status'`/`'audio-segments'` literals remain outside the factories
- [ ] 7.7 Unify SessionCard/ArchivedSessionCard per D12 (finding 2.9); menu behaviors
      tested per variant
- [ ] 7.8 Small batched items (finding 5.9 subset dispositioned OS, D12): tab-panel map
      in SessionWorkspace, `colSpan={COLUMNS.length}`, memoized EventLogSheet
      filter+sort, `categories.map` index reuse, `useAudioClips` conditional tick bump,
      `AiV2Design.isSelected` keying, RecentSessionsList click/return cleanup,
      path-encoding + `OkResponse` + toast-API convergence (finding 5.8)

## 8. Test-infrastructure dedupe

- [ ] 8.1 Shared `parseSse` + `seededSession` in `server/src/test/helpers`; migrate the
      2 + 8 duplicating int-test files; rename the shadowing `configuredEnv`
      (finding 5.10)
- [ ] 8.2 Shared fake-core test helper replacing the three hand-rolled fakes (typed, no
      `as unknown as` casts); relocate the misplaced fakeClock suites to `node/`
- [ ] 8.3 Shared e2e `createSession` helper adopted by the 5 duplicating spec files
      (visual.spec's private helper promoted)

## 9. Final gates

- [ ] 9.1 Whole-branch layered scoped audit per sdlc-process (contract/seam diffs of
      phases 2–4, full diffs of deferred phases, shared-file cross-checks, materialized
      file list + stray-file scan, seam call-site checks, package integrity)
- [ ] 9.2 `npm run e2e` (chromium + login-gate) and `npm run e2e:visual` — visual
      baselines current as of 2026-07-14; any diff is branch-induced signal (this change
      intends zero visual change, so any diff is a defect, not a re-bless)
- [ ] 9.3 Full `npm test` + `npm run typecheck` + `npm run lint` across workspaces;
      update README/CLAUDE.md only if any consolidation moved a documented seam
