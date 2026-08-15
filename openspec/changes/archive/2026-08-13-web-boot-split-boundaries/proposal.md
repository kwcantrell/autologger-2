# Proposal: web-boot-split-boundaries (SUPERSEDED 2026-08-14 — never gated, work shipped elsewhere)

> **SUPERSEDED by `perf-audit-remediation`.** The work this draft proposes was implemented and
> merged on 2026-08-14 (branch `perf-fixes`, merge `64593f7`) outside the OpenSpec process, at the
> owner's direction. It shipped the same six boundaries this draft names. The byte table below
> proved close on its "before" figure and slightly pessimistic on its "after": 578,258 B →
> 227,295 B predicted here, against 581,762 B → 218,401 B measured (0.6% and 4.1% respectively —
> the split did marginally better than this scratch build suggested). This draft's panel also predicted the `TeamsRoute` defect —
> "**`TeamsRoute` 0 B — webpack created no chunk at all**" — whose cause (`OnboardingPanel`
> statically importing `CreateTeamForm` from `TeamsRoute.tsx`) the implementation independently
> rediscovered and fixed by extracting the shared leaf.
>
> **This file is retained, not deleted, because its risk list is the only pre-implementation
> analysis of this work that exists.** Three of its eight required mitigations are still open or
> unverifiable in the shipped tree — the missing busy affordance, the absent cancellation, and the
> uncharacterized `WorkspaceStatic` seam — and they are carried forward as tracked follow-ups in
> `perf-audit-remediation`'s `tasks.md` §5 rather than being lost with the draft.
>
> Original status line: draft proposal only — not fact-checked, not paneled, not gated. Queued by
> the `settings-modal-mount-cost` gate's "two changes, not one" ruling. Remaining artifacts
> (spec/design/tasks) were deliberately never drafted. **When picked up, the measured audit was to
> run FIRST and select the boundary list** (gate ruling 2026-08-13) — the numbers below are carried
> evidence, and were in fact re-verified by measurement during the work that superseded this.

## Why

Every component below the index island is statically imported. `web/` has exactly one in-tree
deferred module today — `BatchImportModal` pulls `batchImport/logImportClient` through an
`await import()` inside its submit handler — and otherwise splits only at the island wrappers
(`app/(index)/IndexIsland.tsx`, `app/(admin)/AdminIsland.tsx`). A user sitting on `/` downloads,
parses, and evaluates the session workspace, AI, timeline, recorder, and batch-import clusters
that route cannot reach.

A panel reviewer measured the ceiling by building all six candidate boundaries in a scratch tree
and running a real production build at `main` @ `3eaca8f`:

| | raw | gzip |
| --- | --- | --- |
| index boot chunk set, before | 578,258 B | 173,422 B |
| after six boundaries | 227,295 B | 74,789 B |
| **Δ** | **−350,963 B (−60.7%)** | **−98,633 B (−56.9%)** |

Per seam: `SessionWorkspace` 262,834 B (74.9%), `HomeSettingsModal` 48,591 B (13.8%),
`BatchImportModal` 16,500 B (4.7%), `NewSessionModal` 11,084 B (3.2%), `YouTubeImportErrorModal`
1,558 B (0.4%), **`TeamsRoute` 0 B — webpack created no chunk at all**. Two boundaries carry
88.7%. Over loopback the fetch is free, but the parse/compile/evaluate cost is not, and the server
sets no `Content-Encoding`, so raw bytes are the right proxy.

**These numbers are carried evidence from a scratch build, not a verified baseline.** Re-measure
before relying on them.

## What Changes

To be drafted when picked up. The shape the gate expects: run the measured per-seam audit first,
publish the byte table, let it select the boundary list, then implement only the boundaries that
earn their seam — plus the risk mitigations below, which are not optional.

## Known risk surface (from the 2026-08-13 panel — all independently verified)

Any drafting of this change must close these; they are the reason it was split out rather than
shipped alongside the settings fix.

- **A failed chunk fetch is currently fatal and unrecoverable.** There is **no error boundary
  anywhere in `web/src`** and no `error.page.tsx` in `web/src/app/`. React caches a `lazy`
  rejection permanently (the loader is never re-invoked), so a rejected `import()` propagates to
  Next's built-in global error page and replaces the whole document. Concrete path: an operator
  re-runs `npm run build && npm run start` while a tablet has the app open mid-recording —
  content-hashed chunk URLs 404, the tree unmounts, and `AudioRecorder`'s `beforeunload` guard
  never fires because there is no unload. Today's static imports cannot fail this way; this change
  *creates* the failure class and must close it.
- **The test tier exercises a different `next/dynamic` than production.** App Router aliases it
  (`next/dist/build/create-compiler-aliases.js:226` → `next/dist/api/app-dynamic` →
  `React.lazy` + `Suspense`): no `.preload()`, no `.retry()`, `error` hardcoded `null`. Vitest
  resolves the react-loadable implementation, which has all three. So a `.preload()`-based warming
  layer would pass tests and be `undefined` in production, and a spike gated on `npm test -w web`
  proves nothing about shipped behavior. Gate the spike on a real build.
- **Overlay boundaries render their fallback inline in `<main>`.** `HomeSettingsModal`,
  `NewSessionModal`, `BatchImportModal`, and `YouTubeImportErrorModal` sit at `AppShell.tsx:289+`,
  in the document flow — a `loading` element paints as stray content above the route, not as an
  overlay. The correct fallback for an overlay is `null` plus a busy affordance on the invoking
  control; the correct fallback for `SessionWorkspace`/`TeamsRoute` is a real surface. A blanket
  "every boundary renders a fallback" requirement gets this backwards.
- **The obvious measurement instrument is blind to this change.** Next computes the build table's
  First Load JS from the page's static entry chunks only, and every candidate boundary lives
  *inside* the already-dynamic `IndexRoot` chunk. That table will be byte-identical whether the
  change succeeds or does nothing. Measure the chunk set reachable from the island entry (e.g.
  `.next/react-loadable-manifest.json`) instead.
- **Warming returns most of what splitting deferred.** The union of the chunks a settings+workspace
  warm would pull is ~96% of the deferred bytes. That is still a real win — it is *scheduling*,
  moving work off the critical path into idle — but it must be claimed as scheduling, and measured
  as time-to-interactive rather than as bytes removed.
- **Focus and cancellation across the async gap.** A deferred overlay mounts after the click, so
  Radix captures its focus-restore target late (on mobile the rail closes first, leaving
  `<body>`), and there is no way to cancel a pending open — the modal can appear after the user has
  navigated away. Resolving the module *before* flipping the open flag avoids both.
- **`SessionWorkspace`'s coordination-handle registration** is unregistered during the load window;
  verify against `pages/index/coordination/registry.ts` what an absent handle does.
- **`WorkspaceStatic` has no test of its own** — it needs a characterization test before it is
  reshaped, per the repo's untested-seam rule.

## Non-Goals

- The six session-workspace feed panels stay mounted with visibility toggled
  (`web-session-console`, `ai-v2-dashboards`). A boundary on any of them individually would need
  an authorizing delta spec against both.
- The settings-modal mount cost — fixed separately by `settings-modal-mount-cost`.
