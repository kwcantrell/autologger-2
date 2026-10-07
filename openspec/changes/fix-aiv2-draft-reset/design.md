# Design

## Context

See proposal.md for why. `AiV2Design` is controlled: `pendingQuestion` comes in as a prop, set by
the parent from the SSE reader's `question` frame. The draft state (`draftAnswers`,
`freeTextInputs`) is local state. Today a `useEffect` on `[pendingQuestion?.requestId]` resets it.

## Decisions

### D1. Derive the reset from a `requestId`-tagged draft

One state value, `{ requestId, answers, freeText }`. On render, `draftAnswers` and
`freeTextInputs` are `draft.answers` and `draft.freeText` when
`draft.requestId === pendingQuestion?.requestId`, and `{}` otherwise. Each write records the
current `requestId`. The free-text updater drops the old answers and free text when the tagged
`requestId` is stale. The reset `useEffect` is removed.

*Alternative: `key={requestId}` on a child that owns the draft state.* That would also reset by
remount, but it means splitting the question view out of `AiV2Design` and moving `answerQuestion`
and `submitAnswers`. That's a bigger diff for the same result.

*Alternative: fix only the test (wait for effects before clicking).* Rejected. The component
behavior is the bug. A real click can land in the same gap, rarely.

### D2. Test-first with a deterministic reproduction

The new test mounts `AiV2Design` on a raw `createRoot`, with `IS_REACT_ACT_ENVIRONMENT` off for
that test only and restored in `finally`. It renders the question with `root.render`, on the
default lane, and clicks the second option from a `MutationObserver` callback, after commit and
before the passive effect flushes. It then expects that option to be `aria-pressed="true"`.

## Assumptions

| Assumption | Command | Observed |
| --- | --- | --- |
| The race is real and reproducible | Throwaway `zzRaceProbe.test.tsx` (D2's construction): `npx vitest run src/pages/index/components/zzRaceProbe.test.tsx` x5, in `web/` | `Expected: "true" Received: "false"`, `Tests 1 failed (1)` 5/5 |
| `flushSync`/`act` don't reproduce it | Same probe using `act` + `flushSync(rerender)`, then a raw root with `flushSync` | `Tests 1 passed (1)` 3/3 each: sync-lane renders flush passive effects at commit |
| D1 fixes it without breaking the file | D1 applied temporarily: probe x3, then `npx vitest run src/pages/index/components/AiV2Design.test.tsx` | Probe `Tests 1 passed (1)` 3/3; `Tests 20 passed (20)`. Reverted afterwards (`git status --short` -> 0 lines) |
| The CI failure is this race | `gh run view 37611786279 --log` | `AiV2Design.test.tsx:382` `waitFor` on `aria-pressed` -> `Expected "true" Received "false"`; same in 37611085485 and 37422924436 |
| React version | `grep '"version"' node_modules/react/package.json` | `19.2.7` |

## Risks / Trade-offs

- [A stale draft could leak into a new question's submission] → `answerQuestion` builds `next`
  from the derived `draftAnswers`, which is `{}` for a new `requestId`. The new carry-over test
  covers this.
- [The test toggles `IS_REACT_ACT_ENVIRONMENT`] → scoped to one test and restored in `finally`.
  The root is unmounted and the container removed.
