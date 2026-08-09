## Why

`web/` importing the `@autologger/*` package graph is **completely unguarded**, and the question of
whether it may has been deferred through five changes without ever being decided.

**Demonstrated, not argued:** a production `web/src → packages/domain` relative import was planted
and every gate passed — `webBoundaries.repo.test.ts` (the web guard, shipped 2026-08-08),
`packageBoundaries.repo.test.ts` (which flags only the *package → web* direction), and
`tsc --noEmit -p web`. Probe reverted.

Meanwhile the deferral has physical residue. `web/src/pages/index/components/aiV2/clientAggregates.ts`
(254 lines) hand-mirrors `packages/ai-runtime/src/aggregates.ts` (241 lines) field-for-field, kept
honest only by a pinning test that reaches six directory levels up. Its header still justifies the
mirror partly on loosening Vite's `server.fs.allow` — which is **dead**: packages resolve through a
`node_modules` symlink (`@autologger/ai-runtime -> ../../packages/ai-runtime`), verified.

The deferral chain: step 1 left "may `web/` share server-side types" open; step 3
(`router-directory-decomposition` E2) parked a placement decision on the grounds that *"only step 5
can determine"* it; step 4b moved `aggregates.ts` into a package and recorded re-pointing the test's
path as **non-precedential**; step 5 then declined the web split, so nobody ever answered. Five
changes, no decision, one orphaned mirror, and a direction no check covers.

## What Changes

- **`web/` does not import the package graph.** Production files under `web/src` SHALL NOT import
  from `packages/`, by relative path or by `@autologger/*` specifier. The hand-mirror is **permanent
  policy**, not a provisional workaround.
- **The rule is enforced** by extending `webBoundaries.repo.test.ts` — the existing web import guard,
  already AST-based with a non-vacuity assertion and a mutation pair. Scoped to **production** files:
  the pinning test's test-only dynamic import stays permitted, the same carve-out shape that guard
  already applies to type-only edges.
- **`clientAggregates.ts`'s header is corrected** — the dead `server.fs.allow` justification is
  replaced with the surviving one (`aggregates.ts`'s parameter types come from
  `@autologger/session-core`, an L1 package with a `better-sqlite3` peerDependency), and the mirror
  is marked permanent so the next reader does not re-open a settled question.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-coordination-seam`: its existing requirement **"The web app's internal import direction is
  mechanically enforced"** gains the cross-workspace direction. That requirement already governs
  web's import direction and is already backed by `webBoundaries.repo.test.ts`.

  **A correction to this change's own framing, recorded rather than quietly fixed:** the
  recommendation that opened this change said the rule should land as "one line in the
  `package-architecture` baseline." Measurement showed that is the wrong home — every requirement
  there is package-centric (line 28 reads "no package SHALL import from `server/src` or `web/src`"),
  so a rule about what *web* may do does not belong to it.

## Impact

**Contract impact: none.** No HTTP route, JSON shape, status code, export body, header/range
semantic, or WebSocket message shape or emission semantic is touched. No production behavior
changes — the rule forbids something nothing currently does.

| target | change |
|---|---|
| `web/src/webBoundaries.repo.test.ts` | the cross-workspace rule + its mutation pair |
| `web/src/pages/index/components/aiV2/clientAggregates.ts` | header correction (comment only) |
| `openspec/specs/web-coordination-seam/` (delta) | one MODIFIED requirement |

**Gates skipped, declared not assumed:** `npm run e2e` and `npm run e2e:visual` — no runtime
behavior is touched; the only non-test edit is a comment. `npm run typecheck`, `npm test`,
`npm run lint`, `npm run docs:check` all run.

## Non-Goals

- **Retiring the mirror.** Splitting `packages/session-core`'s three row DTOs out to L0, moving
  `aggregates.ts` a *second* time, and deleting `clientAggregates.ts` would buy −254 LOC that a
  passing pinning test already guards, at the cost of surgery on three L1 files and a move step 4b
  already priced. Declined on that arithmetic, not deferred for want of an answer.
- **Deciding whether `web/` may import L0 specifically.** The rule is flat: no package imports from
  `web/` production code. A narrower "L0 only" rule would need a consumer to justify it, and there
  is exactly one candidate — measured: the *only* `web/src → packages/` reach in the entire tree is
  the pinning test's two lines.
- **Step 1's `api/types.ts` ruling.** Measurement found it has **no durable home** — it exists only
  in an archived design, not in any baseline. That is a real gap, adjacent to this one (it concerns
  wire types, not package imports), and is left for a change that can evaluate it.
- **Any runtime code change.**

## Reversal condition

If a **second** web-side consumer of package code appears, the arithmetic behind both the flat rule
and the declined refactor changes, and this decision should be revisited rather than treated as
settled.
