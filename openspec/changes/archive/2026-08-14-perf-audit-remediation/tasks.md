# Tasks: perf-audit-remediation

> **Retroactive.** Phase 1 describes work that shipped before this change existed and is recorded
> as done, with the commits that did it. Phases 2–4 are the remaining work this change owns.
> Phase 5 is explicitly NOT owned here. `file:line` anchors are orientation only — locate quoted
> code by content before editing.

## 1. Implementation — ALREADY SHIPPED (branch `perf-fixes`, merged `64593f7`, 2026-08-14)

Recorded for the audit trail. 35 commits: five implementation waves, then seven fix waves (one
per `/code-review` round — see `design.md`'s Panel & review log). Every wave was gated on
`npm test` + `npm run typecheck`; `npm run e2e` joined from the third implementation wave onward.

- [x] 1.1 Server: `/api/*` gzip with a shared compressible-type predicate, an inner
      `Content-Length`-stamping middleware so the size threshold applies, and
      `Vary: Accept-Encoding` on negotiation-eligible responses. `46710a7`, `a34543e`, `45c7ff9`.
- [x] 1.2 Server: `sync-from-disk` returns counts, not the segment list. `5a6a02c`.
- [x] 1.3 Server: transcript-words wire trim (`session_id`, `created_at_utc` dropped; seconds
      rounded to 3 decimals) across all four word-serializing handlers. `8218b8c`.
- [x] 1.4 Server: profile `shows[]` slimmed to the brief shape; new `GET /api/shows/:showId`
      with a masked 404. `6cde8ee`.
- [x] 1.5 Server: audio mime clamped by compressibility (not an allowlist) on store and serve,
      via the predicate shared with the compression middleware. `b60298e`, `8fa3f80`.
- [x] 1.6 Web: transcript-words fetch deferred behind a sticky per-session gate; dashboards
      widgets additionally require their tab to be shown. `5e50dfa`, `2ed33bd`.
- [x] 1.7 Web: event feed virtualized; shared draft store backing both virtualized feeds; edited
      row pinned with focus/caret restore. `ba7aebb`, `4d344bd`, `2ec06f0`, `be9a51c`.
- [x] 1.8 Web: island route-split behind `React.lazy` with chunk-load error boundaries and
      warm-ups. `934aa3b`, `ecce4de`.
- [x] 1.9 Web: CLS fix (interstitials reserve workspace height; feed loading row) and the
      memoization tier containing the playback tick. `2d68fa2`, `b3386ae`.
- [x] 1.10 Web: data-layer hygiene — WS-open resync correctness, presence on a worker clock,
      queue-scoped `beforeunload` restoring bfcache, offline/paused query states.
      `6c4f7c2`, `321babb`, `0ff38fd`, `8af8bfa`, `258c359`, `bfbd86a`, `022ae9f`, `204c882`.
- [x] 1.11 Web: font dedupe, preload, and dead-face deletion. `d1a6e08`.
- [x] 1.12 Seven `/code-review` rounds with a fix wave after each (findings 10 → 10 → 10 → 3 → 3
      → 2 → 2). Final gates green: root `npm test`, `npm run typecheck`, `npm run e2e` (30/30),
      production build.

## 2. This change's artifacts

- [x] 2.1 `proposal.md` — why, the six observable contract changes, what shipped did not close,
      non-goals.
- [x] 2.2 `design.md` — decisions D1–D11, deliberate invariants, and an honest Panel & review log
      recording that no panel or gate ran.
- [x] 2.3 Delta specs for all eleven affected capabilities under `specs/` (twelve requirement
      clusters — the client presence heartbeat had no owning capability and was added to
      `web-frontend-platform`).
- [x] 2.4 `openspec validate perf-audit-remediation --strict` passes. If the v1.6.0 CLI misbehaves,
      record what it reported and verify the structure by hand.

## 3. Documentation corrections — the baseline's normative companions

The freeze spec makes the README endpoint table normative, so these are part of making the record
true, not cosmetic follow-ups. **Done 2026-08-14, after the gate.**

- [x] 3.1 `README.md` endpoint table: add `GET /api/shows/:showId` (the route is currently served
      but outside the published inventory). Also update the router-map line for `shows.ts`.
- [x] 3.2 `README.md`: document that `/api/*` responses are content-encoding negotiated
      (`Content-Encoding: gzip` over 1 KB, `Vary: Accept-Encoding` on eligible responses), and
      that audio byte serving, SSE, and WS upgrades are excluded. The Companion operator notes
      walk a proxy operator through `/api/companion/*` without mentioning negotiation.
- [x] 3.3 `README.md` fonts paragraph is FALSE as written: Oswald and Chivo Mono are deleted,
      Inter and League Gothic latin now live under `web/public/static/fonts/`, and Inter is one
      variable face rather than three weights.
- [x] 3.4 `README.md`: the auto-instruction prose claims the fields "round-trip through profile
      reads" and names `profile.shows[].categories[*]`, which no longer exists.
- [x] 3.5 `README.md` source tree: add `server/src/compressibleTypes.ts` (and, pre-existing and
      also missing, `upgradeDispatch.ts`); describe `app.ts` as carrying the compression pair.
- [x] 3.6 `README.md` frontend section: record route-splitting, the chunk-load boundary, the
      virtualized event feed, the draft store, the worker-clock presence heartbeat, the
      queue-scoped leave warning, and the deferred transcript-words gate.
- [x] 3.7 `CLAUDE.md`: note that frontend assets now also live under `web/public/static/fonts/`,
      and that the new modules exist (`utils/draftStore.ts`, `shared/utils/workerInterval.ts`,
      `ChunkLoadBoundary.tsx`, `RouteLoadingState.tsx`, `CreateTeamForm.tsx`,
      `TranscriptWordsGateContext.tsx`, `api/hooks/useShows.ts`).
- [x] 3.8 Correct the stale boundary count in the shipped code comments. **This task was
      mis-stated when written**: it named two files, but `AppShell.tsx` carries no count or
      enumeration at all — both clauses ("five surfaces behind `React.lazy`" and "the workspace,
      TeamsRoute, and three modals + settings") are one sentence in `ChunkLoadBoundary.tsx`, and
      only the total "five" was wrong; "three modals + settings" is four modals, which is right.
      Fixed the one real site; `AppShell.tsx` left untouched rather than inventing a defect.
- [x] 3.9 Verify no doc edit contradicts a delta spec written in phase 2.
- [x] 3.10 **Found while doing 3.3, outside this change's blast radius:** the same fonts sentence
      also claimed `animate.css` is vendored under `web/src/assets/`. It is not — it was deleted
      in `6e880cd` (2026-07-27), well before the perf branch. Dropped rather than left standing.

## 4. Supersede and archive

- [x] 4.1 Mark `openspec/changes/web-boot-split-boundaries` superseded by this change: it proposed
      exactly the bundle split that shipped, its predicted byte table was close on the "before"
      figure (0.6%) and 4.1% pessimistic on the "after", and its panel predicted the
      `TeamsRoute`-pinning defect the implementation independently rediscovered. Carry its risk
      list forward as verification evidence (already done in `proposal.md`) rather than
      discarding it. **Done** — the supersede header is on the draft, dated and naming this
      change; only the archive move (4.2) remains.
- [x] 4.2 Archive `web-boot-split-boundaries` **by hand** — see 4.4.
- [x] 4.3 Owner gate on this change's artifacts. **This is the blocking step**; the baseline stays
      false until it clears, which is the deliberate cost of having shipped first.
- [x] 4.4 Archive this change **by hand**: move to `openspec/changes/archive/2026-08-14-perf-audit-remediation/`
      and merge each delta into `openspec/specs/<capability>/spec.md` manually. Do NOT use
      `openspec archive` — the installed CLI is v1.6.0, whose sync corrupts specs.
- [x] 4.5 Post-archive: re-read each touched baseline spec end to end for internal contradictions
      introduced by the merge of deltas (the post-gate consistency read `design.md` records as
      owed).
- [x] 4.6 Gates proportional to what the archive moves: this is a docs/spec-only change, so
      `npm test` and `npm run typecheck` are run to confirm the doc edits broke nothing, and
      `npm run e2e` is skipped — no runtime surface is touched by phases 2–4. Record the skip.

## 5. NOT owned by this change — follow-ups

Recorded so they are not lost. Each needs its own change; the first two are user-visible
regressions this branch introduced.

- [ ] 5.1 **No busy affordance during a cold chunk fetch.** Clicking New Session or Batch Import
      on a cold chunk shows nothing for the duration; on mobile the rail closes first, so the tap
      reads as consumed and discarded. Only 2 of 6 boundaries are warmed. The panel prescribed
      "`null` fallback *plus* a busy affordance on the invoking control" — only the first half
      shipped.
- [ ] 5.2 **No cancellation across the async gap.** A pending overlay can land after the user has
      navigated away.
- [ ] 5.3 **`WorkspaceStatic` has no characterization test.** The seam was reshaped from its
      consumer side and every test that touches it mocks it away, so the real `memo()` is
      exercised nowhere. Violates the generic untested-seam rule in `openspec/config.yaml`, not
      `core-ports-architecture`'s server-scoped requirement of the same name — no baseline
      scenario is failing, but the discipline was skipped.
- [ ] 5.4 **The bundle measurement is not reproducible.** No script or guard records the island
      chunk set; Next's own First Load JS table is blind to this class of change.
- [ ] 5.5 **`sync-from-disk` has no captured fixture** while the client consumes its body with a
      typed `apiFetch`, on an exemption whose premise expired when the shape reached `main`.
- [ ] 5.6 Pre-existing, surfaced during the loop: `useProfile` has no failure or paused branch in
      the settings modal, and react-query pauses *mutations* offline, so Save can hang
      indefinitely on "Saving…".
- [ ] 5.7 **Undecided, needs a ruling.** `EventLogSheet`'s pagination sentinel gained a second
      stop condition (`events.length >= fetchedEvents.length`), which changes when the feed stops
      growing its loaded page on sessions larger than `WORKSPACE_EVENTS_LIMIT`. No baseline
      requirement owns feed pagination, so this is either an unremarkable implementation detail
      or an unspecified observable change — decide which, and if the latter, it needs a
      requirement rather than a follow-up.
