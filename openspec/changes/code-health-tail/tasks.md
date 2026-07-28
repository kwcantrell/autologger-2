# Tasks: code-health-tail

> Gated 2026-07-27 (split from `code-health-consolidation` by its gate; the fact-check
> and panel reviewed this content pre-split). Finding numbers reference
> `docs/reviews/2026-07-27-full-repo-review.md`; decisions reference this change's
> design.md (IDs D5–D12, numbering shared with the head change). Anchors are
> orientation only — locate code by content. Every task's commit is gated by
> `npm run typecheck` + `npm test`.

## 1. Preconditions

- [x] 1.1 Confirm the head change (`code-health-consolidation`) is merged to `main`;
      re-locate this change's touch points against the merged tree (the head's D3
      rewrite moved the AI turn-runner internals) and note moved anchors in `.apply/`

## 2. Server consolidations

- [ ] 2.1 Deck title: `events.ts` + `companion.ts` call `sessionDeckDisplayTitle`
      (finding 2.4); output-equality tests for both call sites
- [ ] 2.2 `core.eventCounts()` per D10; transportStore/eventStore consume it; statusLive
      results pinned before/after (finding 2.10)
- [ ] 2.3 `guardAiV2Route` helper replacing the five copied prologues, parameterized by
      gate set per D12 (dashboard-CRUD routes keep their deliberately narrower gate);
      route-behavior tests unchanged (finding 2.11)
- [ ] 2.4 Store helpers: shared patch-builder + ordinal-seed helpers (topic/transcript
      stores), `freeLease()`, bidirectional mime↔ext table; incidental `SELECT 1` fix
      at the two sites this task already rewrites (finding 2.12)
- [ ] 2.5 Companion: payload typed server-side per D11 (incl. the two under-declared
      `last_command` fields; wire bytes pinned by existing companion int tests); row
      returned from `requireActiveSession`, three re-fetch sites consume it, both
      non-null casts deleted (findings 2.14, 5.6)
- [ ] 2.6 KEEP the PUT `internal` branch per D9; add the reachability/asymmetry
      comment; add the pinning test for a profile-defined `internal` category (delta
      spec scenarios) (finding 3.8)
- [ ] 2.7 Catalog cleanups per D12: `authSetPrefs` upsert, `tx()` on the two
      read-modify-write pairs, `getStudioSettingsBlob` `resetToDefault()`, single
      `listShowsForStudio` per profile assembly; new upsert test (finding 5.7)

## 3. De-async sweep

- [ ] 3.1 `requireSession` synchronous per D8; remove the ~45 spurious hub-RPC `await`s
      and both sync `Promise.all` wraps across transcribe/events/audio/companion/
      exports/sessions, AND the now-spurious `await requireSession` at every caller
      incl. sessionWs.ts/ai.ts/aiV2.ts (1.1 flag 2); completeness check is a grep
      sweep for awaits-on-sync-values (typecheck can't flag them) + typecheck;
      frozen-contract int suites the behavior check (finding 5.1)

## 4. Web consolidations

- [ ] 4.1 `useSseTurn` hook + shared composer per D5 (string `placeholder` prop);
      AiChat and AiV2Design consume; component tests for both vocabularies; dedupe
      `safeJsonParse`/`extractErrorDetail` (finding 2.1)
- [ ] 4.2 Internal-audio grammar: recording.ts imports predicates/parse/sort from
      audioClips.ts per D12 (reconcile `??`/`||`, decide export visibility); grammar
      unit tests consolidated (finding 2.3)
- [ ] 4.3 Shared marker-grouping util consumed by Timeline + MarkerNav (finding 2.6)
      with a group-equality test over a mixed fixture
- [ ] 4.4 `useGatedGenerate` + shared toolbar fragment for Transcribe/Topics feeds per
      D12 (verify premise against merged tree; reason-span content is a slot carrying
      Transcribe's inline `<code>`); latch behavior tests preserved (finding 2.5)
- [ ] 4.5 Single `normalizePalette9` + `DEFAULT_PALETTE` export per D12 consumed by
      HomeSettingsModal + EventButtonsTable; reconcile the two implementations
      explicitly in the test (finding 2.7)
- [ ] 4.6 `sessionStatusKeys`/`audioSegmentsKeys` factories replacing all bare literals
      per D6's inventory — incl. HomeSettingsModal's prefix-only literal (`.all`-style
      entry) and the two test files (finding 2.8); grep-clean assertion that no bare
      `'session-status'`/`'audio-segments'` literals remain outside the factories
- [ ] 4.7 SessionCard/ArchivedSessionCard EXTRACTION per D12: shared delete-confirm
      hook, shared meta/runtime helper, shared menu/meta-row scaffold; two thin variant
      components remain; behaviors tested per variant (finding 2.9)
- [ ] 4.8 Small batched items (5.9 OS subset per D12): tab-panel map in
      SessionWorkspace, `colSpan={COLUMNS.length}` (3 sites), memoized EventLogSheet
      filter+sort, `categories.map` index reuse, `useAudioClips` conditional tick bump,
      `AiV2Design.isSelected` keying, RecentSessionsList click/return cleanup,
      `OkResponse` adoption at the 11 inline `{ok: boolean}` sites (toast-API and
      path-encoding convergence are OUT — gate ruling 3)

## 5. Test-infrastructure dedupe

- [ ] 5.1 Shared `parseSse` + seed-chain helper in `server/src/test/helpers`; migrate
      the 2 parseSse files and the ~9–12 seed-chain-duplicating int-test files (full
      breadth per gate ruling 4); rename the shadowing `configuredEnv` (finding 5.10)
- [ ] 5.2 Shared fake-core test helper replacing the TWO remaining hand-rolled cast
      fakes (leaseStore/transportStore tests — the head change already typed
      sessionCore.test.ts's fake; 1.1 flag 1); relocate the misplaced fakeClock
      suites to `node/`
- [ ] 5.3 Shared e2e `createSession` helper adopted at the 7 inline creation sites +
      visual.spec's promoted helper (1.1 flag 3); visual.spec's two deliberate
      new-session-modal TESTS (button-click assertions) are NOT migrated

## 6. Final gates

- [ ] 6.1 Whole-branch layered scoped audit per sdlc-process (no contract-surface
      phases here — the delta spec pins existing behavior, changing nothing observable,
      so phase 2 is deliberately not review-tiered; full audit-package rules apply:
      materialized file list, stray-file scan, seam call-site checks — the new shared
      helpers ARE declared seams, package integrity)
- [ ] 6.2 `npm run e2e` (chromium + login-gate) and `npm run e2e:visual` — baselines
      last re-blessed 2026-07-26; this change intends zero visual change, so any diff
      is a defect, not a re-bless
- [ ] 6.3 Full `npm test` + `npm run typecheck` + `npm run lint` across workspaces;
      update README/CLAUDE.md only if a consolidation moved a documented seam
