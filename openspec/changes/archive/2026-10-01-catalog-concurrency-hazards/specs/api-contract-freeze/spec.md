## ADDED Requirements

### Requirement: Catalog mirror failures don't fail saved session changes
A session route that saves a change to the session's own store and then mirrors the session's live
projection into the catalog SHALL return its normal success response when the session change was
saved, even if the catalog mirror write fails. This covers:
- Companion log and transport;
- event start, stop, log, update and delete;
- event generation;
- local and YouTube audio import.

The failure SHALL be logged at warning level. A later change to the session SHALL rewrite the
whole projection. A YouTube import SHALL also succeed when only its episode-date write fails.
Before, these paths returned `500` (or `502` for YouTube import) for work already saved, and a
client retry repeated it.

#### Scenario: A mirror failure after an event is logged
- **WHEN** a client logs an event and the catalog mirror write fails after the event is saved
- **THEN** the response is the normal success body, the event exists once, and a warning is logged

#### Scenario: The next change heals the mirror
- **WHEN** a mirror write failed, and the session then receives another change whose mirror succeeds
- **THEN** the catalog's live projection matches the session's state

### Requirement: Concurrent first sign-in succeeds
Two OAuth callbacks for the same Google subject, carrying different valid states, that both find
no existing user SHALL both complete sign-in to the one user created. Neither SHALL get a `500`.
The second follows the existing-user path, including its disabled-account redirect. This replaces
the latent `500` that the unique Google-subject constraint gave the loser.

This narrows "Unexpected internal error stays 500" only for this race: a duplicate first
sign-in is an expected outcome, not an internal error. Any other catalog failure in the callback
still gives `500`.

#### Scenario: Two tabs sign in for the first time
- **WHEN** two first sign-in callbacks for one Google subject run at the same time with different valid states
- **THEN** both redirect to `/` with a session cookie, and exactly one user exists for that subject

### Requirement: Log-import job lines carry no internal error text
The lines and `error` field of a log-import job SHALL keep showing the operator-readable message
of a domain failure, unchanged. Examples are a missing session, missing audio segments or seam
metadata, a missing OTHER category, a failed part sync, an unreadable or unparseable sheet, and a
transcript failure. A failure raised by the catalog or its database driver SHALL appear as a
generic line naming the session (or, for a job-level failure, a generic `Failed` line), and its
detail SHALL be logged on the server only.

#### Scenario: A catalog failure during a job
- **WHEN** a catalog statement fails while a log-import job processes a session
- **THEN** the job's line for that session says the session failed without the database error's text, and the server log has the error

## MODIFIED Requirements

### Requirement: YouTube import endpoint behavior

`POST /api/sessions/:sessionId/youtube-import` SHALL move from unconditional `503` to
configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| no `yt-dlp` available (no configured path and none on `PATH`) | `503 {detail}` — identical to the current unavailable response |
| open-network config (`REQUIRE_LOGIN` off + non-loopback + no `IP_ALLOWLIST`) | `503 {detail}`; no subprocess spawned — mirrors the AI chat / AI v2 refusal |
| configured, malformed body or non-allowlisted / unparseable `url` | `400 {detail}`; no subprocess spawned |
| configured, another import for the same session in flight, OR the global concurrency ceiling is reached | `409 {detail}`; no subprocess spawned |
| configured, success | `200 {ok: true}` — one downloaded audio segment attached to the session; if `use_publish_date` is true and the video reports an upload date, the session's `episode_date` is set from it (best-effort: a failed episode-date or catalog-mirror write after the segment is attached is logged and still returns this success) |
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
