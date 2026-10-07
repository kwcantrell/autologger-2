# Keep an AI v2 option selection made right after a question arrives

Tier: 1
Tier reason: a bug fix inside one web component (`AiV2Design.tsx`) and its tests. No contract, spec requirement or high-risk path changes.
Panel: waived by the owner (2026-10-07).

Approved-by: Kalen 2026-10-7

## Why

`AiV2Design` clears the draft answers for a new question in a `useEffect` keyed on
`pendingQuestion.requestId`. That effect runs after the question cards have rendered. A click on
an option can land in between, after the cards are on screen but before the effect runs. The
effect then wipes the selection: the click's update and the reset are queued together, and the
reset is applied last.

That's why `AiV2Design.test.tsx:382` ("keys the pressed option by its index") fails at random in
CI with `Expected "true" / Received "false"`. It failed in run 37422924436 (`shadcn-foundation`,
2026-10-06), the post-merge run 37611085485 and archive PR #84's run 37611786279. It passed on the
identical tree in three other runs. A throwaway probe reproduces it 5/5. The probe renders the
question on React's default lane (as the SSE reader does) and clicks from a `MutationObserver`
callback, right after commit and before the passive effect.

## What Changes

- **`web/src/pages/index/components/AiV2Design.tsx`.** The draft answers and free-text inputs move
  into one state value that records the `requestId` they belong to. While rendering, a draft whose
  `requestId` doesn't match the current pending question counts as empty, and the reset
  `useEffect` is removed. A new question still starts with a clean draft, as the removed effect's
  comment intends. The reset now happens during render, so no click can fall between the reset
  and the question appearing.
- **`web/src/pages/index/components/AiV2Design.test.tsx`.** New test: a selection made right
  after a new question commits, before passive effects run, stays pressed. It fails every time on
  the current code (the probe above, made permanent). Also a test that a draft from an earlier
  question doesn't carry over to a new `requestId`, so the existing reset behavior stays covered
  once the effect is gone.

The POSTed answer shape, the `optionIndex` stripping and the one-answer-per-question batching don't
change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. The `ai-v2-dashboards` requirement "Design question round trip" covers the server round
trip, not the client's draft state. `skip_specs: true`.

## Non-goals

- Other effects in `AiV2Design` (`pendingStart` and the rest), or a general audit of
  reset-in-effect patterns elsewhere in `web/`.
- Changing the existing test at line 382 beyond what the fix needs. It should pass reliably once
  the race is gone.
- Any server or contract change.

## Impact

- `web/src/pages/index/components/AiV2Design.tsx` and `AiV2Design.test.tsx` only.
- Unblocks `gates` on PR #84 and on any other PR that hits this flaky test.
