# Tasks

The first commit on this branch is `openspec/changes/fix-aiv2-draft-reset/` only (AGENTS.md rule 6).
Tests run as the single file locally (`npx vitest run src/pages/index/components/AiV2Design.test.tsx`
in `web/`). The full suite runs in CI on the PR.

## 1. Failing tests first

- [ ] 1.1 Add the D2 test to `AiV2Design.test.tsx`: a selection made right after a new question
  commits (default-lane render, click from a `MutationObserver` callback) stays
  `aria-pressed="true"`. Check: on the current code it fails with `Expected "true" Received
  "false"`.
- [ ] 1.2 Add a test that a draft from one question doesn't carry over to a new `requestId`:
  select an option on question A, rerender with question B (new `requestId`, same shape), and
  B's options are all `aria-pressed="false"`. Check: it passes on the current code (the effect
  covers it) and must still pass after 2.1.

## 2. Fix

- [ ] 2.1 Apply D1 in `AiV2Design.tsx`: one `{ requestId, answers, freeText }` state value, derived
  on render, with the reset `useEffect` and its biome-ignore removed. Check: in `web/`,
  `npx vitest run src/pages/index/components/AiV2Design.test.tsx` passes, including 1.1 and 1.2,
  on 3 consecutive runs. `npx biome check --error-on-warnings src/pages/index/components/AiV2Design.tsx src/pages/index/components/AiV2Design.test.tsx`
  is clean, and `npm run typecheck -w web` passes.

## 3. Verify

- [ ] 3.1 `scripts/check-change.sh --stage hook` passes (DB tests skip locally).
- [ ] 3.2 The PR's CI run: `gates`' `commands` passes, so the web suite including
  `AiV2Design.test.tsx` is green.
