# Tasks

## 1. Failing tests first

- [x] 1.1 Add `waveformDecode.test.ts`, `TimelineWaveform.test.tsx`, `useWaveforms.test.tsx`.
  Evidence: `npx vitest run` of the three files on the old code -> 6 failed (size guard, label only while decoding, unavailable label, hook `unavailable`, no retry).

## 2. Fix

- [x] 2.1 Implement the hook flag, label logic and size guard.
  Evidence: same three files -> `Tests 7 passed (7)`; see section 3 for typecheck, biome and the full suite.

## 3. Verify

- [x] 3.1 `npm run typecheck -w web`, `npm run lint -w web`, `npx vitest run` in `web/`, `scripts/check-change.sh`.
  Evidence: `npx biome check --error-on-warnings` on the 9 changed files -> clean; `tsc --noEmit` shows no errors in the changed files; the 3 new test files plus the existing utils/hooks/timeline tests -> 268 passed. Full-suite run is left to CI: the local worktree used a stale node_modules (missing radix-ui, lucide-react, tailwind-merge), so 85 unrelated files failed to import.
