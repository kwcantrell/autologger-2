# provider-credentials

## Purpose
Each user can store their own AI provider credentials: a language model (OpenAI-compatible,
Anthropic, OpenAI or Google) and a speech-to-text service. The server keeps each key encrypted, write-only and bound to its
destination, tests a connection without leaking anything, and runs that user's requests and jobs
on that user's credentials.

## ADDED Requirements

### Requirement: Development mode is explicit
The server SHALL decide its provider mode once at boot. It is **development mode** only when
`NODE_ENV` is exactly `development` or `test`. Every other value, unset and misspelled included,
SHALL be **production mode**.

Every rule in this capability that differs between the modes SHALL read that boot decision, never
`NODE_ENV` at request time. Production mode is the default, so a missing or unexpected value keeps
every protection on.

#### Scenario: An unset NODE_ENV is production mode
- **WHEN** the server boots with `NODE_ENV` unset, or set to `staging`
- **THEN** it runs in production mode: base URL restrictions apply and `DEEPGRAM_API_KEY` is not
  used as a fallback

### Requirement: A user holds at most one credential per kind
A credential SHALL belong to exactly one user, and a user SHALL hold at most one credential of
each kind.

The kinds are `llm` and `stt`:
- **`llm`** has one of these providers, a model and an API key:
  - `openai-compatible`, which also has a base URL the user chooses;
  - `anthropic`, `openai` or `google`, each with its fixed API host and no base URL.
- **`stt`** has provider `deepgram`, a model and an API key. It has no base URL.

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

### Requirement: Provider keys are encrypted at rest and write-only
The server SHALL store each API key only encrypted, with AES-256-GCM:
- each write uses a fresh random 12-byte nonce;
- the additional authenticated data is:
  - the owning user id;
  - the kind;
  - the provider;
  - for `openai-compatible`, the base URL's normalized origin (lowercase scheme and host, the
    default port omitted), which the row also stores; empty for every other provider;
- the encryption key is derived from `PROVIDER_KEYS_SECRET`, and each row records a key version.

The stored base URL SHALL be normalized the same way before it is saved.

A key SHALL consist only of printable ASCII characters other than space (U+0021 to U+007E), so it
can never form an invalid header.

**Never exposed.** Neither the plaintext key nor the ciphertext SHALL appear in any HTTP response,
log line, error detail or WebSocket message. The only part of a key the server returns is its last
four characters. An error raised while building or sending a provider request SHALL NOT be logged,
stored or forwarded with its message or properties; only a fixed classification of it may be.

**Failed decryption** SHALL be treated as "no usable credential":
- the request answers as if the user had no credential of that kind;
- the server logs one line naming the user id and kind, never the key or ciphertext.

**The master key.**
- The production entry point SHALL refuse to boot when `PROVIDER_KEYS_SECRET` is missing, or does
  not base64-decode to exactly 32 bytes.
- It SHALL also refuse when the secret does not match the check value recorded in the catalog:
  - the check value is a keyed digest of a fixed label under the derived key;
  - it is written on the first boot that finds none;
  - it is never the secret itself.
- A missing or malformed secret SHALL be refused before the `DATA_DIR` lock is taken.
- A mismatch SHALL be refused once the catalog is ready, before the server accepts any request,
  and the lock SHALL be released on exit.
- Both errors SHALL name the variable but not its value.
- Other entry points (tests and scripts) MAY run with a per-process random secret when the
  variable is unset.

#### Scenario: A stored key is not readable in the database
- **WHEN** a user saves an API key and the row is read directly from the catalog
- **THEN** the row holds a nonce, ciphertext, tag, key version and the key's last four
  characters, and no column holds the key

#### Scenario: A ciphertext moved to another user does not decrypt
- **WHEN** the encrypted columns of user A's `stt` row are copied into user B's `stt` row and B
  requests transcript generation
- **THEN** decryption fails, B's request answers as unconfigured, and A's key is never sent to
  the provider

#### Scenario: Boot refuses without the secret
- **WHEN** the production entry point boots with `PROVIDER_KEYS_SECRET` unset, or set to a value
  that decodes to 16 bytes
- **THEN** boot fails with an error naming `PROVIDER_KEYS_SECRET` and not echoing the value, and
  the `DATA_DIR` lock was never taken

#### Scenario: Boot refuses a different secret
- **WHEN** the server booted once with secret S1, and boots again with a different valid secret
  S2
- **THEN** the second boot fails naming `PROVIDER_KEYS_SECRET` as not matching the stored keys,
  before accepting any request

#### Scenario: A provider error never carries the key
- **WHEN** sending a provider request fails with an error whose message contains the request's
  headers
- **THEN** no log line, response or stored record contains the key or that message

### Requirement: A stored key is bound to its destination
A stored key SHALL be sent only to the provider and, for `openai-compatible`, the base URL origin
it was saved with. Changing a credential's provider, or an `openai-compatible` credential's base URL
origin, SHALL require a new API key in the same save. A save that changes either without a key SHALL
be refused and SHALL leave the stored credential unchanged.

A save that keeps the stored key SHALL change only the other fields of the row it read, and SHALL
NOT restore a key that was deleted or replaced after that read.

The `stt` key for DeepGram SHALL be sent only to DeepGram's fixed API host.

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

### Requirement: The connection test reports without leaking
A connection test SHALL make exactly one outbound request using the credential the test names. It
SHALL return a result from a fixed set of server-authored strings:
- connected;
- the key was rejected;
- the model was not found;
- the provider could not be reached;
- the provider timed out;
- the provider answered unexpectedly, with only its HTTP status code;
- the saved key cannot be read and must be entered again.

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

### Requirement: LLM base URLs are restricted in production mode
The `openai-compatible` base URL SHALL be an absolute `http` or `https` URL at most 2048 characters long, with:
- no user name or password;
- no query string;
- no fragment.

**In production mode**, the base URL SHALL also use `https` on the default port (443). Every
outbound request to it (the connection test now, model calls later) SHALL be refused when the host
resolves to any of these:
- a loopback, private, link-local, carrier-grade NAT, multicast, unspecified or otherwise
  reserved address, in IPv4 or IPv6;
- the IPv4-mapped or NAT64 form of any of those.

The resolved address SHALL be the one the connection uses, so a DNS answer cannot change between
the check and the request.

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

### Requirement: Work runs on its user's credentials
A request that needs a provider SHALL use the signed-in caller's credential of the matching kind.
A background job SHALL use its creator's credential, read when the job needs it.

When the user has no usable credential of that kind, the server SHALL answer with that feature's
"unconfigured" response. The one exception is speech to text in development mode: there,
transcription SHALL fall back to `DEEPGRAM_API_KEY` and `DEEPGRAM_MODEL` when they are set.

In production mode, `DEEPGRAM_API_KEY` SHALL NOT be used for any request.

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
