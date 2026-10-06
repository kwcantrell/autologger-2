# Tasks

The first commit on `bump-mcp-sdk-advisory` holds only `openspec/changes/bump-mcp-sdk-advisory/`.
The PR targets `supabase-migration`.

Keep each task's text, and later its `Evidence:`, in one block with no blank line.

## 1. Bump

- [x] 1.1 Before the bump, record:
  - `npm ls @modelcontextprotocol/sdk` and `npm ls zod`;
  - `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --only audit` (red: GHSA-6qxp-vccf-f47h);
  - `--only commands` (typecheck and `npm test` counts);
  - `cd server && npx vitest run --project pg` counts.
  - Evidence: `npm ls @modelcontextprotocol/sdk` -> `@modelcontextprotocol/sdk@1.29.0` (ai-runtime; deduped under claude-agent-sdk@0.3.216 and server); `npm ls zod` -> `zod@3.25.76` everywhere, `invalid: "^4.0.0" from node_modules/@anthropic-ai/claude-agent-sdk` (pre-existing, ELSPROBLEMS); `check-change.sh --only audit` -> `FAIL audit ... @modelcontextprotocol/sdk 1.12.0 - 1.30.1 Severity: high ... GHSA-6qxp-vccf-f47h ... 1 high severity vulnerability`; `check-change.sh --only commands` -> `PASS commands ran ['typecheck', 'test']` (no flake fired); `npm test` counts -> node:test `pass 86 fail 0`; server `Tests 1595 passed | 4 skipped (1599)`, web `1689 passed (1689)`, companion 21, domain 50, contract 60, ports 1, storage 133, catalog 50, session-core 33, transcription 67, media-import `34 passed | 2 skipped (36)`, log-import 32, ai-runtime `181 passed (181)`; `cd server && npx vitest run --project pg` -> `Tests 103 passed | 1 skipped (104)`.
- [x] 1.2 Edit the SDK's lockfile entry as design D1 gives it, then run `npm ci`. Verify:
  - `git diff --stat` touches only `package-lock.json`, about 8 lines;
  - `npm ls @modelcontextprotocol/sdk` shows 1.32.1;
  - `npm ls zod` matches 1.1;
  - `npm install --package-lock-only` leaves the lockfile unchanged;
  - `check-change.sh --only audit` passes;
  - `--only commands` and the `pg` project match 1.1, with known flakes re-run and logged;
  - the MCP/AI integration files (`aiMcpServer`, `mcpTools`, `callers`, `aiV2`) pass by name.
  - Evidence: edited only the `node_modules/@modelcontextprotocol/sdk` entry (version 1.32.1, resolved sdk-1.32.1.tgz, integrity `sha512-2DdE+SJD...ichPkdw==` from `npm view ... dist.integrity`, `@hono/node-server` `^1.19.9 || ^2.0.5`; other dependencies/peerDependencies/peerDependenciesMeta/engines/license already matched `npm view @modelcontextprotocol/sdk@1.32.1`); `npm ci` -> exit 0, `found 0 vulnerabilities` (better-sqlite3 and esbuild load on host); `git diff --stat` -> `package-lock.json | 8 ++++----`; `npm ls @modelcontextprotocol/sdk` -> `@modelcontextprotocol/sdk@1.32.1` (3 sites); `npm ls zod` diff vs 1.1 -> only the SDK parent label line changed, `zod@3.25.76` unchanged everywhere; `npm install --package-lock-only` -> lockfile sha256 `f2b3a2e9...` before and after, diff stat still 8 lines; `check-change.sh --only audit` -> `PASS audit ran ['audit']`; `check-change.sh --only commands` run 1 -> `FAIL ... postgresCatalogStore.pg.test.ts > 8 contending read-modify-write transactions all commit ... 'repetition 2: 1/8 exhausted'` (known storage flake), and a direct `npm test` in the same run had server `1 failed | 1594 passed` from `aiMcpServer.int.test.ts > Cap holds under concurrent calls ... Test timed out in 5000ms` with `codes ["40001","40001"]` (a serialization-contention timeout under load, not one of the known flakes; it passed when re-run); re-run -> `PASS commands ran ['typecheck', 'test']`, and the direct `npm test` counts are identical to 1.1 (diff empty); `npx vitest run --project pg` -> `Tests 103 passed | 1 skipped (104)` (= 1.1); `npx vitest run --project integration src/test/session/aiMcpServer.int.test.ts src/test/session/mcpTools.int.test.ts src/test/session/callers.int.test.ts src/routers/aiV2.int.test.ts` -> `Test Files 4 passed (4)`, `Tests 150 passed (150)`.

## 2. Dev stack and checks

- [x] 2.1 Rebuild with `make dev-up`. Then run one AI turn with the pinned Claude CLI that calls at least one MCP tool (D3), and record that the tool call succeeded. If the CLI can't be authenticated, record that and ask the owner for a waiver.
  - Evidence: `make dev-up` exit 0; inside `autologger-dev-app`: `node -p require("@modelcontextprotocol/sdk/package.json").version` -> `1.32.1`, `claude --version` -> `2.1.284 (Claude Code)`. Assistant turn on ATS_youtube (`0c8aaf43`) via agent-browser, prompt "Using your session tools, how many topics does this session have? Answer with just the number." -> transcript shows `Using tool: list_topics` then `AI:6` (the session has 6 topics), so the real pinned CLI's MCP client called our 1.32.1 server successfully.
- [x] 2.2 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage pr` and `openspec validate --all --strict`.
  - Evidence: `scripts/check-change.sh --stage pr` -> PASS openspec, yaml, workflows, skills-sync, guide-size, change (tier 2), risk-floor, panel (7 findings, no open criticals), evidence, artifacts-first, tests-with-code, `commands` (typecheck + test), `audit`; `approval` PASS after the owner removed a leading space from the Approved-by line (`--only approval` -> `approval recorded`); `tasks` is this tick. `openspec validate --all --strict` -> `Totals: 28 passed, 0 failed`. The `aiMcpServer.int.test.ts` "Cap holds under concurrent calls" timeout seen once in 1.2 (40001 serialization retries) re-ran 5x alone -> `Tests 69 passed (69)` each.
