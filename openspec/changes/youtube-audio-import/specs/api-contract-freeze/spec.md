# api-contract-freeze — delta

## ADDED Requirements

### Requirement: YouTube import endpoint behavior

`POST /api/sessions/:sessionId/youtube-import` SHALL move from unconditional `503` to
configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| no `yt-dlp` available (no configured path and none on `PATH`) | `503 {detail}` — identical to the current unavailable response |
| open-network config (`REQUIRE_LOGIN` off + non-loopback + no `IP_ALLOWLIST`) | `503 {detail}`; no subprocess spawned — mirrors the AI chat / AI v2 refusal |
| configured, malformed body or non-allowlisted / unparseable `url` | `400 {detail}`; no subprocess spawned |
| configured, another import for the same session in flight, OR the global concurrency ceiling is reached | `409 {detail}`; no subprocess spawned |
| configured, success | `200 {ok: true}` — one downloaded audio segment attached to the session; if `use_publish_date` is true and the video reports an upload date, the session's `episode_date` is set from it |
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

- **WHEN** a deployment with `REQUIRE_LOGIN` disabled, a non-loopback bind, and no
  `IP_ALLOWLIST` receives `POST /api/sessions/:id/youtube-import` (even with `yt-dlp`
  configured)
- **THEN** the response is `503 {detail}` and no subprocess is spawned, mirroring the AI
  chat / AI v2 open-network refusal

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
- **THEN** the response is `502 {detail}` — distinct from the unconfigured/refused `503` —
  and no audio segment is attached (any inserted metadata row is rolled back)

#### Scenario: Sibling stubs stay frozen

- **WHEN** a configured deployment receives `POST /api/sessions/:id/topics/generate` or
  `GET /api/sessions/:id/transcribe.csv`
- **THEN** both still respond with the current `503 {detail}`

#### Scenario: Session JSON shape is unchanged

- **WHEN** a session that was populated by an opt-in import is listed or fetched
- **THEN** its JSON has the same fields as before, with `episode_date` now carrying the
  imported date rather than `null` — no field added, removed, or retyped

### Requirement: YouTube import success anchors a take; refuses while a recording is live

`POST /api/sessions/:sessionId/youtube-import`, on a **successful** import, SHALL — in
addition to attaching the segment — create two internal events (`Recording N Started`/
`Stopped`) and advance the transport by the imported video's duration. These emit the
**existing** `event.changed` and `transport.changed` WebSocket messages, in their existing
shapes (the same a recorded take emits) — no new message shape. The HTTP success body stays
`200 {ok:true}`. Additionally, the endpoint SHALL respond `409 {detail}` (a new precondition
on the existing `409` status — no new status code) when the session's transport is actively
rolling, so an import cannot clobber a live recording. Failed imports emit none of the take
messages.

#### Scenario: Successful import emits the standard take WS messages

- **WHEN** a client is subscribed to a session's WebSocket and an import succeeds
- **THEN** it receives `event.changed` (for the two `Recording N` events) and
  `transport.changed` (for the duration advance) in their existing shapes, plus the existing
  `audio.changed` — and the HTTP response is still `200 {ok:true}`

#### Scenario: Import while recording maps to 409

- **WHEN** a `youtube-import` request is made while the session transport `is_rolling`
- **THEN** the response is `409 {detail}` (the existing `409` status, new precondition), no
  take is synthesized, and the live recording is unaffected

#### Scenario: Response shape and status matrix are otherwise unchanged

- **WHEN** an import is requested under any other condition
- **THEN** the HTTP status/body match the existing frozen matrix exactly — this change adds
  only success-path event/transport emission and the rolling `409` precondition, no
  response-shape or new-status change

#### Scenario: Failed import emits no take messages

- **WHEN** an import fails after validation
- **THEN** no `event.changed` or `transport.changed` is emitted on its behalf and no
  `Recording` events or transport advance persist
