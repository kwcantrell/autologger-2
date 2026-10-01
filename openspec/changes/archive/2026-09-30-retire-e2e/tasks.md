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

- [x] 2.1 Delete in the design D1 order, then make the D2 package changes
  (`npm uninstall @playwright/test --package-lock-only`).
  Evidence: `rm -rf e2e/.data e2e/.data-oauth test-results playwright-report` first, then `git rm -rq e2e playwright.config.ts scripts/teardown.mjs server/src/test/fixtures/ai-v2-fake-agent.mjs`; `.gitignore` e2e/Playwright lines removed (`.playwright-mcp/` kept); root scripts `teardown`/`e2e*` removed, `typecheck` drops `-p e2e`, lint globs drop `e2e playwright.config.ts`; `npm uninstall @playwright/test --package-lock-only` -> `package-lock.json | 59 ------` (2 remaining mentions are next's optional peer declaration). `git status --porcelain | grep -E 'e2e/|test-results|playwright-report' | grep -v '^D '` -> empty; `npm run typecheck` -> rc=0.
  - Check: `git status --porcelain | grep -E 'e2e/|test-results|playwright-report'` is empty;
    `npm run typecheck` passes; `git diff --stat package-lock.json` shows only removals.
- [x] 2.2 Remove the AI v2 seam (design D3) and fix the stale references (`fixturesDir.ts`,
  `noAgentAuthoredMarkup.repo.test.ts`, `.pre-commit-config.yaml`).
  Evidence: `aiV2.ts` seam removed (`pathToClaudeCodeExecutable` env read), fixture deleted; `fixturesDir.ts`, `noAgentAuthoredMarkup.repo.test.ts` (scan list and name), `.pre-commit-config.yaml` exclude, `biome.json` includes, `web/next.config.ts` and two test comments updated. `npm test` -> rc=0 (node 53/53; server 1384; web 794 passed / 3 skipped; every package suite passing); `npm run lint` -> `Found 2 warnings.`, both `compression.int.test.ts:58/62 noNonNullAssertion` (pre-existing, A7); `npm run typecheck` -> rc=0. `git grep -nE "playwright|AI_V2_SDK_EXECUTABLE_PATH|e2e/|ai-v2-fake-agent"` (outside docs/openspec/CHANGELOG) leaves: `.dockerignore` `**/playwright-report`, `.gitignore` `.playwright-mcp/`, `.gitleaksignore`, `test_router.sh` provenance comment, `noAgentAuthoredMarkup` excluded-dir names, and README lines (task 3.1) and `compose-env.sh` (task 2.3).
  - Check:
    - `npm test` passes;
    - `git grep -nE "playwright|AI_V2_SDK_EXECUTABLE_PATH|e2e/" -- ':!docs' ':!openspec' ':!CHANGELOG.md'`
      lists only the intended keeps (`.gitleaksignore`, `.dockerignore`, `.playwright-mcp`);
    - `npm run lint` shows only the two existing `compression.int.test.ts` warnings (A7).
- [x] 2.3 Static check (design D4).
  Evidence: red first: with `e2e/` deleted, `sh docker/scripts/check-envs.sh prod` -> `FAIL [invariant 0] could not resolve prod + e2e overlay … compose.e2e.yaml: no such file or directory`. After D4 (prod resolved once, invariant 14 without exemption, invariant 10 greps `compose.yaml` only, `E2E_*` unsets and `AL_E2E_OVERLAY` removed, case renamed `clean tree passes`): `check-envs: ok (all)`, `test_check_envs: 27 passed, 0 failed`; `grep -n 'E2E\|e2e'` over check-envs.sh, compose-env.sh and test_check_envs.sh -> no matches.
  - Check: `sh docker/scripts/test_check_envs.sh` passes; `make check` passes;
    `grep -c 'compose_prod_e2e\|AL_E2E_OVERLAY' docker/scripts/*.sh` gives 0.

## 3. Docs

- [x] 3.1 Update the README and AGENTS.md (design D6), and the ADR 0021 slice list (split,
  exception, order).
  Evidence: README: the e2e smoke and visual sections are replaced by "Browser e2e (retired)", "Verifying the container topology" now describes `test_router.sh stage`, and the `e2e:container` warnings (pre-flight, one host two stacks, the prod follow-up), the Companion `npm run e2e` line, the `typecheck` comment and the fixtures-tree `playwright.config.ts` mention are removed. AGENTS.md: `e2e:container` bullet deleted. ADR 0021: 1.4 is split into 1.4a/1.4b, run before 1.3, with the 1.4a size exception recorded. `grep -nE "e2e|playwright" AGENTS.md` -> none; README -> only the retirement lines (1386-1387, 1705, 1770-1772, 1880); `scripts/check-change.sh --only guide-size` -> `PASS  guide-size       AGENTS.md 95/150 lines`.
  - Check: `grep -nE "e2e|playwright" README.md AGENTS.md` shows only the new retirement line;
    `scripts/check-change.sh --only guide-size` passes.

## 4. Verify

- [x] 4.1 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`.
  Evidence: `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` -> every gate `PASS` except `WARN  size             1410 changed lines > budget 400`. That is above the proposal's "about 1,250" estimate (the README edits); ADR 0021 now records 1,410, and the difference is noted in the consistency read.
  - Check: green, apart from `size` under the recorded exception.
- [x] 4.2 Do the consistency read, appended to `panel.md`.
  Evidence: `git diff <approval> -- openspec/changes/retire-e2e/` -> tasks.md only (ticks and evidence); `panel.md` `## Consistency read 2026-09-30`, 3 minor items, all resolved (size 1,410 recorded in ADR 0021; table provenance; delta-to-check map).
- [x] 4.3 Archive with `/opsx:archive retire-e2e`, which syncs the specs and applies the two
  Purpose edits from design D6.
  Evidence: sync: container-deployment 1 MODIFIED (parity scenario) + 1 REMOVED ("Container e2e project") + 1 ADDED ("Router behaviour is checked without a browser"); local-container-environments 2 MODIFIED; web-frontend-platform 1 MODIFIED. Purpose edits exactly as design D6 (container-deployment: "non-browser router test"; api-contract-freeze: e2e suite dropped from the consumer list). `git diff --stat openspec/specs` -> 4 files, 27+/24-; `openspec validate --specs --strict` -> `Totals: 26 passed, 0 failed`; moved to `openspec/changes/archive/2026-09-30-retire-e2e/`.
  - Check: `openspec validate --all --strict`.
