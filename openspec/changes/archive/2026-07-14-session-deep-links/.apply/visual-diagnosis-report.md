# Visual suite (17 pixel-diff failures) — branch-induced vs. environmental

**Question**: Are the 17 `toHaveScreenshot` pixel-diff failures in `npm run e2e:visual`
(`visual-desktop` + `visual-mobile` projects) caused by `session-deep-links`'s web changes
(routing rewrite reshaping `AppShell`/`SessionWorkspace`), or are they environmental
(baselines frozen at commit `43883ac`, headless-browser/font drift)?

**Branch**: `session-deep-links`, HEAD at time of this diagnosis: `84829d5f73c7...`
**Merge-base with `main`**: `32f808db40105214a0443c0d2b668d3c017138ce`

## Method

1. Confirmed clean start (`git status --porcelain` empty except untracked `.apply/`
   bookkeeping), recorded HEAD `84829d5f73c77581a109beab559dd6aa7c577cc9`.
2. Ran `npm run e2e:visual` once at branch tip — 17 failures, list + magnitudes captured
   below (matches the implementer's task-8.1-8.3 report, which additionally verified the
   `e2e/`-only diff was not the cause via `git stash`; this run independently re-derives
   the branch-tip numbers and goes one step further by swapping the *web app* itself).
3. Checked whether `e2e/visual.spec.ts` changed on-branch: `git diff 32f808d..HEAD --
   e2e/visual.spec.ts` is **empty** — the visual spec and its baseline PNGs are untouched
   by this branch. Only `e2e/smoke.spec.ts` and `e2e/login-gate.spec.ts` changed
   (`git diff --stat 32f808d..HEAD -- e2e/` → 2 files, 80 insertions, 1 deletion, neither
   is `visual.spec.ts`). So the baselines under test are identical in both runs below.
4. Restored the **pre-branch web app** transiently:
   `git checkout 32f808d -- web/src web/vite.config.ts web/package.json`
   (there is no root `web/index.html` in this repo — the per-page `index.html` files live
   under `web/src/pages/*/index.html` and are covered by the `web/src` checkout).
   `git checkout` with a directory pathspec only *resets tracked-at-that-commit* files; it
   does not delete files added later. 21 files were added to `web/src` between
   `32f808d` and `HEAD` (new components/hooks/tests: `SessionRoute.tsx`, `navigation.ts`,
   `departureWatcher.ts`, `loginReturnStash.ts`, `loginReturnPath.ts`,
   `useLoginReturnConsume.ts`, associated `*.test.tsx`, `web/src/test/setup.ts`,
   `web/src/test/renderStrict.tsx`, etc.) — these were explicitly `rm`'d so the working
   tree matched `32f808d` exactly, not "32f808d files patched over branch-tip additions."
   `web/package.json` at `32f808d` lacks `wouter` (added on-branch) and the `test`
   script/`vitest`/`jsdom`/`@testing-library/react` deps; `node_modules` being a superset
   was fine — `npm run build -w web` succeeded without reinstalling.
5. Built (`npm run build -w web` succeeded, 232 modules, same font/asset pipeline) and ran
   the visual suite against this pre-branch build:
   `npx playwright test --workers=1 --project=visual-desktop --project=visual-mobile`
   (equivalent to `e2e:visual` minus the redundant rebuild, since the pre-branch build was
   already in place) — **17 failures**, list + magnitudes captured below.
6. Restored branch state: `git checkout HEAD -- web/src web/vite.config.ts
   web/package.json`. `git status --porcelain` → **empty** (full match, all `D`/`M`
   entries from the transient swap resolved cleanly). Rebuilt (`npm run build -w web`
   succeeded, 232 modules) and ran `npm test -w web` → **13 test files / 123 tests
   passed**, proving the restored tree is healthy, not just superficially clean.

## Failure list — branch tip (`84829d5f73c7...`)

| # | Project | Test | Final pixel diff (ratio 0.01) |
|---|---|---|---|
| 1 | visual-desktop | workspace stopped + seeded events | 10 |
| 2 | visual-desktop | workspace play | 10 |
| 3 | visual-desktop | rename-session-modal | 11 |
| 4 | visual-desktop | feed edit-mode | 10 |
| 5 | visual-desktop | feed pending-delete | 10 |
| 6 | visual-desktop | transcribe-feed tab | 10 |
| 7 | visual-desktop | topics-feed tab | 10 |
| 8 | visual-desktop | hide-internal toggle | 10 |
| 9 | visual-mobile | workspace stopped + seeded events | 3 |
| 10 | visual-mobile | workspace play | 3 |
| 11 | visual-mobile | rename-session-modal | 7 |
| 12 | visual-mobile | feed edit-mode | 3 |
| 13 | visual-mobile | feed pending-delete | 3 |
| 14 | visual-mobile | transcribe-feed tab | 3 |
| 15 | visual-mobile | topics-feed tab | 3 |
| 16 | visual-mobile | hide-internal toggle | 3 |
| 17 | visual-mobile | timeline seeked-paused | 3 |

27 passed, 4 skipped, 17 failed.

## Failure list — pre-branch web app (`32f808d`, e2e spec + baselines unchanged)

| # | Project | Test | Final pixel diff (ratio 0.01) |
|---|---|---|---|
| 1 | visual-desktop | workspace stopped + seeded events | 10 |
| 2 | visual-desktop | workspace play | 10 |
| 3 | visual-desktop | rename-session-modal | 11 |
| 4 | visual-desktop | feed edit-mode | 10 |
| 5 | visual-desktop | feed pending-delete | 10 |
| 6 | visual-desktop | transcribe-feed tab | 10 |
| 7 | visual-desktop | topics-feed tab | 10 |
| 8 | visual-desktop | hide-internal toggle | 10 |
| 9 | visual-mobile | workspace stopped + seeded events | 3 |
| 10 | visual-mobile | workspace play | 3 |
| 11 | visual-mobile | rename-session-modal | 7 |
| 12 | visual-mobile | feed edit-mode | 3 |
| 13 | visual-mobile | feed pending-delete | 3 |
| 14 | visual-mobile | transcribe-feed tab | 3 |
| 15 | visual-mobile | topics-feed tab | 3 |
| 16 | visual-mobile | hide-internal toggle | 3 |
| 17 | visual-mobile | timeline seeked-paused | 3 |

27 passed, 4 skipped, 17 failed.

(Note: a couple of intermediate retry attempts inside individual tests logged transient
larger diffs — e.g. `hide-internal toggle`/mobile logged 432 then 429 pixels on its first
two capture attempts before settling at 3 on the "stable screenshot" that Playwright
actually asserts against; the same self-healing-retry shape appears in both runs and the
*asserted* final numbers above are identical. This is Playwright's built-in stabilization
retry, not a branch effect.)

## Comparison

Same 17 test names fail in both runs. Every final asserted pixel-diff magnitude is
**identical** between branch-tip and pre-branch (10/10, 10/10, 11/11, 10/10, 10/10, 10/10,
10/10, 10/10 for desktop; 3/3, 3/3, 7/7, 3/3, 3/3, 3/3, 3/3, 3/3, 3/3 for mobile). The same
27 tests pass and the same 4 skip in both runs. `e2e/visual.spec.ts` and its baseline PNGs
are byte-identical across both runs (untouched by this branch) — so this is an apples-to-
apples comparison of two different web builds against one frozen baseline set.

## Verdict: **B — environmental**

The failures are not caused by `session-deep-links`'s web changes. Reverting the entire
web app (`web/src`, `vite.config.ts`, `package.json`) to its pre-branch state (merge-base
`32f808d`) while holding the visual spec and baselines fixed reproduces the exact same 17
failing tests with the exact same pixel-diff magnitudes. The baselines (frozen at
`43883ac`, well before `32f808d`) mismatch this sandbox's rendering (font hinting /
anti-aliasing / headless-Chromium version drift) independent of any code on this branch —
consistent with the ~3px / 0.01-ratio scale of every diff (desktop's higher DPR viewport
naturally samples the same sub-pixel drift as ~10-11px). This corroborates the
implementer's earlier `git stash`-based check in `task-8.1-8.3-report.md`, using a
stronger control (full pre-branch app rebuild, not just unstaging the two touched `e2e/`
spec files) and reaching the same conclusion.

## Restore verification

Final `git checkout HEAD -- web/src web/vite.config.ts web/package.json`, then:

```
$ git status --porcelain
(empty)
```

`npm run build -w web` → succeeded (232 modules transformed, same asset manifest shape).
`npm test -w web` → `Test Files  13 passed (13)`, `Tests  123 passed (123)`.

Tree is restored to branch tip and verified healthy, not just diff-clean.

Report: `/home/kalen/autologger-2/openspec/changes/session-deep-links/.apply/visual-diagnosis-report.md`
