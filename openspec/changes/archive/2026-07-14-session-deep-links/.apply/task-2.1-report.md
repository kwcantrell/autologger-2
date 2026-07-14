# Task 2.1 report — web vitest tier bootstrap

Commit: `f537db0` — `test(web): bootstrap vitest tier (jsdom, testing-library, StrictMode render helper)`

## Config choices + why

- **`web/vitest.config.ts`** — new file, NOT `mergeConfig(viteConfig, ...)`.
  `web/vite.config.ts` carries the MPA `build.rollupOptions` (two HTML entries),
  the `tailwindcss()` vite plugin, and a dev-only `/api`+`/auth` proxy — none of
  which the test tier needs and all of which are pure overhead/noise to drag into
  every `vitest run`. Instead the config duplicates the two things tests actually
  need from the vite config: the `@vitejs/plugin-react` plugin (JSX transform,
  already a web devDependency) and the three `@/api` / `@/shared` / `@/pages`
  path aliases. A code comment in the file points back at `vite.config.ts` as the
  source of truth so the two don't silently drift.
- `test.include: ['src/**/*.test.{ts,tsx}']`, `test.environment: 'jsdom'`.
- No `setupFiles`, no global matcher library (`@testing-library/jest-dom` was
  deliberately NOT added — the proving test asserts on `.textContent` directly
  instead of a `toBeInTheDocument()` matcher, keeping deps minimal per D8's "test
  tier, not a coverage campaign"). Later tasks can add it if a state (2.2 RootGate,
  4.3 resolution states, etc.) genuinely needs matcher ergonomics.
- Mirrors the server/companion vitest-4 idiom (`server/vitest.config.ts`,
  `companion/vitest.config.ts`) — `defineConfig` from `vitest/config`, `test.include`
  glob, explicit `environment`. No workspace-file (vitest 4 dropped that in favor of
  `test.projects`, and web only needs one tier, unlike server's unit/integration
  split).

## Alias handling

Aliases are duplicated verbatim from `web/vite.config.ts` (`@/api`, `@/shared`,
`@/pages`, each `path.resolve(__dirname, 'src/...')`). Confirmed working:
`Toast.test.tsx` imports `../../test/renderStrict` via a relative path (the
`web/src/test/` helper directory isn't under any of the three aliases, which is
fine — it's not consumed by app code) and the app-side aliases resolve correctly
for anything under `src/api`, `src/shared`, `src/pages` that a future test imports.

## StrictMode helper shape

`web/src/test/renderStrict.tsx`:

```tsx
export function renderStrict(ui: React.ReactElement, options?: RenderOptions): RenderResult {
  return render(<StrictMode>{ui}</StrictMode>, options);
}
```

Thin wrapper around `@testing-library/react`'s `render()`, forwarding `options`
through. Colocated under `web/src/test/` (not `web/src/shared/`) since it's a test
utility, not app code. Every future component test (RootGate, resolution states,
stash tests per tasks 2.2/4.3/6.4) is expected to call this instead of `render()`
directly — that's the repo-wide convention this task establishes per D8's "test
renders run under StrictMode" line.

## Deps added

- `@testing-library/react@^16.3.2` (devDependency) — latest major; peer deps
  (`react`/`react-dom` `^18 || ^19`, `@types/react`/`@types/react-dom` `^18 || ^19`)
  confirmed compatible with the installed React 19. `@testing-library/dom` (its own
  peer, `^10.0.0`) resolves transitively — not added as a direct devDependency.
- `jsdom@^29.1.1` (devDependency) — required by vitest for `environment: 'jsdom'`;
  not bundled with vitest 4 itself.
- `vitest@^4.1.10` (devDependency) — same major as server/companion (repo just
  migrated both to this line; design D8 records vitest 4 / vite 8 compatibility as
  verified for web specifically, which has vite `^8.0.0` + React 19).
- `@testing-library/jest-dom` — NOT added (see Config choices above).

`web/package.json` gained a `"test": "vitest run"` script. Root `package.json`'s
`test` script changed from `test -w server && test -w companion` to
`test -w server && test -w web && test -w companion` (web inserted between,
server kept first per the task brief).

## tsconfig / lint

No tsconfig changes needed. `web/tsconfig.json`'s `include: ["src"]` already covers
`*.test.tsx` files (mirrors how `server/tsconfig.json`'s `include: ["src/**/*.ts"]`
already covers `*.test.ts` — server sets no vitest-specific tsconfig carve-out
either, since tests import `describe`/`it`/`expect` explicitly from `'vitest'`
rather than relying on global types). Confirmed clean via `npm run typecheck -w web`.
`npm run lint` (biome) reported zero issues on the three new files; it did
auto-reorder the two-line import block in `renderStrict.tsx` (biome's import-sort
rule), which was applied and is reflected in the committed file. Pre-existing
unrelated warnings in `web/src/shared/utils/loadingVideo.ts` (optional-chain
suggestions) are untouched — not part of this task and not introduced by it.

## Proof output

```
npm run typecheck   → server, web, companion, e2e all clean

npm test
  server:     Test Files  43 passed (43)   Tests  252 passed (252)
  web:        Test Files   1 passed (1)    Tests    1 passed (1)
  companion:  Test Files   6 passed (6)    Tests   20 passed (20)
```

The one web test (`web/src/shared/components/Toast.test.tsx`) renders the real,
existing `Toast` component (from `web/src/shared/components/Toast.tsx`) via
`renderStrict()`, proving jsdom + the `@/…` aliases + tsx transform + StrictMode
end-to-end: it queues a toast via the module's `toast.success()` API, renders
`<Toast />` under `<StrictMode>` (exercising the component's listener-subscribe
effect and its cleanup, which StrictMode double-invokes in dev/test), and asserts
the message text is present via `screen.getByText(...).textContent`.

## package-lock.json

`npm install` run at root after the `package.json` edits; the lockfile diff
(697 insertions) covers the new `@testing-library/react`, `jsdom`, and `vitest`
(web-side) dependency trees plus their transitives. No `peer: true` cosmetic
noise was observed in this diff (the task brief flagged this as possible/fine but
it didn't occur here).

## Scope note

Two files were already modified in the working tree before this task started and
were left untouched / unstaged / uncommitted by this task, as they're unrelated
to task 2.1: `CLAUDE.md` and `.claude/skills/openspec-apply-change/SKILL.md`.
