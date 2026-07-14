# Task 2.2 report — RootGate gate-state tests

Branch: `session-deep-links`. Commit: `937b522` — `test(web): RootGate gate-state
tests (add-login-screen residual paydown)`.

## Files

- `web/src/pages/index/RootGate.test.tsx` (new) — the test suite.
- `web/src/test/setup.ts` (new) — vitest `setupFiles` entry wiring up
  `@testing-library/react`'s `cleanup()` in `afterEach`.
- `web/vitest.config.ts` (tiny tweak) — added `test.setupFiles: ['./src/test/setup.ts']`.

## Why the setup.ts addition

Running the suite without it: 4 of 9 tests failed with
`getMultipleElementsFoundError` — DOM nodes from earlier tests' `render()`
calls were still in `document.body` when later tests queried by testid/role.
`@testing-library/react`'s automatic cleanup only self-registers when it
detects a global `afterEach` (checks `typeof afterEach === 'function'` on
`globalThis`); this workspace's `vitest.config.ts` doesn't set
`test.globals: true` (tests import `afterEach`/`describe`/`it` explicitly
from `'vitest'` instead), so auto-cleanup never wired itself up. This wasn't
caught by task 2.1's Toast test because that file renders exactly once.
Any future multi-render test file in the tier (tasks 3.3, 4.3, 5.2, 6.4 all
plan multi-state/rerender tests) would hit the same failure, so the fix
went into the shared tier config rather than a local `afterEach(cleanup)`
in just this file.

## States covered

1. No data + pending (`isFetching: true`) → `#root-gate-loading` present,
   `#root-gate-error` absent, no AppShell/LoginPage sentinel.
2. No data + error → `#root-gate-error` present, retry button enabled,
   clicking it calls `refetch` once.
3. Retry button disables while `isFetching: true` (separate test, asserted
   via `rerender` from `isFetching: false` → `true` on an errored query) —
   button text also flips to "Retrying…" (matches the component's own label
   swap, used as the accessible name for the query).
4. `oauth_configured: true, logged_in: false` → LoginPage sentinel, no
   AppShell sentinel.
5. `oauth_configured: true, logged_in: true` → AppShell sentinel, no
   LoginPage sentinel.
6. `oauth_configured: false, logged_in: false` (dev anonymous mode) →
   AppShell sentinel — confirms the `&&` gate, not just the logged-in path.
7. Data-first branch: data present (logged in) + `isError: true` (background
   refetch failure) → still AppShell, `#root-gate-error` absent.
8. Mid-session sign-out: `rerender` from logged-in data to
   `{oauth_configured: true, logged_in: false}` data → flips AppShell
   sentinel out, LoginPage sentinel in.

8 `it()` blocks in the file (scenarios 2 and 3 above are split into two
separate cases — retry-click and retry-disables-while-fetching — for
clarity).

## Mocking approach

- `vi.mock('../../api/hooks/useProfile', () => ({ useProfile: vi.fn() }))`,
  then `vi.mocked(useProfile).mockReturnValue(...)` per test/rerender —
  no react-query, no network. A `profileQuery()` helper builds the
  `{ data, isError, isFetching, refetch }` shape RootGate destructures; a
  `profilePayload()` helper builds a full `ProfilePayload` fixture with an
  `auth` overrides param.
- `vi.mock('./AppShell', ...)` and `vi.mock('./components/LoginPage', ...)`
  replace both with `<div data-testid="…-sentinel" />` — both real
  components pull in react-query hooks / image assets that would turn this
  into an integration test.
- All renders go through the existing `renderStrict()` helper (StrictMode),
  per design D8.

## Verification

`npm run typecheck` (server + web + companion + e2e): green.

`npm test` tail:

```
> autologger-server@0.0.0 test — Test Files 43 passed (43); Tests 252 passed (252)
> autologger-web@0.0.0 test    — Test Files 2 passed (2);   Tests 9 passed (9)
> companion-module-autologger@0.1.0 test — Test Files 6 passed (6); Tests 20 passed (20)
```

Web tier jumped from 1 test (Toast, task 2.1) to 9 (1 Toast + 8 RootGate).

## Concerns

None blocking. Note for future tasks in this change: the `setup.ts` fix is
now load-bearing for every subsequent multi-render test file (3.3, 4.3, 5.2,
6.4) — no action needed, just flagging why it exists here rather than being
introduced later.
