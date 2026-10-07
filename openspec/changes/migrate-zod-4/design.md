# Design: migrate-zod-4

## Context

Line numbers are at base `b53d3500`.

**Imports.** Exactly 7 files import zod. Nothing in web/, companion/, scripts/ or any test does.

| File | Use |
| --- | --- |
| `packages/contract/src/schemas.ts` | all request schemas; one-arg `z.record` at :26, :67, :365; `.refine({message, path})` at :83-86, :119-121, :191; `.transform` at :185-198; `.default` |
| `packages/contract/src/aiV2Catalog.ts` | dashboard catalog; `.superRefine` at :206-255; `ctx.addIssue({code: z.ZodIssueCode.custom, …})` at :119-133 and :211-249 |
| `packages/ai-runtime/src/mcpTools.ts` | Agent SDK `tool()` raw shapes; one-arg `z.record` at :302, :305; `safeParse` issues to tool `errors` at :321 |
| `packages/ai-runtime/src/aiMcpServer.ts` | MCP SDK `server.tool()` raw shapes (:301-332, :674-682); `safeParse` issue text at :807, :843 |
| `server/src/app.ts` | `instanceof ZodError` gives `422 {detail: err.issues}` (:223) |
| `server/src/routers/teams.ts` | `parseTeamBody<S extends ZodTypeAny>`; the first issue's message becomes the `400` detail (:38-45) |
| `server/src/routers/logImport.ts` | a `safeParse` with a fixed `400` message |

`dashboardStore.ts:49-50, :114` joins `validateDashboardConfig` messages into
`DashboardValidationError`, which `aiV2.ts:516` answers as `422`.

**Versions.**
- One `node_modules/zod` at 3.25.76.
- The MCP SDK 1.32.1 accepts `^3.25 || ^4.0` and picks a JSON-schema converter per version. It
  rejects mixed versions within one shape.
- The Agent SDK 0.3.216 peers on `zod ^4.0.0`. Its `createSdkMcpServer` copies a zod 4 schema's
  `.description` into its bundled registry.

**What pins what.**
- No test, fixture or spec pins an issue's fields or default messages. The specs pin the status,
  `{detail}`, and the array form.
- Tool-schema tests pin property-key sets only.
- `crossPackageErrorIdentity.int.test.ts` pins `422` and `Array.isArray(detail)`.

## Decisions

### D1. Dependencies

- `server/package.json`: `"zod": "^4.0.0"`.
- `packages/contract` and `packages/ai-runtime`: `peerDependencies` and `devDependencies`
  `"zod": "^4.0.0"`.
- `packages/ai-runtime`: devDependency `"@anthropic-ai/sdk": "^0.131.0"`, the current release
  (`>=0.93` required).
- **Install:** run `npm install` once at the root, then check:
  - `npm ls zod --json` shows exactly one copy, 4.x;
  - `npm ls @anthropic-ai/claude-agent-sdk zod @anthropic-ai/sdk` exits 0.
- **Lockfile scope.** The lockfile diff stays limited to `zod`, `@anthropic-ai/sdk` and their own
  dependency trees. The panel's simulation added `json-schema-to-ts`, `standardwebhooks`,
  `ts-algebra`, `@stablelib/base64` and `fast-sha256`, and changed `@babel/runtime` from dev to
  production. Those are expected.
  - **The manifests are edited by hand, then a plain `npm install` runs.** `npm install <pkg> -w`
    would write `dependencies.zod` into contract or ai-runtime, which must keep zod as a peer.
  - **If npm moves anything else, stop and report.**
- **Production image.** The Agent SDK is a production dependency, so npm treats its peer
  `@anthropic-ai/sdk`, and that peer's tree, as production. `npm ci --omit=dev --workspace=server`
  installs them, but nothing imports them at runtime. This is accepted (owner decision 5).
- **Never `npm update` or `npm audit fix`.** That rule is from the bump-mcp-sdk-advisory incident.

### D2. Code changes: only what zod 4 breaks (panel)

- `z.record(v)` becomes `z.record(z.string(), v)` at schemas.ts:26, :67, :365 and mcpTools.ts:302,
  :305. Zod 4 removed the one-argument form.
- **Anything else `npm run typecheck` forces**, each recorded in task evidence. A forced change that
  alters runtime behaviour is a stop.

Deprecated APIs that zod 4 still supports stay as they are: `superRefine`, `z.ZodIssueCode`,
`z.RefinementCtx`, `ZodTypeAny`, and refinement `{message}`. The panel checked that their messages,
paths and outputs are identical under zod 4. `app.ts` keeps `import { ZodError } from 'zod'`,
because zod 4's classic `.parse()` throws that class.

**Tool shapes.** In each tool shape, every value must be a zod 4 schema. The MCP SDK throws on a
mix. Because all of the shapes come from the same `zod` import, this holds automatically.

**Single-copy risk.** If any package still resolved zod 3, `instanceof ZodError` would miss and
answer `500`, as in the bump-mcp-sdk-advisory incident. The D3 lockfile guard and
`crossPackageErrorIdentity.int.test.ts` guard against that.

### D3. Behaviour preserved: tests first

- **New `packages/contract/src/schemas.zod4.test.ts`.** It is written red against zod 3 where zod 4
  differs, and green where the behaviour must not change:
  - (a) a missing required field gives an issue with `code: 'invalid_type'`, `path`, a string
    `message`, and no `received` or `input`. This is red on zod 3, which has `received`.
  - (b) each message set in our code appears verbatim with its path: `overwrite requires version`,
    `regenerate cannot be combined…`, `version is too large`, `metadata exceeds…`, and the four
    dashboard catalog messages.
  - (c) the parsed outputs of the defaults, transforms and strip cases already pinned in
    `schemas.test.ts`, extended to every schema with a `.default` or `.transform`.
  - (d) one-arg-record fields still accept `{any: value}` objects.
  - (e) a non-finite number (`Infinity`) is refused by `topicCreateSchema.duration_sec` and the
    waveform `peaks`. This is red on zod 3.
- **Lockfile guard (panel), `server/src/zodSingleCopy.repo.test.ts`, new.** It parses
  `package-lock.json` and checks three things:
  - exactly one `node_modules/**/zod` entry, with a 4.x version;
  - `node_modules/@anthropic-ai/sdk` is present;
  - no workspace package other than `server` lists `zod` under `dependencies`.

  This keeps the "One zod in the tree" and "The Agent SDK's peers are met" scenarios checked on
  every run, not just once. It is red on the base, where zod is 3.25.76 and the sdk is absent.
- **Route level (`server/src/routers/validationBody.int.test.ts`, new).** It covers the spec
  scenarios through the real app: the missing field, the message the code sets, and the non-finite
  number, which writes no topic. It also checks that the teams `400` detail is a non-empty string.
  The defaults and transforms scenario is covered at contract level, by (c).
- **Tool schemas.** A one-off script (not committed) records `tools/list` input schemas for every
  MCP chat tool and every aggregate tool, before and after. The diff is recorded in task evidence,
  and every difference must be one of D4's expected ones. The existing key-set tests stay
  unchanged.
- **AI v2.** The design turn's tool registration is exercised by the existing "tool schemas survive
  the package move" test, plus the live check.

### D4. Expected differences (accepted by the owner)

- **422 issue objects:** only `code`, `path` and `message` are relied upon. Known changes:
  - `invalid_type` drops `received`, except for a non-finite number;
  - `too_small`/`too_big` carry `origin` instead of `type`, and drop `exact`;
  - an out-of-range `.int()` gives two `too_big` issues;
  - `invalid_enum_value` and `invalid_literal` become `invalid_value`;
  - `invalid_union_discriminator` becomes `invalid_union`;
  - `invalid_string` becomes `invalid_format`, with `pattern`;
  - default messages are zod 4's.
- **Refused set:** a non-finite number is now refused.
- **Teams 400 and the dashboard 422 string:** zod 4 default wording.
- **Tool input JSON Schema:**
  - `additionalProperties: false` is gone;
  - in MCP chat tools, `.int()` fields become `type: "integer"`, possibly with safe-integer bounds;
  - in Agent SDK aggregate tools, `transcript_excerpt` `offset`/`limit` lose `integer` and
    `minimum` and become a plain `number`;
  - records gain `propertyNames`;
  - descriptions are kept.

  Runtime validation of tool arguments is unchanged.

### D5. Changes allowed to existing tests

None. Every existing test must pass with its assertions unchanged. One exception: a test that
imports a removed zod 3 API purely as test scaffolding may change, and the change must be recorded.
Any other failure is a stop: report it and update the artifacts.

## Risks

- **The lockfile drags other packages.** Mitigated by the D1 scope check.
- **Type inference changes ripple into `z.infer` users** (`DashboardConfig`, `AiV2AnswerItem`,
  `EventGenerateBody`). Typecheck catches them. A fix that changes runtime behaviour is a stop.
- **The model calls tools differently** once `additionalProperties: false` (and, for
  `transcript_excerpt`, the integer and minimum hints) is gone. Unknown keys are stripped, the
  Agent SDK still enforces `.int()` and `.min()`, and every handler re-validates or clamps, so the
  model gets no new capability. Accepted.
