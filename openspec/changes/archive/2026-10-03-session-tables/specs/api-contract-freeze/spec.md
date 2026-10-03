## MODIFIED Requirements

### Requirement: YouTube import endpoint behavior

`POST /api/sessions/:sessionId/youtube-import` SHALL move from unconditional `503` to
configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| no `yt-dlp` available (no configured path and none on `PATH`) | `503 {detail}` — identical to the current unavailable response |
| configured, malformed body or non-allowlisted / unparseable `url` | `400 {detail}`; no subprocess spawned |
| configured, another import for the same session in flight, OR the global concurrency ceiling is reached | `409 {detail}`; no subprocess spawned |
| configured, success | `200 {ok: true}` — one downloaded audio segment attached to the session; if `use_publish_date` is true and the video reports an upload date, the session's `episode_date` is set from it (best-effort: a failed episode-date write after the segment is attached is logged and still returns this success; the session's live projection commits with the anchor, so it cannot fail separately) |
| configured, download/extraction failure, hang timeout, over the 4-hour duration cap, over the byte-size cap, a live/unknown-duration stream, an unsupported produced container, or a blob-write failure | `502 {detail}`; no audio segment attached (any inserted metadata row is rolled back) |

Existing route semantics are otherwise unchanged: an unknown or inaccessible session →
the existing `requireSession` behavior. The success body remains `{ok: true}` — the shape
the client's `useYoutubeImport` mutation already reads. The session JSON shape returned by
list/detail routes is unchanged: `episode_date` was already a nullable field, and this
change only lets a successful opt-in import populate it (a value change, not a shape
change). No other stubbed surface changes — `…/topics/generate` and `transcribe.csv` keep
their current frozen `503`.

#### Scenario: Deployments without yt-dlp are byte-for-byte unchanged

- **WHEN** a deployment with no configured `yt-dlp` path and no `yt-dlp` on `PATH` receives
  `POST /api/sessions/:id/youtube-import`
- **THEN** the response status and body match the pre-change `503 {detail}` exactly, and no
  subprocess spawn or outbound YouTube request occurs

#### Scenario: Open-network deployment maps to 503

- **WHEN** a signed-in member's `POST /api/sessions/:id/youtube-import` reaches a configured
  deployment bound to a non-loopback address with no `IP_ALLOWLIST`
- **THEN** no open-network `503` is returned (that refusal is removed: login is always
  required), and the response follows the matrix above

#### Scenario: Concurrent same-session import or global-ceiling maps to 409

- **WHEN** a configured deployment receives a `youtube-import` request for a session whose
  previous import is still running, or when the global concurrency ceiling is already reached
- **THEN** the response is `409 {detail}` and no subprocess is spawned

#### Scenario: Configured success returns the frozen ok shape

- **WHEN** a configured deployment successfully imports a video's audio
- **THEN** the response is `200` with body `{ok: true}`, and the session gains exactly one
  audio segment

#### Scenario: Non-allowlisted URL maps to 400 before any spend

- **WHEN** a configured deployment receives a request whose `url` host is not an exact member
  of the YouTube allowlist (e.g. `youtube.com.evil.com`) or is not a parseable `http(s)` URL
- **THEN** the response is `400 {detail}` and no `yt-dlp` subprocess is spawned

#### Scenario: Download/extraction failure or unsupported container maps to 502

- **WHEN** a configured, validated request fails to download or extract audio, times out,
  breaches the byte/duration bound, is a live/unknown-duration stream, produces an
  unsupported container, or the blob write fails
- **THEN** the response is `502 {detail}` — distinct from the unconfigured `503` —
  and no audio segment is attached (any inserted metadata row is rolled back)

#### Scenario: Sibling stubs stay frozen

- **WHEN** a configured deployment receives `POST /api/sessions/:id/topics/generate` or
  `GET /api/sessions/:id/transcribe.csv`
- **THEN** both still respond with the current `503 {detail}`

#### Scenario: Session JSON shape is unchanged

- **WHEN** a session that was populated by an opt-in import is listed or fetched
- **THEN** its JSON has the same fields as before, with `episode_date` now carrying the
  imported date rather than `null` — no field added, removed, or retyped

#### Scenario: A failed anchor leaves no segment
- **WHEN** a configured import's audio is fetched and stored, and the transaction that anchors the
  take (its `Recording N` events, the transport advance and the live projection) then fails
- **THEN** the response is `502 {detail}`, the session has no new audio segment, and its events,
  transport and listed `event_count` are unchanged

### Requirement: Text containing NUL is refused
The catalog cannot store the character U+0000 (NUL). A request value containing NUL that would
reach a catalog statement, whether from a path segment, a query value or a body field, SHALL be
refused with status `400` and a JSON body `{"detail": "<message>"}`. The statement carrying it
SHALL NOT be sent, and a catalog transaction it belongs to SHALL write nothing.

Session content is catalog content (ADR 0021 slice 7b-1), so this covers it too: an event's
category, message or metadata, a transcript word, a topic, a dashboard and every other value a
session write stores. A session write carrying NUL SHALL save nothing and send no `*.changed`
broadcast, whether the value came from the request or from a server-side source (a transcription
provider, an AI tool call, an imported sheet); such a source's run reports the failure through
its existing failure path.

These cases are handled explicitly:
- `POST /api/companion/presence` with a `session_id` containing NUL SHALL be refused with `400`,
  and SHALL store no presence.
- An OAuth callback whose `state` contains NUL SHALL be treated as an invalid state, with the
  existing `state_invalid` redirect.
- A sign-in whose identity token has a subject or email claim containing NUL SHALL be refused
  with the existing `token_invalid` redirect.
- NUL SHALL be removed from the given-name, family-name and picture claims before they are
  stored.

Values without NUL SHALL behave as before.

#### Scenario: NUL in a show name is a 400
- **WHEN** a client creates a show whose `name` contains `\u0000`
- **THEN** the response is `400` with a JSON `detail`, and no show is created

#### Scenario: NUL in a team display name is a 400
- **WHEN** a team admin creates a team whose `display_name` contains `\u0000`
- **THEN** the response is `400` with a JSON `detail`, as for the family's other validation errors, and no team is created

#### Scenario: NUL in a path segment is a 400
- **WHEN** a client requests a team-scoped route whose team id path segment contains a percent-encoded NUL
- **THEN** the response is `400` with a JSON `detail`, not `500`

#### Scenario: NUL in a presence session id is refused
- **WHEN** a Companion client posts presence with a `session_id` containing NUL
- **THEN** the response is `400`, and a later `GET /api/companion/state` answers as if that presence had never been posted

#### Scenario: NUL in the OAuth state is an invalid state
- **WHEN** the OAuth callback receives a `state` containing a percent-encoded NUL
- **THEN** it redirects with `login_error=state_invalid`

#### Scenario: NUL in the email claim refuses sign-in
- **WHEN** a first Google sign-in carries an `email` containing NUL
- **THEN** it redirects with `login_error=token_invalid` and creates no user

#### Scenario: NUL in a name claim is stripped
- **WHEN** a first Google sign-in carries a `given_name` containing NUL and valid other claims
- **THEN** the user is created, and the stored given name is the claim with NUL removed

#### Scenario: NUL in an event message is a 400
- **WHEN** a client logs an event whose `message` contains `\u0000`
- **THEN** the response is `400` with a JSON `detail`, the session has no new event, and no
  `event.changed` frame is sent

## REMOVED Requirements

### Requirement: Catalog mirror failures don't fail saved session changes
**Reason**: The session's live projection is now written inside the session write's own
transaction (catalog-database "The session live projection commits with the session write"). A
session change and its projection commit or fail together, so a saved change can no longer meet
a failed projection write. A failure anywhere in the write now answers the route's existing error
status with nothing saved, instead of success with a stale list; a client retry no longer repeats
a saved change.
**Migration**: None for clients: success responses are unchanged, and the failure statuses are the
routes' existing ones (`500`; `502` for a YouTube import). The warning log line
`[mirror] session … live projection not written` is no longer emitted.
