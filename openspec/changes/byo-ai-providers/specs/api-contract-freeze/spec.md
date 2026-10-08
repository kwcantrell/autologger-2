## ADDED Requirements

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
- `base_url` is `null` for `stt`;
- `key_last4` is the key's last four characters;
- `updated_at` is ISO-8601 UTC.

No route SHALL return a key or its ciphertext.

- **`GET /api/me/providers`** SHALL return `200 {llm, stt, run_features_allowed}`:
  - `llm` and `stt` are each the caller's credential of that kind, or `null`;
  - `run_features_allowed` is whether the caller is an approved user for run features ("Run
    features are limited to approved users").
- **`PUT /api/me/providers/:kind`** with body `{provider, base_url?, model, api_key?}` SHALL
  create or replace the caller's credential of that kind:
  - `provider` SHALL be `openai-compatible` for `llm` and `deepgram` for `stt`;
  - `base_url` is required for `llm` and SHALL be absent or `null` for `stt`, and SHALL follow
    provider-credentials "LLM base URLs are restricted in production mode";
  - `model` SHALL be 1 to 200 printable ASCII characters other than space, after trimming;
  - `api_key` SHALL be 8 to 4096 printable ASCII characters other than space, after trimming:
    - it is required when the caller has no credential of this kind, and when the save changes
      the `llm` base URL origin (provider-credentials "A stored key is bound to its destination");
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
  - the read returns that `stt` credential, `llm: null` and `run_features_allowed`;
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

## MODIFIED Requirements

### Requirement: Transcript generation endpoint behavior
`POST /api/sessions/:sessionId/transcript-words/generate` SHALL behave as the table below
specifies. "Configured" means the caller has a usable speech-to-text credential, as
provider-credentials "Work runs on its user's credentials" resolves it, including the fallback to
`DEEPGRAM_API_KEY` in development mode:

| Condition | Response |
|---|---|
| not configured for the caller | `503 {"detail": "Add a speech-to-text key in Settings → Advanced to generate transcripts."}`; no provider request issued |
| configured, requester not an approved user (see "Run features are limited to approved users") | `403 {"detail": "This feature is limited to approved users on this server."}`; checked before every row below, no provider request issued |
| configured, success | `200 {words: [...]}` — each word in the same trimmed wire shape `GET …/transcript-words` returns, namely exactly the seven keys `{id, session_time, speaker, word, start_sec, end_sec, ordinal}`; `start_sec`/`end_sec` carry remapped session-timeline seconds (`0` for anchorless words) rounded to 3 decimals; the array is the complete post-replace list in ordinal order |
| configured, session has no audio segments | `400 {detail}` |
| configured, segments exist but none is readable | `400 {detail}` (distinct detail) |
| configured, provider succeeds but returns zero words | `400 {detail}` (no-speech detail); existing words preserved |
| configured, another generation run for the same session in flight, in this or another process | `409 {detail}`; the detail names the busy session (title preferred, else id) and the run's start time when the requester may view it (can access the session's show), and falls back to the identifier-free generic in-flight detail for requesters without that access or when the run's start time can no longer be read (the holder released in the race, or its lease has no start time); no provider request issued. A run for another session never causes this `409` (run-status-and-sweeper D3) |
| configured, request aborted before any provider call | `400 {detail}` — a distinct aborted detail, not `200`/`503`; no provider request issued |
| configured, upstream STT failure/timeout, or a group file over the provider size limit | `502 {detail}` |

`session_id` and `created_at_utc` SHALL NOT appear on any transcript-word wire object: the
former was redundant with the path parameter the caller already holds, the latter is
server-internal bookkeeping. The store and the session tables keep both, so
server-internal consumers that read the hub directly are unaffected. Full float precision
for `start_sec`/`end_sec` likewise stays in the store; the rounding is a wire-only
projection.

Existing route semantics are otherwise unchanged: unknown session → the existing
`requireSession` behavior; the request body remains ignored/empty. Every transcript-word
response emits that one trimmed shape — the `GET …/transcript-words` list, the generate
`200`, the create `201`, and the `PATCH` response — and no other transcription surface
changes: `DELETE …/transcript-words/:wordId`, `…/topics` CRUD, and `transcribe.csv` (`503`)
keep their current frozen behavior, except that `GET /api/transcript-generation/status` is
an additional authorized surface (see above).

#### Scenario: Unconfigured deployments are byte-for-byte unchanged
- **WHEN** in production mode a user without a speech-to-text credential sends `POST
  /api/sessions/:id/transcript-words/generate`
- **THEN** the response is `503 {"detail": "Add a speech-to-text key in Settings → Advanced to
  generate transcripts."}`, byte-for-byte for every unconfigured caller, and no provider request
  is made

#### Scenario: Configured success returns the list shape
- **WHEN** a configured deployment successfully generates a transcript
- **THEN** the response is `200` with `{words}` whose entries match the shape of
  `GET /api/sessions/:id/transcript-words` entries

#### Scenario: Every transcript-word response carries the trimmed seven-key shape
- **WHEN** a client reads `GET …/transcript-words`, generates words, creates a word
  (`201`), or patches one
- **THEN** each returned word object has exactly the keys `id`, `session_time`, `speaker`,
  `word`, `start_sec`, `end_sec`, and `ordinal`, with `start_sec`/`end_sec` rounded to 3
  decimals and neither `session_id` nor `created_at_utc` present

#### Scenario: Concurrent run maps to 409 naming the holder
- **WHEN** a generate request for session S arrives while another run for S is already in flight,
  in this or another process, and the requester can access S's show
- **THEN** the response is `409 {detail}` that identifies the busy session and its start time, and
  no provider spend occurs for it

#### Scenario: Concurrent run 409 is identifier-free for non-members
- **WHEN** a generate request for session S from a requester without access to S's show (not a
  member of its studio, or a member without a grant for it) arrives while a run for S is in flight
- **THEN** the existing `requireSession` behavior answers it, so no response names the session,
  and no provider spend occurs for it

#### Scenario: Runs for different sessions are both admitted
- **WHEN** a configured deployment receives a generate request for session R while a run for
  session S is in flight, in this or another process
- **THEN** R's request is not answered `409`

#### Scenario: Pre-provider-call abort maps to 400, not a new status code
- **WHEN** the originating HTTP request is already aborted before any DeepGram request
  would be issued
- **THEN** the response is `400 {detail}` with a detail distinct from the no-audio and
  all-unreadable `400` details, and no provider spend occurs

#### Scenario: Sibling stubs stay frozen
- **WHEN** a configured deployment receives `GET /api/sessions/:id/transcribe.csv`
- **THEN** it still responds with the current `503 {detail}`
