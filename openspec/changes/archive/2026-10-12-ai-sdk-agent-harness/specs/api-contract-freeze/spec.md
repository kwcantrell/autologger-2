## ADDED Requirements

### Requirement: AI chat request and done event

The `POST /api/sessions/:sessionId/ai/chat` contract owned by ai-topics-chat ("Chat request
contract", "SSE reply stream shape") SHALL change in exactly these observable ways, which become
frozen surface on shipping:

- the JSON body SHALL accept an optional `history`, an array of at most 40 entries
  `{role: "user" | "assistant", text: string}`, each `text` 1 to 8000 characters after trimming,
  and at most 64 000 characters of `text` in total. A violation of these bounds or of the entry
  shape SHALL get the existing `422` validation-error body, and a value containing NUL the
  existing NUL `400`; in both cases no subprocess is spawned and no model request is made.
  `message` is unchanged;
- `claude_session_id?` SHALL also accept `null`, which SHALL be treated exactly as an absent id on
  both routes, so a client that echoes a `done` event's value verbatim never gets `422` for it. A
  string id's handling on the Claude CLI route is unchanged (a foreign, expired or unresumable id
  is `422`). On the AI SDK route its handling changes: it SHALL be ignored, its binding SHALL NOT be
  checked, and it SHALL NOT cause a `422`;
- the terminal `done` event SHALL be `{"claude_session_id": string | null}`: a non-empty string
  on a Claude CLI turn, exactly as before, and `null` on an AI SDK turn. **BREAKING** for a
  strict client that requires a string; the web client changes in the same change;
- the configuration `503` SHALL answer a caller with no AI route (provider-credentials), with
  `{"detail": "Add a language model in Settings → Advanced to use the assistant."}`, replacing
  "AI chat is not configured on this deployment. Set CLAUDE_CLI_PATH to the claude CLI to enable
  it." It keeps its place in the frozen check order.

`POST /api/sessions/:sessionId/events/generate`'s configuration `503` detail SHALL likewise
become `Add a language model in Settings → Advanced to generate events.` (auto-event-generation
"Generation endpoint guard ladder runs before any spawn"), replacing "Event generation is not
configured on this deployment. Set CLAUDE_CLI_PATH to the claude CLI to enable it." No other
status code, check order, SSE event meaning or route changes, apart from the AI SDK route not
answering `422` for a `claude_session_id` and `null` being accepted as described above.

#### Scenario: A bounded history is accepted
- **WHEN** a caller with an AI route posts a chat message with a `history` of 40 entries whose
  texts total 64 000 characters
- **THEN** the request passes body validation and the response is `200` with an SSE stream

#### Scenario: An oversized history is refused before any spawn
- **WHEN** a caller posts a chat message with 41 `history` entries, or an entry whose `role` is
  `system`, or entries whose texts total more than 64 000 characters
- **THEN** the response is `422` with the existing validation-error body, no subprocess is
  spawned and no model request is made

#### Scenario: An AI SDK turn ends with a null session id
- **WHEN** a chat turn on the AI SDK route completes normally
- **THEN** the stream ends with exactly one `done` event whose `claude_session_id` is `null`

#### Scenario: A CLI turn still returns a session id
- **WHEN** a chat turn on the Claude CLI route completes normally
- **THEN** the stream ends with exactly one `done` event whose `claude_session_id` is a
  non-empty string the client may echo next turn

#### Scenario: A stale session id is ignored on the AI SDK route
- **WHEN** a caller whose route is the AI SDK route posts a chat message with a `claude_session_id` that
  was issued for another session or user
- **THEN** the response is `200` with an SSE stream, not `422`, and `done` carries
  `claude_session_id: null`

#### Scenario: A null session id is accepted on both routes
- **WHEN** a caller posts a chat message with `claude_session_id: null`, once on the Claude CLI
  route and once on the AI SDK route
- **THEN** neither response is `422`; both are `200` with an SSE stream, and the CLI turn starts a
  fresh CLI session

#### Scenario: A foreign session id is still refused on the CLI route
- **WHEN** a caller whose route is the Claude CLI posts a chat message with a
  `claude_session_id` that was issued for another session
- **THEN** the response is `422` and no subprocess is spawned

#### Scenario: A caller with no AI route is pointed to Settings
- **WHEN** a caller with no AI route posts a chat message, and again posts to `events/generate`
- **THEN** the responses are `503 {"detail": "Add a language model in Settings → Advanced to
  use the assistant."}` and `503 {"detail": "Add a language model in Settings → Advanced to
  generate events."}`, no subprocess is spawned and no model request is made

## MODIFIED Requirements

### Requirement: Topic generation endpoint behavior

`POST /api/sessions/:sessionId/topics/generate` SHALL move from unconditional `503` to
configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| caller has no AI route (provider-credentials) | `503 {"detail": "Add a language model in Settings → Advanced to generate topics."}`; no subprocess, no model request |
| caller has a route, requester not an approved user (see "Run features are limited to approved users") | `403 {"detail": "This feature is limited to approved users on this server."}`; checked before every row below, no subprocess |
| caller has a route, another AI turn (chat, AI v2 design, event generation or topic generation) holds the session slot, in this or another process | `409 {detail}`; no subprocess. On `AI_PROVIDER=claude_cli` there is no global ceiling, so turns for other sessions never cause this `409` (run-status-and-sweeper D2) |
| caller has a route, session has no transcript words | `400 {detail}`; no subprocess |
| caller has a route, success | `200 {topics: [...]}` — the session's topics after a crash-safe replace-all generation (prior topics deleted only after the fresh set is created), in the same shape `GET …/topics` returns |
| caller has a route, AI turn failure on either route (spawn/timeout/CLI or provider error/zero topics created; on the AI SDK route also a passed per-turn tool-call, request or byte cap, and a capped or incomplete ending: the step count reached the step cap, the token budget fired, the last step still had tool calls, or the last step finished for output length, content filter, error or another reason, decided from the turn's own step records and not the provider's finish reason alone) | `502 {detail}`; the session's prior topics are **unchanged, byte-for-byte** (never modified — the fresh topics this run created are removed) |

Existing route semantics are otherwise unchanged: an unknown/inaccessible session → the
existing `requireSession` behavior. No other stubbed surface changes — `transcribe.csv` keeps
its frozen `503`. The topics CRUD routes (`GET/POST/PATCH/DELETE …/topics`) are unchanged.

#### Scenario: Unconfigured deployments are byte-for-byte unchanged

- **WHEN** a caller with no AI route (no `llm` credential, and not resolving to the Claude CLI)
  sends `POST /api/sessions/:id/topics/generate`
- **THEN** the response is `503 {"detail": "Add a language model in Settings → Advanced to
  generate topics."}`, no longer the transcription unavailable detail, and no subprocess is
  spawned

#### Scenario: Configured success returns the topics list shape

- **WHEN** a caller with an AI route successfully generates topics
- **THEN** the response is `200` with `{topics}` whose entries match
  `GET /api/sessions/:id/topics` entries

#### Scenario: No-transcript maps to 400, concurrency to 409, CLI failure to 502

- **WHEN** a request from a caller with an AI route has no transcript / finds the session's turn
  slot held / the AI turn fails on either route
- **THEN** the response is `400` / `409` / `502` respectively (each `{detail}`-shaped),
  distinct from the no-route `503`

#### Scenario: A generation stopped by its step cap is a 502
- **WHEN** a caller's AI SDK topic generation creates topics and is stopped by the generation step
  cap or token budget while the model still wanted to call tools
- **THEN** the response is `502 {detail}` and the session's prior topics are unchanged
  byte-for-byte

#### Scenario: A generation whose provider reports stop at the step cap is a 502
- **WHEN** a caller's AI SDK topic generation reaches the generation step cap while its provider
  reports the finish reason `stop` on steps that still carry tool calls, or its last step
  finishes for output length with an unexecuted tool call
- **THEN** the response is `502 {detail}` and the session's prior topics are unchanged
  byte-for-byte

#### Scenario: transcribe.csv stays frozen

- **WHEN** a configured deployment receives `GET /api/sessions/:id/transcribe.csv`
- **THEN** it still responds with the current `503 {detail}`

### Requirement: Provider credential routes
Each user SHALL manage their own provider credentials (provider-credentials) through four routes.
They SHALL be listed in the README endpoint table and in `packages/contract`.

**Access**
- The routes SHALL accept only a session cookie. A request without one SHALL get
  `401 {"detail": "Login required."}`. A Companion device token is never a credential for them.
- They use a system store, and every statement SHALL carry the caller's user id. These predicates
  are the only isolation between users.
- `:kind` SHALL be `llm` or `stt`. Any other value SHALL get `404 {"detail": "Not found."}`.

**A credential's wire shape** is `{kind, provider, base_url, model, key_last4, updated_at}`:
- `base_url` is `null` for every provider but `openai-compatible`;
- `key_last4` is `string | null`: the key's last four characters, and `null` for the keyless
  `claude-cli` provider;
- `model` is the fixed value `"claude-cli"` for the `claude-cli` provider;
- `updated_at` is ISO-8601 UTC.

No route SHALL return a key or its ciphertext.

**Claude CLI access.** A caller *may use the Claude CLI* when `CLAUDE_CLI_PATH` is set and the
caller's verified login email is on `CLAUDE_CLI_EMAILS` (provider-credentials; matched like
`RUN_FEATURE_EMAILS`, but the bootstrap owner is not implicitly on it).

- **`GET /api/me/providers`** SHALL return `200 {llm, stt, run_features_allowed,
  claude_cli_allowed}`:
  - `llm` and `stt` are each the caller's credential of that kind, or `null`;
  - `run_features_allowed` is whether the caller is an approved user for run features ("Run
    features are limited to approved users");
  - `claude_cli_allowed` is whether the caller may use the Claude CLI now.
- **`PUT /api/me/providers/:kind`** with body `{provider, base_url?, model, api_key?}` SHALL
  create or replace the caller's credential of that kind:
  - `provider` SHALL be `openai-compatible`, `anthropic`, `openai`, `google` or `claude-cli` for
    `llm`, and `deepgram` for `stt`;
  - for `claude-cli` the body SHALL be exactly `{provider: "claude-cli"}`: any `api_key`,
    `base_url` or `model` field, `null` included, SHALL get `422`. A well-formed `claude-cli`
    save from a caller who may not use the Claude CLI SHALL get
    `403 {"detail": "The Claude CLI is limited to approved operator accounts."}`. In both cases
    nothing is stored. Otherwise the save stores a keyless credential and answers its wire shape
    (`key_last4: null`, `model: "claude-cli"`, `base_url: null`);
  - `base_url` is required for `openai-compatible` and SHALL be absent or `null` for every other
    key provider, and SHALL follow provider-credentials "LLM base URLs are restricted in
    production mode";
  - `model` is required for every provider but `claude-cli`, and SHALL be 1 to 200 printable
    ASCII characters other than space, after trimming;
  - `api_key` SHALL be 8 to 4096 printable ASCII characters other than space, after trimming:
    - it is required when the caller has no credential of this kind, and when the save changes
      the provider (including from `claude-cli` to a key provider) or the `openai-compatible`
      base URL origin (provider-credentials "A stored key is bound to its destination");
    - otherwise, when absent, the stored key is kept;
  - a value containing NUL SHALL get the existing NUL `400`; any other invalid body SHALL get `422`
    with the existing validation-error body; in both cases nothing is stored;
  - success SHALL answer `200` with the credential's wire shape.
- **`DELETE /api/me/providers/:kind`** SHALL delete the caller's credential of that kind and
  answer `204` with no body. When the caller has none, it SHALL answer
  `404 {"detail": "Provider not set up."}`.
- **`POST /api/me/providers/:kind/test`** with an empty body SHALL test the caller's stored
  credential of that kind, as provider-credentials "The connection test reports without leaking"
  defines:
  - it SHALL answer `200 {ok, detail}`, where `ok` is a boolean and `detail` is one of the fixed
    result strings;
  - for a `claude-cli` credential it SHALL make no outbound request, and SHALL answer
    `{"ok": true, "detail": "Connected."}` when the caller would resolve to the Claude CLI now,
    and otherwise `{"ok": false, "detail": "The Claude CLI isn't available to this account."}`;
    it still counts toward the per-user limit;
  - when the caller has no credential of that kind, it SHALL answer
    `404 {"detail": "Provider not set up."}`;
  - past the per-user limit, it SHALL answer
    `429 {"detail": "Too many connection tests. Try again in a minute."}`.

Saving and deleting SHALL write one audit log line naming the user id, the kind and the action,
never the key.

#### Scenario: Save, read, replace and delete a credential
- **WHEN** a signed-in user saves an `stt` credential with key `dg_secret_abcd`, reads their
  providers, saves again with model `nova-2` and no `api_key`, then deletes it
- **THEN**:
  - the first save answers `200` with `key_last4` `abcd` and no key;
  - the read returns that `stt` credential, `llm: null`, `run_features_allowed` and
    `claude_cli_allowed`;
  - the second save keeps the stored key and changes the model;
  - the delete answers `204`;
  - a later read returns `stt: null`

#### Scenario: The first save needs a key
- **WHEN** a user with no `llm` credential saves one without `api_key`
- **THEN** the response is `422` and nothing is stored

#### Scenario: A new base URL host needs a new key
- **WHEN** a user with an `llm` credential for `https://api.openai.com/v1` saves base URL
  `https://other.example/v1` without `api_key`
- **THEN** the response is `422` naming `api_key`, and the stored credential is unchanged

#### Scenario: A new provider needs a new key
- **WHEN** a user with an `openai-compatible` credential saves `{provider: "openai", model:
  "gpt-5.5"}` without `api_key`
- **THEN** the response is `422` naming `api_key`, and the stored credential is unchanged

#### Scenario: A fixed-host provider takes no base URL
- **WHEN** a user saves an `llm` credential with provider `anthropic` and a `base_url`
- **THEN** the response is `422` and nothing is stored

#### Scenario: A key with a control character is refused
- **WHEN** a user saves an `stt` credential whose `api_key` contains a line feed or a space
- **THEN** the response is `422` and nothing is stored

#### Scenario: Users cannot see each other's credentials
- **WHEN** user A has an `llm` credential and user B reads their providers and deletes `llm`
- **THEN** B reads `llm: null`, the delete answers `404`, and A's credential is unchanged

#### Scenario: Signed-out and device callers are refused
- **WHEN** `GET /api/me/providers` is sent with no session cookie, and again with only a live
  Companion device token as a `Bearer`
- **THEN** both answer `401` `{"detail": "Login required."}`

#### Scenario: An unknown kind is not found
- **WHEN** a user sends `PUT /api/me/providers/tts`
- **THEN** the response is `404 {"detail": "Not found."}`

#### Scenario: Tests past the limit are refused
- **WHEN** a user sends a sixth `POST /api/me/providers/stt/test` within a minute
- **THEN** the response is `429` with the try-again detail and no outbound request is made

#### Scenario: An allowlisted caller saves the Claude CLI
- **WHEN** `CLAUDE_CLI_PATH` is set, a caller on `CLAUDE_CLI_EMAILS` saves
  `PUT /api/me/providers/llm` with `{provider: "claude-cli"}`, then reads their providers
- **THEN** the save answers `200` with `{kind: "llm", provider: "claude-cli", base_url: null,
  model: "claude-cli", key_last4: null, updated_at}`, and the read returns that credential and
  `claude_cli_allowed: true`

#### Scenario: A caller who is not allowlisted cannot save the Claude CLI
- **WHEN** a caller not on `CLAUDE_CLI_EMAILS` saves `{provider: "claude-cli"}`, and again when an
  allowlisted caller saves it while `CLAUDE_CLI_PATH` is blank
- **THEN** both answer `403 {"detail": "The Claude CLI is limited to approved operator
  accounts."}`, nothing is stored, and `GET /api/me/providers` reports
  `claude_cli_allowed: false`

#### Scenario: The Claude CLI takes no key, base URL or model
- **WHEN** an allowlisted caller saves `{provider: "claude-cli", model: "opus"}`, or the same
  body with an `api_key` or a `base_url`
- **THEN** the response is `422` and nothing is stored

#### Scenario: Leaving the Claude CLI needs a key
- **WHEN** a caller with a `claude-cli` credential saves `{provider: "anthropic", model:
  "claude-sonnet-4-5"}` without `api_key`
- **THEN** the response is `422` naming `api_key`, and the stored `claude-cli` credential is
  unchanged

#### Scenario: Testing the Claude CLI makes no outbound request
- **WHEN** a caller with a saved `claude-cli` credential tests `llm` while allowlisted, then is
  removed from `CLAUDE_CLI_EMAILS` and tests again
- **THEN** the first test answers `200 {"ok": true, "detail": "Connected."}`, the second answers
  `200 {"ok": false, "detail": "The Claude CLI isn't available to this account."}`, neither
  makes an outbound request, and both count toward the per-user test limit

### Requirement: events/generate optional body and deleted count

`POST /api/sessions/:sessionId/events/generate` SHALL accept an optional JSON
object body with:

- `regenerate` — optional boolean (default false)
- `selection` — optional array of objects `{ category_id: string,
  option_label?: string | null }`, bounded: at most 500 entries,
  `category_id` ≤ 200 characters, `option_label` ≤ 200 characters

Malformed bodies SHALL yield `400`, including bound violations. Combining
`regenerate: true` with a non-empty `selection` SHALL yield `400`. Success
response SHALL remain JSON `{ created: number, cap_hit: boolean }` and SHALL
include `deleted: number` when the request regenerated. When `regenerate` is
false/absent, `deleted` MAY be omitted. Here "the CLI turn" means the generation
turn on the caller's AI route, the Claude CLI or the AI SDK route alike
(auto-event-generation "Single orchestrator turn over all instructions"). On the
AI SDK route a turn that ends capped (the step count reached the step cap, the
token budget fired, or the last step still had tool calls) or incomplete (the
last step finished for output length, content filter, error or another reason),
or that passes the per-turn tool-call cap or a request or byte cap, has failed:
it answers the `502` and performs no delete. A call past 16 in one step gets a
tool error and does not by itself fail the turn. The regenerate delete
is **after-success**: prior auto rows are snapshotted by id pre-spawn, stay
readable (and keep appearing in `GET …/events`) for the whole run, and are
deleted in one transaction — emitting one existing `event.changed` broadcast
when at least one row was removed, and none otherwise — only after the CLI
turn succeeds **with at least one created event**, and before the
`200` is built; a `502` run deletes nothing, and a successful zero-created
regenerate deletes nothing and responds
`200 { created: 0, cap_hit: false, deleted: 0 }`. Existing status codes and
guard-ladder details for unconfigured / busy / no-transcript / etc. remain as
previously frozen unless superseded by the `auto-event-generation` delta.

#### Scenario: Absent body preserves Generate All

- **WHEN** a client POSTs generate with an empty body
- **THEN** behavior matches prior Generate All (no delete; full instruction set)
  and a `200` success body includes `created` and `cap_hit`

#### Scenario: Regenerate success includes deleted

- **WHEN** a client POSTs `{ "regenerate": true }` and the run succeeds, on either route
- **THEN** the `200` body includes `deleted` as a non-negative integer plus
  `created` and `cap_hit`

#### Scenario: Zero-created regenerate success deletes nothing

- **WHEN** a client POSTs `{ "regenerate": true }` and the generation turn succeeds,
  on either route, without creating any event
- **THEN** the response is `200 { created: 0, cap_hit: false, deleted: 0 }`
  and a subsequent `GET …/events` still returns the prior auto rows

#### Scenario: Regenerate failure leaves the contract surface truthful

- **WHEN** a client POSTs `{ "regenerate": true }` and the generation turn fails on
  either route, including an AI SDK turn stopped by the step cap or the token
  budget while the model still wanted to call tools, or whose last step finished
  for output length with an unexecuted tool call
- **THEN** the response is the fixed opaque `502 {detail}`, no `event.changed`
  broadcasts were emitted beyond those of the run's own inserts, and a
  subsequent `GET …/events` still returns the prior auto rows
