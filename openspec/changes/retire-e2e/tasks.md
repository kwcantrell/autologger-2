# Tasks

The first commit on `supabase-1.4a-retire-e2e` is `openspec/changes/retire-e2e/` only. The PR
targets `supabase-migration` with `size-override`, which is the owner's recorded exception. The
gates run with `GITHUB_BASE_REF=supabase-migration`.

## 1. Router test (before anything is deleted)

- [x] 1.1 Write `docker/scripts/test_router.sh` (design D5) and run it against stage while
  `e2e/container-routing.spec.ts` still exists, to cross-check every case.
  Evidence: `sh docker/scripts/test_router.sh stage` -> `test_router: 67 passed, 0 failed` (shell 5, dispositions 24, static chunk, stray upgrades 5 + control, upgrade detection 11, traversal 11 + own-404 + POST + query, token scope 4, web->api `unreachable`, LAN `192.168.0.100` not reachable). The disposition table was recorded with `--record` from the stage router built from this commit. It was not re-compared against a live single-process reference (no host server is run); the e2e suite's earlier parity runs are the reference, as design D5 states. Regression: a scratch router (`rtrtest-broken`, stage networks, `127.0.0.1:18099`) with `@nonRead not method GET HEAD POST` -> `FAIL disposition POST /sessions/abc (got 200 | … text/html …)`, `test_router: 66 passed, 1 failed`; scratch container removed. Adds a `ROUTER_TEST_PORT` override for that.
  - Show it catches a regression: temporarily point the router's `POST /sessions/*` disposition
    at `web` in a scratch copy of the Caddyfile on a scratch router. Expect a FAIL naming that
    request.
  - Check: `sh docker/scripts/test_router.sh stage` passes every case.

## 2. Deletion and references

- [ ] 2.1 Delete in the design D1 order, then make the D2 package changes
  (`npm uninstall @playwright/test --package-lock-only`).
  - Check: `git status --porcelain | grep -E 'e2e/|test-results|playwright-report'` is empty;
    `npm run typecheck` passes; `git diff --stat package-lock.json` shows only removals.
- [ ] 2.2 Remove the AI v2 seam (design D3) and fix the stale references (`fixturesDir.ts`,
  `noAgentAuthoredMarkup.repo.test.ts`, `.pre-commit-config.yaml`).
  - Check:
    - `npm test` passes;
    - `git grep -nE "playwright|AI_V2_SDK_EXECUTABLE_PATH|e2e/" -- ':!docs' ':!openspec' ':!CHANGELOG.md'`
      lists only the intended keeps (`.gitleaksignore`, `.dockerignore`, `.playwright-mcp`);
    - `npm run lint` shows only the two existing `compression.int.test.ts` warnings (A7).
- [ ] 2.3 Static check (design D4).
  - Check: `sh docker/scripts/test_check_envs.sh` passes; `make check` passes;
    `grep -c 'compose_prod_e2e\|AL_E2E_OVERLAY' docker/scripts/*.sh` gives 0.

## 3. Docs

- [ ] 3.1 Update the README and AGENTS.md (design D6), and the ADR 0021 slice list (split,
  exception, order).
  - Check: `grep -nE "e2e|playwright" README.md AGENTS.md` shows only the new retirement line;
    `scripts/check-change.sh --only guide-size` passes.

## 4. Verify

- [ ] 4.1 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`.
  - Check: green, apart from `size` under the recorded exception.
- [ ] 4.2 Do the consistency read, appended to `panel.md`.
- [ ] 4.3 Archive with `/opsx:archive retire-e2e`, which syncs the specs and applies the two
  Purpose edits from design D6.
  - Check: `openspec validate --all --strict`.
