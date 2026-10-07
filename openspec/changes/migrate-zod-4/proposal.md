# Migrate to zod 4: meet the Agent SDK's peer and keep one zod in the tree

Tier: 2
Tier reason: it changes a dependency major across `packages/contract/**` (a high-risk path) and the
server. It changes the observable 422 validation body (issue fields and default messages), a frozen
contract, so it amends `api-contract-freeze` and `package-architecture`.

Approved-by: Kalen 2026-10-07

## Why

`@anthropic-ai/claude-agent-sdk` (0.3.216, and every release since 0.2.0) declares the peer
`zod ^4.0.0`, but the repo resolves a single `zod` 3.25.76. The consequences:

- `npm ls` reports `zod@3.25.76 invalid`.
- `npm update` and `npm audit fix` pull in zod 4 next to code written for zod 3. During the MCP SDK
  advisory bump that broke typecheck and turned 422s into 500s (a second `ZodError` class).
- The fix today is a hand-edited lockfile, and every future dependency bump stays blocked.
- The SDK also peers on `@anthropic-ai/sdk >=0.93`. It is not installed, and the SDK uses it only
  for type declarations.

## Owner decisions (owner, 2026-10-07)

1. **A full migration.** The repo moves to the zod 4 API. The `zod/v3` compatibility import is not
   used.
2. **422 bodies pass zod 4 issues through.** `{detail: err.issues}` is unchanged. Each issue
   keeps `code`, `path` and `message`. Every other field and issue code follows zod 4. Examples (the
   panel found more, all accepted):
   - `invalid_type` usually drops `received`;
   - size issues carry `origin` instead of `type` and drop `exact`;
   - enums and literals give `invalid_value`;
   - discriminators give `invalid_union`;
   - a pattern failure gives `invalid_format` with a `pattern` field;
   - an out-of-range integer gives two `too_big` issues.

   No translation layer is added.
3. **Default messages follow zod 4.** For example, `Required` becomes
   `Invalid input: expected string, received undefined`. This reaches the 422 issues, the teams
   `400` detail and the AI v2 dashboard `422` string. Messages written in our own code are unchanged.
4. **AI tool input schemas take the zod 4 JSON Schema output.** They lose `additionalProperties:
   false`.
   - **MCP chat tools:** `.int()` fields become `type: "integer"`.
   - **AI v2 aggregate tools:** these go through the Agent SDK's bundled converter, so
     `transcript_excerpt`'s `offset` and `limit` are advertised as a plain `number`, with no
     `integer` and no `minimum` (panel).

   Runtime handling is unchanged: unknown keys are stripped, `.int()` and `.min()` are still
   enforced, and every handler re-validates or clamps.
5. **`@anthropic-ai/sdk`** becomes a devDependency of `@autologger/ai-runtime`, so the Agent SDK's
   peer is met. Because the Agent SDK is a production dependency, npm also installs its peer, and
   that peer's small tree, in the production image (panel). No code imports it at runtime.
6. **Non-finite numbers are refused (panel).** zod 4's `z.number()` refuses `Infinity`. JSON such
   as `1e400` parses to `Infinity`, which zod 3 accepted and stored as a non-finite number (read
   back as `null`). Any number field given such a value now gets a `422`. This is safer, and it is
   the only change to which requests are refused.

## What changes

- **Dependencies:**
  - `zod ^4` replaces `^3.24.1` in `server` (dependency), `packages/contract` and
    `packages/ai-runtime` (peer and dev).
  - `@anthropic-ai/sdk` is added as an `ai-runtime` devDependency.
  - The lockfile is regenerated for these entries only, with exactly one `node_modules/zod`.
- **Code, in the 7 files that import zod.** Only what zod 4 breaks changes: the five one-argument
  `z.record(...)` calls become `z.record(z.string(), …)`, plus anything typecheck forces. Deprecated
  APIs that still work stay as they are (panel): `superRefine`, `ZodIssueCode`, `ZodTypeAny` and
  refinement `message`.
- **Tests:**
  - new contract tests pin the zod 4 422 body: issue fields, our own messages unchanged, defaults
    and transforms unchanged, and non-finite numbers refused;
  - a repo test keeps one zod 4 copy and the Agent SDK's peers in the lockfile;
  - a before/after record of every AI tool input schema;
  - every existing test keeps its assertions.
- **Docs:** the README's `zod` note.

## Not changing

- Status codes and the `{detail}` envelope. Which requests are refused is also unchanged, apart from
  non-finite numbers (decision 6). Defaults, transforms and strip-unknown-keys behaviour are
  unchanged.
- No web code changes: the web stringifies array details and never reads issue fields. The Companion
  never reads `detail`.
- The MCP and Agent SDK versions.

## Impact

- **Code:**
  - `packages/contract/src/{schemas,aiV2Catalog}.ts`
  - `packages/ai-runtime/src/{mcpTools,aiMcpServer}.ts`
  - `server/src/{app,routers/teams,routers/logImport}.ts`
  - three `package.json` files and `package-lock.json`
- **Clients:** an API client that read issue fields beyond `code`, `path` and `message`, or that
  matched default message text, sees new values. None exists in this repo.
- **Rollback:** revert the commit, which restores zod 3 and the lockfile.

## Non-goals

- Upgrading the Agent SDK or the MCP SDK.
- Restoring `additionalProperties: false` in tool schemas.
- Custom messages to pin today's wording.
- Replacing deprecated zod 4 APIs that still work: `superRefine`, `ZodIssueCode`, `ZodTypeAny`
  and refinement `message`.
