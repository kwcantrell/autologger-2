## MODIFIED Requirements

### Requirement: A user holds at most one credential per kind
A credential SHALL belong to exactly one user, and a user SHALL hold at most one credential of
each kind.

The kinds are `llm` and `stt`:
- **`llm`** has one of these providers:
  - `openai-compatible`, with a base URL the user chooses, a model and an API key;
  - `anthropic`, `openai` or `google`, each with its fixed API host, no base URL, a model and an
    API key;
  - `claude-cli`, the operator's Claude CLI login, with no API key, no base URL and the fixed
    model `claude-cli`.
- **`stt`** has provider `deepgram`, a model and an API key. It has no base URL.

**The `claude-cli` provider** SHALL be available only to a caller on `CLAUDE_CLI_EMAILS`, and only
while `CLAUDE_CLI_PATH` is set:
- `CLAUDE_CLI_EMAILS` is an operator allowlist of email addresses, set per environment. It is
  matched like `RUN_FEATURE_EMAILS`: each entry and the caller's email are trimmed and compared
  exactly, ignoring ASCII case only.
- Unlike `RUN_FEATURE_EMAILS`, the bootstrap owner SHALL NOT be implicitly on the list. The list
  names exactly who may use the operator's Claude subscription.
- A save of provider `claude-cli` by any other caller, or while `CLAUDE_CLI_PATH` is blank, SHALL
  be refused with `403` and SHALL store nothing.
- The providers list SHALL report whether the caller may choose `claude-cli` now.

A provider with a fixed API host SHALL send its key only to that host. In production mode the fixed
hosts SHALL be constants that no environment variable, configuration value or request can change.

#### Scenario: Fixed hosts can't be overridden in production
- **WHEN** the production entry point boots with any environment
- **THEN** the connection tests for `openai`, `anthropic`, `google` and `deepgram` go only to
  `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com` and
  `api.deepgram.com`

The `kind` and `provider` values are an open set that later changes may extend. This change
accepts only the pairs above.

A credential SHALL be used only for requests made by its user and jobs created by its user. No
other user, role or administrator SHALL read it, use it or change it.

#### Scenario: Saving a second credential of a kind replaces the first
- **WHEN** a user saves an `stt` credential and then saves another `stt` credential
- **THEN** the user holds one `stt` credential, the second

#### Scenario: Another user's credential is never used
- **WHEN** user A has an `stt` credential, user B has none, and B requests transcript generation
  on a session both can access
- **THEN** B's request does not use A's key

#### Scenario: A user who is not listed cannot choose the Claude CLI
- **WHEN** `CLAUDE_CLI_PATH` is set, a user whose email is not on `CLAUDE_CLI_EMAILS` saves an
  `llm` credential with provider `claude-cli`
- **THEN** the save answers `403`, and the user's stored `llm` credential, if any, is unchanged

#### Scenario: The bootstrap owner is not implicitly listed
- **WHEN** `CLAUDE_CLI_EMAILS` does not name the bootstrap owner and the owner saves provider
  `claude-cli`
- **THEN** the save answers `403` and nothing is stored

#### Scenario: A listed user saves the Claude CLI without a key
- **WHEN** `CLAUDE_CLI_PATH` is set and a user whose email is on `CLAUDE_CLI_EMAILS`, in any
  letter case, saves provider `claude-cli` with no key, base URL or model
- **THEN** the save succeeds and the stored `llm` credential has provider `claude-cli`, model
  `claude-cli`, no base URL and no key

### Requirement: A stored key is bound to its destination
A stored key SHALL be sent only to the provider and, for `openai-compatible`, the base URL origin
it was saved with. Changing a credential's provider, or an `openai-compatible` credential's base URL
origin, SHALL require a new API key in the same save. A save that changes either without a key SHALL
be refused and SHALL leave the stored credential unchanged.

A save that keeps the stored key SHALL change only the other fields of the row it read, and SHALL
NOT restore a key that was deleted or replaced after that read.

The `stt` key for DeepGram SHALL be sent only to DeepGram's fixed API host.

**Model calls.** An AI turn on an `llm` key SHALL send model requests from the server, in
process, only through the server's guarded model requests (ai-topics-chat "Model requests on the
AI SDK route are guarded"):
- every model request SHALL go only to the provider's fixed host on that provider's model-request
  path, with the credential's model as exactly one path segment where the path names it (so a
  model id containing `/` or `..` cannot retarget the path), or for `openai-compatible` to the
  credential's saved base URL origin at `<saved base path>/chat/completions`; a URL with an encoded
  slash, a `..` segment or a doubled `/`, and a request to any other destination, SHALL be refused
  without a connection;
- the key SHALL be sent only in the provider's authentication header of a request to that
  destination, and SHALL NOT appear in any log, SSE event, error detail, stored row or response;
- redirects SHALL NOT be followed: a `3xx` answer is returned unfollowed;
- a model request SHALL wait at most 120 s for its response headers; this header timeout covers
  only that wait, and the route's turn timeout bounds the whole turn (the connection test keeps
  its own rule below);
- each turn SHALL be capped at 60 requests (retries included), 4 MB per request body, 48 MB of
  request bodies and 64 MB of responses; past a cap the request SHALL be refused without a
  connection, or the response ended, and the turn SHALL end with the upstream-failed error;
- OpenAI model requests SHALL ask OpenAI not to store the conversation (`store: false`);
- the turn SHALL use only the credential's key and destination: the server SHALL NOT fall back to
  an operator key or base URL from the environment when the credential's is absent, and a turn
  with no usable key SHALL NOT start;
- a provider error SHALL be classified by its error class and status only, and its content
  (which carries the prompt and the provider's body) SHALL NOT be logged, stored or forwarded.

#### Scenario: A stolen session cannot redirect the key
- **WHEN** a request with a user's session changes their `llm` base URL to another host without
  sending a key, and then runs the connection test
- **THEN** the save is refused with `422`, the stored credential is unchanged, and no request
  carrying the key reaches the other host

#### Scenario: Switching provider needs the key again
- **WHEN** a user with an `openai-compatible` credential saves provider `anthropic` without
  sending a key
- **THEN** the save is refused with `422`, the stored credential is unchanged, and the stored key
  is never sent to Anthropic

#### Scenario: A model-only save does not resurrect a removed key
- **WHEN** a save that keeps the stored key and a delete of that credential run concurrently, and
  the delete commits first
- **THEN** the credential stays deleted

#### Scenario: The key reaches only the credential's provider
- **WHEN** a user with an `anthropic` credential runs an AI chat turn
- **THEN** every model request goes to `api.anthropic.com` and carries the key only in its
  `x-api-key` header, and the key appears in no log line, SSE event or error detail

#### Scenario: A model request to another destination is refused
- **WHEN** during a turn on an `openai-compatible` credential a model request targets a host other
  than the saved base URL origin, or a path outside its base path
- **THEN** no connection is opened and the key is sent nowhere

#### Scenario: A model request redirect is not followed
- **WHEN** an `openai-compatible` provider answers a model request with `302` to another host
- **THEN** no request is made to the other host

#### Scenario: A model id cannot move the request off its path
- **WHEN** a user's `google` credential has the model `../../v1/other`, and the user runs an AI
  turn
- **THEN** no request leaves the provider's model-request path, no connection is opened for the
  retargeted URL, and the turn ends with the upstream-failed error

#### Scenario: Environment keys are never used for a user's turn
- **WHEN** the server's environment sets `ANTHROPIC_API_KEY` or `OPENAI_BASE_URL`, and a user runs
  an AI turn on their own `anthropic` or `openai` credential
- **THEN** every model request carries only the user's key and goes only to the provider's fixed
  host

#### Scenario: A turn's request cap stops further spend
- **WHEN** a turn has made 60 model requests and makes another
- **THEN** the request is refused without a connection and the turn ends with the upstream-failed
  error

### Requirement: The connection test reports without leaking
A connection test SHALL make exactly one outbound request using the credential the test names,
except for provider `claude-cli`, which makes none. It SHALL return a result from a fixed set of
server-authored strings:
- connected;
- the key was rejected;
- the model was not found;
- the provider could not be reached;
- the provider timed out;
- the provider answered unexpectedly, with only its HTTP status code;
- the saved key cannot be read and must be entered again;
- "The Claude CLI isn't available to this account."

A host the outbound rules refuse SHALL get the same "could not be reached" result as a host that
does not answer, so the test cannot tell internal names apart.

**Request rules.**
- The test SHALL NOT return, log or store the upstream response body or headers.
- It SHALL NOT follow redirects.
- The whole test, name resolution included, SHALL time out after 10 seconds.
- Each user SHALL be able to run at most 5 tests in a test window, across every kind and every
  server process, whether or not the credentials were deleted and saved again in between:
  - a window opens with the first test after the previous window ended, and lasts one minute;
  - further tests in that window SHALL be refused without any outbound request;
  - the count and the window SHALL be updated atomically, so concurrent tests in different
    processes can't exceed the limit.

**For `llm`**, the request SHALL read model information, which costs no usage:
- `openai-compatible`: `GET {base_url}/models` with `Authorization: Bearer <key>`. The result is
  "connected" when the model is listed, "model not found" when the response lists models but not
  this one, and "connected" when it lists no models in the OpenAI-compatible shape.
- `openai`: `GET https://api.openai.com/v1/models/{model}` with `Authorization: Bearer <key>`;
- `anthropic`: `GET https://api.anthropic.com/v1/models/{model}` with `x-api-key: <key>` and the
  `anthropic-version` header (the model may be an alias);
- `google`: `GET https://generativelanguage.googleapis.com/v1beta/models/{model}` with
  `x-goog-api-key: <key>`.

For the three fixed-host providers, a 2xx answer is "connected" and `404` is "model not found".
For every provider, `401` or `403` is "the key was rejected". Google answers a bad key with `400`
and the error reason `API_KEY_INVALID`: the server SHALL read that reason from the capped error
body to classify it as "the key was rejected", and SHALL NOT return, log or store the body. The
model is percent-encoded as one path segment.

Providers with a fixed host are not subject to the base URL rules below.

**For `llm` with provider `claude-cli`**, the test SHALL make no outbound request and SHALL NOT run
the CLI. It is "connected" ("Connected.") when an AI turn by the caller would run on the
operator's Claude CLI now, and otherwise "The Claude CLI isn't available to this account." It
SHALL still count as a test in the caller's test window.

**For `stt` with provider `deepgram`**, the request SHALL send a fixed silent audio clip of at most
0.25 seconds to DeepGram's transcription endpoint with the credential's model. The key is sent
only in the `Authorization` header:
- a 2xx answer is "connected";
- `401` or `403` is "the key was rejected";
- any other status is "unexpected".

#### Scenario: A rejected key is named, not echoed
- **WHEN** a user tests an `llm` credential and the host answers `401` with a body containing
  details
- **THEN** the result says the key was rejected, and neither the response nor the server log
  holds the upstream body or the key

#### Scenario: A redirect is not followed
- **WHEN** the base URL answers `302` to another host
- **THEN** no request is made to the other host and the result reports an unexpected answer with
  status `302`

#### Scenario: Deleting and re-saving does not reset the limit
- **WHEN** a user runs five tests, deletes the credential, saves it again and runs a sixth test in
  the same window
- **THEN** the sixth is refused without any outbound request

#### Scenario: A bad Google key reads as rejected
- **WHEN** a user tests a `google` credential and Google answers `400` with reason
  `API_KEY_INVALID`
- **THEN** the result says the key was rejected, and the error body is in no response or log

#### Scenario: The sixth test in a minute is refused
- **WHEN** a user runs five connection tests, through any server processes, and a sixth in the same
  test window
- **THEN** the sixth is refused without any outbound request

#### Scenario: Testing the Claude CLI as a listed user
- **WHEN** `CLAUDE_CLI_PATH` is set and a user on `CLAUDE_CLI_EMAILS` with a saved `claude-cli`
  credential runs the connection test
- **THEN** the result is `{ok: true, detail: "Connected."}`, no outbound request is made and the
  CLI is not run

#### Scenario: Testing the Claude CLI after removal from the list
- **WHEN** a user with a saved `claude-cli` credential is no longer on `CLAUDE_CLI_EMAILS` and runs
  the connection test
- **THEN** the result is `{ok: false, detail: "The Claude CLI isn't available to this account."}`
  and the test counts toward the user's test window

### Requirement: LLM base URLs are restricted in production mode
The `openai-compatible` base URL SHALL be an absolute `http` or `https` URL at most 2048 characters long, with:
- no user name or password;
- no query string;
- no fragment.

**In production mode**, the base URL SHALL also use `https` on the default port (443). Every
outbound request to it (the connection test, and every model request the server makes during an
AI turn) SHALL be refused when the host resolves to any of these:
- a loopback, private, link-local, carrier-grade NAT, multicast, unspecified or otherwise
  reserved address, in IPv4 or IPv6;
- the IPv4-mapped or NAT64 form of any of those.

The resolved address SHALL be the one the connection uses, so a DNS answer cannot change between
the check and the request. The server SHALL resolve and check the host again for each connection
it opens during an AI turn, so a DNS answer that changes after the save cannot reach a refused address.

**In development mode**, `http`, any port, `localhost` and private addresses SHALL be allowed, so a
developer can point at a local model server.

#### Scenario: A private address is refused in production mode
- **WHEN** in production mode a user's base URL is `https://10.0.0.5/v1`, or a host name that
  resolves to `169.254.169.254`, and they test it
- **THEN** no connection is opened and the result says the provider could not be reached

#### Scenario: Plain http, another port or a query is refused in production mode
- **WHEN** in production mode a user saves base URL `http://api.example.com/v1`,
  `https://api.example.com:8443/v1` or `https://api.example.com/v1?x=1`
- **THEN** each save answers `422` and nothing is stored

#### Scenario: A local model server works in development mode
- **WHEN** in development mode a user saves base URL `http://localhost:11434/v1` and tests it
- **THEN** the request is made

#### Scenario: A host that rebinds after saving is refused at turn time
- **WHEN** in production mode a user saves and tests an `openai-compatible` base URL whose host
  resolves to a public address, the host's DNS answer then changes to `127.0.0.1`, and the user
  runs an AI turn
- **THEN** the server opens no connection to `127.0.0.1`, and the turn ends with an upstream
  failure

### Requirement: Work runs on its user's credentials
A request that needs a provider SHALL use the signed-in caller's credential of the matching kind.
A background job SHALL use its creator's credential, read when the job needs it.

When the user has no usable credential of that kind, the server SHALL answer with that feature's
"unconfigured" response. The one exception is speech to text in development mode: there,
transcription SHALL fall back to `DEEPGRAM_API_KEY` and `DEEPGRAM_MODEL` when they are set.

In production mode, `DEEPGRAM_API_KEY` SHALL NOT be used for any request.

**AI turns.** AI chat, topic generation and event generation SHALL run on the caller's AI route,
resolved from the caller's `llm` credential on every turn:
- **`claude-cli`:** the operator's Claude CLI, when `CLAUDE_CLI_PATH` is set and the caller is on
  `CLAUDE_CLI_EMAILS`; otherwise unconfigured.
- **Another provider:** the AI SDK route, which calls that provider from the server in process on
  that credential, when the key decrypts; otherwise unconfigured.
- **No `llm` credential:** unconfigured, in every mode. There is no development-mode or other
  fallback to the Claude CLI: an allowlisted caller gets the CLI only by saving the `claude-cli`
  provider.

`CLAUDE_CLI_PATH` alone SHALL NOT make AI available to anyone. In every mode, a turn SHALL run on
the operator's Claude CLI only when the caller saved `claude-cli`, is on `CLAUDE_CLI_EMAILS`, and
`CLAUDE_CLI_PATH` is set. The
allowlist SHALL be read on every turn, so a change to it applies from the next turn.

#### Scenario: The caller's own DeepGram key is used
- **WHEN** a user with an `stt` credential generates a transcript
- **THEN** the DeepGram request carries that user's key and model

#### Scenario: Production mode does not fall back to the operator key
- **WHEN** in production mode `DEEPGRAM_API_KEY` is set and a user without an `stt` credential
  generates a transcript
- **THEN** the response is the unconfigured `503` and no DeepGram request is made

#### Scenario: Development mode falls back to the operator key
- **WHEN** in development mode `DEEPGRAM_API_KEY` is set and a user without an `stt` credential
  generates a transcript
- **THEN** the DeepGram request carries `DEEPGRAM_API_KEY`

#### Scenario: A user's own language model runs their AI turns
- **WHEN** a user with an `openai` credential sends an AI chat message
- **THEN** the turn runs on the AI SDK route, whose model requests carry that user's key and
  model, and the operator's Claude CLI is not run

#### Scenario: A user who is not listed gets no operator CLI
- **WHEN** `CLAUDE_CLI_PATH` is set and a user who is not on
  `CLAUDE_CLI_EMAILS` and has no `llm` credential requests AI chat, topic generation or event
  generation
- **THEN** the response is that feature's unconfigured `503` and the Claude CLI is not run

#### Scenario: Removal from the allowlist applies on the next turn
- **WHEN** a user with a saved `claude-cli` credential runs an AI turn on the CLI, the operator
  removes the user from `CLAUDE_CLI_EMAILS`, and the user starts another turn
- **THEN** the second turn answers the unconfigured `503` and the CLI is not run

#### Scenario: A listed user who chose another provider runs on it
- **WHEN** a user on `CLAUDE_CLI_EMAILS` has a saved `anthropic` credential and generates topics
- **THEN** the turn runs on the AI SDK route with that user's key, not on the Claude CLI

#### Scenario: A listed user without a saved language model is unconfigured in every mode
- **WHEN** in development or production mode `CLAUDE_CLI_PATH` is set and a user on
  `CLAUDE_CLI_EMAILS` with no `llm` credential sends an AI chat message
- **THEN** the response is the unconfigured `503` and the Claude CLI is not run

#### Scenario: Development mode does not extend the CLI to unlisted users
- **WHEN** in development mode `CLAUDE_CLI_PATH` is set and a user who is not on
  `CLAUDE_CLI_EMAILS` and has no `llm` credential sends an AI chat message
- **THEN** the response is the unconfigured `503`
