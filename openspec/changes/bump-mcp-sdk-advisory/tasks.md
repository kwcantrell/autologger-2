# Tasks

The first commit on `bump-mcp-sdk-advisory` holds only `openspec/changes/bump-mcp-sdk-advisory/`.
The PR targets `supabase-migration`.

Keep each task's text, and later its `Evidence:`, in one block with no blank line.

## 1. Bump

- [ ] 1.1 Before the bump, record:
  - `npm ls @modelcontextprotocol/sdk` and `npm ls zod`;
  - `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --only audit` (red: GHSA-6qxp-vccf-f47h);
  - `--only commands` (typecheck and `npm test` counts);
  - `cd server && npx vitest run --project pg` counts.
- [ ] 1.2 Edit the SDK's lockfile entry as design D1 gives it, then run `npm ci`. Verify:
  - `git diff --stat` touches only `package-lock.json`, about 8 lines;
  - `npm ls @modelcontextprotocol/sdk` shows 1.32.1;
  - `npm ls zod` matches 1.1;
  - `npm install --package-lock-only` leaves the lockfile unchanged;
  - `check-change.sh --only audit` passes;
  - `--only commands` and the `pg` project match 1.1, with known flakes re-run and logged;
  - the MCP/AI integration files (`aiMcpServer`, `mcpTools`, `callers`, `aiV2`) pass by name.

## 2. Dev stack and checks

- [ ] 2.1 Rebuild with `make dev-up`. Then run one AI turn with the pinned Claude CLI that calls at least one MCP tool (D3), and record that the tool call succeeded. If the CLI can't be authenticated, record that and ask the owner for a waiver.
- [ ] 2.2 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage pr` and `openspec validate --all --strict`.
