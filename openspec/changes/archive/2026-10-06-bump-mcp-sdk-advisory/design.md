# Design: bump-mcp-sdk-advisory

## Context

`@modelcontextprotocol/sdk` 1.29.0 is in the vulnerable range of GHSA-6qxp-vccf-f47h (1.12.0 - 1.30.1).
The newest release is 1.32.1, published 2026-10-05:
`npm view @modelcontextprotocol/sdk time --json` lists 1.30.0 (07-27), 1.30.1 (09-23), 1.31.0 (09-28),
1.32.0 (10-02) and 1.32.1 (10-05).

Our code imports only `McpServer` (`@modelcontextprotocol/sdk/server/mcp.js`) and
`StreamableHTTPServerTransport` (`…/server/streamableHttp.js`), both in
`packages/ai-runtime/src/aiMcpServer.ts:63-64`. The Agent SDK spawns the Claude CLI, and that CLI
is the MCP client.

## Assumptions

Each assumption gives its test and the observed output. The panel's assumption tester ran them in
a throwaway copy of the repo.

- **A1. Only the SDK's lockfile entry needs to change.** 1.32.1 satisfies every declared range
  (`^1.29.0`), and its dependency list differs from 1.29.0 only in a widened
  `@hono/node-server: "^1.19.9 || ^2.0.5"`. The installed 1.19.x satisfies that range.
  - `npm view @anthropic-ai/claude-agent-sdk@0.3.216 dependencies` gives `'^1.29.0'`.
  - Editing just that entry gives `git diff --stat` → `package-lock.json | 8 ++++----`, and
    `npm ls zod` is unchanged (3.25.76).
  - **Refuted for `npm update`:** `npm update @modelcontextprotocol/sdk --package-lock-only` gives
    `113 ++++--`.
    - The hoisted zod moves 3.25.76 → 4.6.5, with nested zod@3 under `server/`,
      `packages/contract/` and `packages/ai-runtime/`.
    - `@anthropic-ai/sdk@0.131.0` is added.
    - `npm run typecheck` fails with `TS2589` and `TS2741 Property '_zod' is missing`.
    - The AI v2 integration tests fail: `expected 500 to be 422`, because `ZodError` is no longer
      the same class.
- **A2. 1.32.1 clears the advisory.** The GitHub API reports
  `"vulnerable_version_range":">= 1.12.0, < 1.31.0"`, `"patched_versions":"1.31.0"`. With the
  edited lockfile, `npm audit --audit-level=high` gives `found 0 vulnerabilities` and exit 0.
- **A3. No breaking change in what we use.**
  - Diffing the packed `.d.ts` from 1.29.0 to 1.32.1:
    - `server/streamableHttp.d.ts` is unchanged;
    - `server/mcp.d.ts` adds an optional `maxToolInputElements`;
    - the web transport adds optional `keepAliveMs` (SSE keep-alive by default) and
      `maxRequestBodySize`. The body limit does not apply when the caller passes a parsed body,
      which ours does (`aiMcpServer.ts:1088-1095`).
  - `LATEST_PROTOCOL_VERSION` and `SUPPORTED_PROTOCOL_VERSIONS` are identical.
  - No install scripts.
  - 1.32.1 has SLSA provenance (GitHub Actions trusted publishing).
  - 1.32.1 is docs-only on top of 1.32.0. 1.31.0 is the advisory fix. 1.32.0's same-origin
    redirects are client-side.
- **A4. The server path is tested, but only against the SDK's own client.**
  - `server/src/test/session/{aiMcpServer,mcpTools,callers}.int.test.ts` and
    `server/src/routers/aiV2.int.test.ts` pass with the edited lockfile (`Tests 150 passed (150)`),
    and `packages/ai-runtime` passes (`181 passed`).
  - These tests and the fake-claude fixtures use the SDK's own `Client` from the same bumped copy.
    The production client is the pinned Claude CLI (`docker/Dockerfile:14`), with its own bundled
    MCP client. So D3 adds a real-CLI check.

## Decisions

### D1. A targeted lockfile edit

- In `package-lock.json`, change only the `node_modules/@modelcontextprotocol/sdk` entry:
  - `version` 1.32.1;
  - `resolved` `https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.32.1.tgz`;
  - `integrity` from `npm view @modelcontextprotocol/sdk@1.32.1 dist.integrity`;
  - its `@hono/node-server` range to `^1.19.9 || ^2.0.5`.
- Then run `npm ci` (with `--ignore-scripts` if the host lacks build tools) to verify the integrity
  and install.
- Verify:
  - `git diff --stat` touches only `package-lock.json`, about 8 lines;
  - `npm ls @modelcontextprotocol/sdk` shows 1.32.1;
  - `npm ls zod` matches the base;
  - `npm install --package-lock-only` afterwards leaves the lockfile unchanged.

### D2. Tests through check-change

Run these before and after, recording the counts:
- `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --only audit`, red before and green
  after;
- `--only commands` for typecheck and `npm test`, which covers every workspace including
  `packages/ai-runtime`;
- the server `pg` project as an extra step.

There are no new tests.

### D3. Dev image and a real-CLI check

- Rebuild with `make dev-up`. Docker installs with `npm ci` from the lockfile.
- On the dev stack, run one AI turn with the pinned Claude CLI that must call at least one MCP tool:
  for example, an Assistant turn that lists topics, or events generate creating at least one event.
- Record evidence that a tool call succeeded, not only that the turn finished.
- If the CLI can't be authenticated on the dev stack, say so and ask the owner to waive the check.

## Risks

- **A fresh release.** 1.32.1 is a day old. Mitigations: the changelog review in A3, the full suites,
  and a dev-stack smoke test.
- **A future `npm update` or `npm audit fix`** will hit the Agent SDK's unmet zod peer (A1). That is
  recorded as a follow-up.

## Rollback

Revert the lockfile commit.
