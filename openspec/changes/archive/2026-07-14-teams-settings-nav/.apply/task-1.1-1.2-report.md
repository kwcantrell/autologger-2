# Phase 1 (tasks 1.1, 1.2) — implementer report

Unit: `teams-settings-nav` tasks 1.1 (category round-trip fix, both directions + type
split) and 1.2 (`['show-categories']` invalidation on save, design D4). Branch:
`teams-settings-nav`. Commit: `2ca5b1d` — "fix(web): round-trip show categories via
name key, invalidate show-categories on save".

## What was implemented

### 1.1 — category round-trip fix

- **`web/src/api/types.ts`**: added `ShowCategory` (name-keyed, `label` optional/defensive)
  and repointed `Show.categories` and `ShowUpdateEntry.categories` to it, leaving the
  existing `Category` (label-keyed) type unchanged for `ProfilePayload.active_studio`,
  `ShowCategoriesResponse`, and `EventLogRow` — the events/Companion/`active_studio` read
  surfaces that legitimately go through the server's `showCategoriesApiShape` label
  mapping (verified in `server/src/routers/events.ts`, `server/src/routers/companion.ts`).
- **`web/src/pages/index/components/HomeSettingsModal.tsx`**:
  - `showToShowDraft`: `name: c.label ?? ''` → `name: c.name ?? c.label ?? ''`.
  - `handleSave`'s `show_updates[].categories` mapping: `label: c.name` → `name: c.name`.
- **`web/src/pages/index/components/EventButtonsTable.tsx`**:
  - `copyFromShow`: `name: c.label ?? ''` → `name: c.name ?? c.label ?? ''`.

### 1.2 — `['show-categories']` invalidation

- **`HomeSettingsModal.tsx`** `handleSave`: added
  `queryClient.invalidateQueries({ queryKey: ['show-categories'] })` alongside the
  existing `['events']`/`['session-status']` invalidations.

## Files changed

- `web/src/api/types.ts`
- `web/src/pages/index/components/HomeSettingsModal.tsx`
- `web/src/pages/index/components/HomeSettingsModal.test.tsx`
- `web/src/pages/index/components/EventButtonsTable.tsx`
- `web/src/pages/index/components/EventButtonsTable.test.tsx` (new)

No server files touched (frozen contract, as required). Left the untracked
`server/src/node/audioMerge.*`, `server/scripts/`, `server/src/test/fixtures/`,
`package-lock.json`, `server/package.json`, `server/tsconfig.json`, and
`openspec/changes/deepgram-transcription/` alone — none of these were staged or
committed (verified via `git status --short` before and after `git add`, listing only
the 5 files above under this unit's commit).

## TDD evidence

### RED (before the fix, tests already written)

Command: `npx vitest run src/pages/index/components/HomeSettingsModal.test.tsx
src/pages/index/components/EventButtonsTable.test.tsx` (run from `web/`)

```
 × copies category names from a name-keyed source show 177ms
 × hydrates existing category names (non-blank) from a name-keyed show 30ms
 × posts categories whose entries carry name (task 1.1b) 25ms
 × invalidates the show-categories query on save (D4) 1018ms

FAIL EventButtonsTable.test.tsx > EventButtonsTable.copyFromShow > copies category
names from a name-keyed source show
AssertionError: expected { …(7) } to match object { name: 'Break' }

FAIL HomeSettingsModal.test.tsx > HomeSettingsModal category round-trip > hydrates
existing category names (non-blank) from a name-keyed show
(getByText('Roll Call') not found — mock rendered "(blank)")

FAIL HomeSettingsModal.test.tsx > HomeSettingsModal category round-trip > posts
categories whose entries carry name (task 1.1b)
AssertionError: expected { id: 'cat-1', label: '', …(5) } to deeply equal
{ Object (id, name, ...) }

FAIL HomeSettingsModal.test.tsx > HomeSettingsModal category round-trip > invalidates
the show-categories query on save (D4)
AssertionError: expected "vi.fn()" to be called with arguments:
[ { queryKey: [ 'show-categories' ] } ]

Test Files  2 failed (2)
     Tests  4 failed | 2 passed (6)
```

The 2 passing tests were the pre-existing studio-switch pins (unaffected by this unit),
confirming the new-test scaffolding (mocks, fixtures) didn't break anything already
green.

### GREEN (after the fix)

Same command:

```
Test Files  2 passed (2)
     Tests  6 passed (6)
```

## Full gate run (post-fix)

- `npm run typecheck` — clean across server, web, companion, e2e workspaces (no output
  beyond the `tsc --noEmit` invocations, exit 0).
- `npm test` — `server`: 47 files / 338 tests passed. `web`: 17 files / 161 tests
  passed. `companion`: 6 files / 20 tests passed.
- `npm run lint` (root, covers `web/src` + `e2e`): 4 pre-existing warnings in
  `web/src/shared/utils/loadingVideo.ts` (unrelated `useOptionalChain` suggestions, not
  touched by this unit). Ran `npx biome check` scoped to the 5 changed files directly:
  "Checked 5 files in 13ms. No fixes applied." — zero findings in this unit's files.

## Design notes / decisions made while implementing

- **Test-fixture rule enforcement**: every fixture category object in both test files is
  deliberately `name`-keyed with **no `label` key present**, matching the task's
  explicit caution ("a `label`-keyed fixture passes against broken code"). Confirmed by
  RED run: fixtures with a `label` key would have papered over the `c.label ?? ''` bug.
- **`ShowCategory.label` typed optional (not omitted)**: the fix keeps
  `c.name ?? c.label ?? ''` as literal code per D3's "deliberate" defensive fallback. For
  that line to typecheck, `label` had to exist as an optional field on `ShowCategory`
  (rather than being absent entirely) — `name` stays required since it's the real wire
  guarantee.
- **`invalidateQueries` mock rework**: the pre-existing test mocked
  `@tanstack/react-query`'s `useQueryClient` as `() => ({ invalidateQueries: vi.fn() })`
  — a **fresh** `vi.fn()` on every hook call (i.e. every render), making it impossible to
  assert on calls made during a specific render pass. Replaced with a `vi.hoisted()`
  module-level `invalidateQueriesMock` shared across all `useQueryClient()` calls, then
  asserted `toHaveBeenCalledWith({ queryKey: ['show-categories'] })`. This was necessary
  to pin 1.2's invalidation at all, not just a style choice.
- **`toBeInTheDocument` not available**: this repo's web vitest tier doesn't extend Chai
  with jest-dom matchers (confirmed via grep — no other test file uses it). Switched the
  hydration test to the repo's existing convention (`.not.toBeNull()` /
  `.toBeNull()` on `getByText`/`queryByText`), matching `TeamsRoute.test.tsx` and
  `SessionRoute.test.tsx`.
- **`EventButtonsTable.test.tsx` avoids Radix Select interaction complexity**: mocked
  `./Select` to a native `<select>` (same idiom `HomeSettingsModal.test.tsx` already
  uses for the same component) rather than driving the real Radix popover in jsdom.
  `buttons: []` was passed so no table rows render, sidestepping the need to also mock
  `Popover`/`RadioGroup`/`Tooltip` (only used per-row).
- **Single commit for both 1.1 and 1.2**: the two tasks share the same file
  (`HomeSettingsModal.tsx`/`.test.tsx`) with tightly-coupled hunks (the invalidation test
  lives in the same new `describe` block as the 1.1 tests, and shipping the category fix
  without the invalidation would immediately reintroduce a stale-button bug). Committed
  as one unit rather than force-splitting via partial hunk staging, consistent with this
  being dispatched as one unit.

## Self-review findings

- Re-read the final diff (`git show HEAD`) end to end: the `ShowCategory`/`Category`
  split lands exactly where D3 specifies (read/request `shows[].categories` vs.
  events/Companion/`active_studio`); no other `Category[]` usage sites were missed
  (verified via `grep -rn "Category\[\]" web/src`, all three remaining sites —
  `active_studio`, `ShowCategoriesResponse`, `EventLogRow` — are correctly on the
  label-keyed server shapes).
- Verified no server files were touched (`git show --stat HEAD` lists only `web/` files).
- Verified the pre-existing studio-switch tests in `HomeSettingsModal.test.tsx` still
  pass unmodified (they use `shows: []`, so `currentDraft` is `undefined` and the
  `EventButtonsTable` mock rework — which only changes what the mock renders when given
  buttons — never activates for them).
- No known concerns going into Phase 2 (AppShell/SessionRoute/TeamsRoute lift), which
  this unit deliberately did not touch per the dispatch instructions.
