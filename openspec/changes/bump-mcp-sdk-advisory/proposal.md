# Bump `@modelcontextprotocol/sdk` to 1.32.1 for GHSA-6qxp-vccf-f47h

Tier: 2
Tier reason: a security fix to a production runtime dependency, the MCP SDK that serves the AI
turns' loopback tool server (`packages/ai-runtime/src/aiMcpServer.ts`). The precedent,
`fix-dependency-vulns`, was tier 2. The owner chose a lean tier 2 (2026-10-06): no spec delta, and
a three-reviewer panel.

 Approved-by: Kalen 2026-10-06

## Why

`npm audit --audit-level=high` fails on `supabase-migration`, so the `audit` gate in
`scripts/check-change.sh` fails on every branch, including PR #75's CI. The cause is one high
advisory:
- **Advisory:** GHSA-6qxp-vccf-f47h ("MCP TypeScript SDK: OAuth client could send credentials to an
  authorization server chosen by the MCP server").
- **Affected range:** `@modelcontextprotocol/sdk` `>= 1.12.0, < 1.31.0`, patched in 1.31.0 (GitHub
  advisory API).
- **Installed:** 1.29.0, resolved in `package-lock.json`. It is required as `^1.29.0` by
  `packages/ai-runtime`, `server` and `@anthropic-ai/claude-agent-sdk@0.3.216`.

## Owner decisions (owner, 2026-10-06)

1. Run it as a lean tier 2: an OpenSpec change with `skip_specs`, a three-reviewer panel, and owner
   approval.

## For the approver

- **Only the SDK's own lockfile entry changes (8 lines).** 1.32.1 already satisfies every
  declared range (`^1.29.0`), so no `package.json` changes.
- **Not `npm update`.** `npm update` (or `npm audit fix`) also resolves the Agent SDK's unmet
  peers. That moves zod from 3 to 4 and splits zod copies across workspaces, which breaks
  typecheck and turns some 422 answers into 500s (panel, critical). So the bump is a targeted
  lockfile edit, verified by `npm ci`. The unmet zod peer predates this change and is recorded as
  a follow-up.
- **Exposure is probably low.** We use the SDK's *server* (`McpServer`,
  `StreamableHTTPServerTransport`) on loopback. The advisory is about its OAuth *client*. The bump
  still clears the gate and removes the vulnerable code.
- **Supply-chain note.** 1.32.1 was published on 2026-10-05, a day before this change. The panel
  checks its changelog and diff surface (1.29.0 → 1.30.x → 1.31.0 → 1.32.x) for breaking changes in
  the server APIs we use.

## What Changes

- `package-lock.json`: the `node_modules/@modelcontextprotocol/sdk` entry moves from 1.29.0 to
  1.32.1. Its `version`, `resolved`, `integrity` and `@hono/node-server` range change; nothing else
  does (design D1).
- The dev image is rebuilt (`make dev-up`), because dependencies changed.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. No observable behaviour change is intended, so the change sets `skip_specs: true`.

## Impact

- `package-lock.json` only.
- **Code that uses the SDK:**
  - `packages/ai-runtime/src/aiMcpServer.ts`;
  - indirectly, `@anthropic-ai/claude-agent-sdk`.
- **Tests that exercise it:**
  - `server/src/test/session/{aiMcpServer,mcpTools,callers}.int.test.ts`;
  - `server/src/routers/aiV2.int.test.ts`;
  - the fake-claude fixtures.

## Non-goals

- Other dependency updates.
- Changes to the MCP tool surface.
- Moving the SDK's declared range.
- **The Agent SDK's unmet peers** (`zod ^4`, `@anthropic-ai/sdk >=0.93`). This predates the change
  and is a follow-up.
- **Rebuilding prod images.** They pick up the lockfile on their next build.
