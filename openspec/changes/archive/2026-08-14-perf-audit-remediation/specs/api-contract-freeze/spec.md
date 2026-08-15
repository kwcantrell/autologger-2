# api-contract-freeze — delta

## ADDED Requirements

### Requirement: `/api/*` responses are content-encoding negotiated

The server SHALL apply response compression to the `/api/*` surface, and only to that
surface. The set of responses subject to negotiation SHALL be defined by a single shared
predicate — hono's `COMPRESSIBLE_CONTENT_TYPE_REGEX` plus `application/x-ndjson` (which
that regex omits, and which `export.jsonl` emits) — exported from one module
(`server/src/compressibleTypes.ts`, `isCompressibleResponseType`) and consumed by the
compression middleware, by the body-measuring middleware, and by the audio router's mime
clamp, so those three can never disagree about which responses are in scope.

A compressible `/api/*` response over the middleware's 1024-byte threshold SHALL be sent
with `Content-Encoding: gzip` when the request's `Accept-Encoding` permits it, and with no
`Content-Encoding` otherwise. Because `c.json()`/`c.text()` set no `Content-Length` and the
threshold is measurable only when one is present, an inner middleware SHALL buffer
non-streaming compressible bodies that carry no length and stamp an accurate
`Content-Length` before the compression decision is made — without it the threshold is
inert and every small acknowledgement is gzipped to a larger body. That middleware SHALL
NOT consume a streaming response: it SHALL return before touching the body whenever the
response carries `Transfer-Encoding`, carries a non-compressible `Content-Type`, already
carries `Content-Encoding` or `Content-Length`, is bodyless, or answers a `HEAD` request.

Every negotiation-eligible `/api/*` response SHALL carry `Vary: Accept-Encoding`, including
the responses that ship identity — a shared cache that keyed a gzipped representation on the
URL alone would otherwise serve those bytes to a client that never sent `Accept-Encoding`,
and the reverse (an identity entry served to a gzip-capable client with no revalidation) is
equally wrong. The header SHALL be appended to any `Vary` a route already set, never
clobber it, and SHALL be treated as already satisfied when the existing value contains `*`
or an `Accept-Encoding` token in any case. It SHALL be stamped inside the compression
middleware so that it survives that middleware's response rebuild and appears on the
gzipped response.

Four surfaces SHALL be excluded **structurally** — by a property of the response itself, not
by an enumerated exception list that a future route could fall out of:

- **Audio byte serving** — the served `Content-Type` is clamped to a type the shared
  predicate never matches (see "Audio content types are clamped to non-compressible"), so
  the filter cannot select it and the hand-set `Content-Length`/`Content-Range` survive
  untouched. Being outside negotiation entirely, these responses also receive no `Vary`.
- **SSE** — `streamSSE` sets both `Transfer-Encoding: chunked` and
  `text/event-stream`; each independently causes a skip, and the `Transfer-Encoding` guard
  precedes the `Vary` step, so an SSE stream is neither buffered nor `Vary`-stamped.
- **WebSocket upgrades** — no compressible response body exists, and the compression
  middleware never touches `c.env`, so the `@hono/node-ws` env-identity handshake is
  unaffected.
- **The Next frontend bridge and `/auth/*`** — both are outside the `/api/*` mount scope;
  Next compresses its own responses.

#### Scenario: Large compressible body is gzipped and marked Vary

- **WHEN** a client sends `Accept-Encoding: gzip` to an `/api/*` route whose JSON response
  exceeds the size threshold
- **THEN** the response carries `Content-Encoding: gzip`, its decoded bytes equal the
  un-encoded body, and its `Vary` includes `Accept-Encoding`

#### Scenario: Identity response on the same route still carries Vary

- **WHEN** the same `/api/*` route is requested without an `Accept-Encoding` that permits
  gzip
- **THEN** the response carries no `Content-Encoding` and its `Vary` still includes
  `Accept-Encoding`

#### Scenario: Sub-threshold JSON ships identity with an accurate length

- **WHEN** an `/api/*` route returns a compressible JSON body smaller than 1024 bytes, with
  `Accept-Encoding: gzip` offered
- **THEN** the response carries no `Content-Encoding`, and its `Content-Length` equals the
  actual byte length of the body

#### Scenario: Audio range response is never encoded

- **WHEN** a client sends `Accept-Encoding: gzip` with a satisfiable `Range` to the audio
  download route
- **THEN** the `206` response carries no `Content-Encoding`, and its `Content-Range` and
  `Content-Length` are exactly the values the route set

#### Scenario: SSE stream is neither buffered nor Vary-stamped

- **WHEN** a client opens an `/api/*` SSE stream
- **THEN** the response carries no `Content-Encoding` and no `Vary: Accept-Encoding`, and
  its events are delivered incrementally rather than as one buffered blob

#### Scenario: Frozen export bodies are transported encoded, not altered

- **WHEN** a client sends `Accept-Encoding: gzip` to `…/export.csv` or `…/export.jsonl`
- **THEN** the response carries `Content-Encoding: gzip` and `Vary: Accept-Encoding`, and the
  decoded bytes are byte-for-byte the export body the frozen contract already specified —
  the freeze on non-JSON export bodies constrains the representation, and content-coding is
  transport applied above it, transparent to any conforming HTTP client

### Requirement: Show detail is addressable by id

The server SHALL expose `GET /api/shows/:showId`, returning `200 { show }` where `show` is
the **full** show serializer output (the same shape `GET /api/shows` and `POST /api/shows`
emit: `id`, `studio_id`, `name`, `show_code`, `title_suffix`, `categories`,
`event_palette`, `event_palette_preset`, `event_palette_custom`). Authorization SHALL
mirror `GET /api/shows`: an anonymous requester is served only while OAuth is unconfigured,
and a logged-in requester MUST be a member of the show's studio.

An unknown show id and a requester who is not a member of the show's studio SHALL both
produce an **identical** `404 { detail }` — same status, same body — so the route cannot be
used as an existence oracle for another tenant's show ids. This mirrors the pinned-404
posture the sibling routes already take for cross-tenant reads.

#### Scenario: Member reads a show by id

- **WHEN** a requester who is a member of the show's studio requests
  `GET /api/shows/:showId` for an existing show
- **THEN** the response is `200 { show }` carrying the full show shape, including
  `categories` and the three palette fields

#### Scenario: Unknown show id is a 404

- **WHEN** a requester requests `GET /api/shows/:showId` for an id no show has
- **THEN** the response is `404 { detail }`

#### Scenario: Non-member gets the same 404 as an unknown id

- **WHEN** a logged-in requester who is not a member of the show's studio requests
  `GET /api/shows/:showId` for a show that does exist
- **THEN** the response is `404` with a body byte-identical to the unknown-id response, and
  nothing in the status or body distinguishes the two cases

### Requirement: Audio content types are clamped to non-compressible

An audio segment's `Content-Type` SHALL be normalized by a single idempotent rule: any
value that the shared `/api/*` compressible-type predicate matches — and any absent or
blank value — degrades to `audio/webm`; **every other value round-trips verbatim**, with
parameters and case preserved (`audio/webm;codecs=opus` stays exactly that).

The rule SHALL be applied on store by `POST /api/sessions/:sessionId/audio/segments`, and
on serve by `GET /api/sessions/:sessionId/audio/segments/:segmentId` on **both** the full-body
`200` branch and the `206` range branch. Applying it again on serve is deliberate defense in
depth: it covers rows written by the other segment writers (local audio import, YouTube
import) and by older builds, and it is a no-op for every mime those paths actually produce.

This exists to guarantee one invariant: **a stored `Content-Type` can never cause an audio
range response to be compressed.** hono's `compress()` has no `206`/`Content-Range` guard —
an encoded range response loses its hand-set `Content-Length` while `Content-Range` still
describes identity bytes, corrupting playback for any range-assembling client.

The rule SHALL be defined by that compressibility hazard and SHALL NOT be an audio-type
allowlist. An allowlist goes stale silently and mangles real media: the batch importer
uploads a single `.mp4`/`.webm` file with the browser-reported `video/mp4` / `video/webm`,
and `.ogg` can arrive as `application/ogg` — none of which are compressible, none of which
must be rewritten (Safari refuses to play a `video/mp4` clip served as `audio/webm`). A bare
`audio/` prefix test is likewise insufficient, because the compressible regex ends in a
structured-suffix alternative that matches types such as `audio/x+json`; the predicate
therefore tests the full type string.

Normalization SHALL NOT be a rejection: a mislabelled upload keeps succeeding, and only its
*stored* mime moves. No script-injection protection is lost by passing non-compressible
types through — every type a browser executes markup from (`text/html`,
`application/xhtml+xml`, `image/svg+xml`, `text/xml`) is inside the compressible set and is
therefore still clamped.

#### Scenario: A video/mp4 batch import serves verbatim over a range

- **WHEN** a single-file batch import stores a segment whose declared content type is
  `video/mp4`, and a client then issues a `Range` request for it with
  `Accept-Encoding: gzip`
- **THEN** the `206` response's `Content-Type` is `video/mp4`, it carries no
  `Content-Encoding`, and its `Content-Range` and `Content-Length` are intact

#### Scenario: A compressible upload type is clamped on store and on serve

- **WHEN** a segment is uploaded to `POST /api/sessions/:sessionId/audio/segments` with
  `Content-Type: text/plain`
- **THEN** the stored segment's `mime_type` is `audio/webm`, the segment is served with
  `Content-Type: audio/webm`, and its range responses ship identity

#### Scenario: A parameterized audio type round-trips byte-identically

- **WHEN** a segment is uploaded with `Content-Type: audio/webm;codecs=opus`
- **THEN** the stored and served content type is exactly `audio/webm;codecs=opus`,
  parameters and case unchanged

### Requirement: sync-from-disk returns counts, not the segment list

`POST /api/sessions/:sessionId/audio/segments/sync-from-disk` SHALL respond
`200 {inserted, updated, scanned, has_audio}` and SHALL NOT include a `segments` array.
`inserted` is the number of metadata rows created for blobs found on disk, `scanned` is the
number of blobs examined, and `has_audio` reports whether the session has any segment after
the sync. `updated` SHALL be present and SHALL be `0`: the sync only ever inserts rows for
blobs that lack metadata, so no code path can produce a non-zero value. The key is retained
for wire-shape stability, not because it varies — a future reader SHALL NOT infer from its
presence that an update path exists.

The removed array is recorded as deliberate: the sole consumer discarded it, and it carried
roughly 349 KB of `waveform_peaks` per call. A client that needs the segment list SHALL read
`GET /api/sessions/:sessionId/audio/segments`, which is unchanged.

#### Scenario: A sync that inserts rows returns counts only

- **WHEN** a client posts to `…/audio/segments/sync-from-disk` for a session whose blob
  store holds segments with no metadata rows
- **THEN** the response body has exactly the keys `inserted`, `updated`, `scanned`, and
  `has_audio`, with no `segments` key, and the caller obtains the segment list from
  `GET …/audio/segments`

## MODIFIED Requirements

### Requirement: Show title_suffix on show wire; next_episode omitted

Show objects are emitted through **two** serializers, and both SHALL include `title_suffix`
as either `"date"` or `"episode"` and SHALL NOT include `next_episode`:

- The **brief** serializer, used for profile `shows[]`, emits exactly
  `{id, studio_id, name, show_code, title_suffix}`.
- The **full** serializer, used by `GET /api/shows`, `GET /api/shows/:showId`, and
  `POST /api/shows` create responses, emits those five fields plus `categories`,
  `event_palette`, `event_palette_preset`, and `event_palette_custom`.

The two shapes differ deliberately: profile is fetched on every page load and fans out over
every show in every studio the caller can reach, so the per-show configuration it does not
need is served on demand by the `/api/shows` routes instead.

Profile `show_updates[]` entries SHALL accept `title_suffix` with the same two values.
Legacy `next_episode` keys on profile/show update bodies SHALL be ignored (not persisted)
and SHALL NOT cause `400` solely due to that key. Catalog persistence SHALL store
`title_suffix` on `shows`. The SQLite column `shows.next_episode` MAY remain for rollback
safety but SHALL NOT be bumped on session create and SHALL NOT appear on the show wire.

#### Scenario: Profile show carries title_suffix

- **WHEN** a client reads profile after migration
- **THEN** each `shows[]` entry includes `title_suffix` of `"date"` or
  `"episode"` and omits `next_episode`

#### Scenario: Profile shows[] carries the brief shape

- **WHEN** a client reads `GET /api/profile`
- **THEN** each `shows[]` entry carries exactly `id`, `studio_id`, `name`, `show_code`, and
  `title_suffix` — no `categories`, no palette fields, and no `next_episode`

#### Scenario: The /api/shows routes carry the full shape

- **WHEN** a client reads `GET /api/shows?studio_id=…` or `GET /api/shows/:showId`
- **THEN** each show object includes `title_suffix`, `categories`, `event_palette`,
  `event_palette_preset`, and `event_palette_custom`, and omits `next_episode`

#### Scenario: Profile update persists title_suffix

- **WHEN** a client PUTs profile with `show_updates[].title_suffix` set to
  `"episode"`
- **THEN** a subsequent profile read returns that show with
  `title_suffix: "episode"`

#### Scenario: Legacy next_episode on update is ignored

- **WHEN** a client PUTs profile with `show_updates[].next_episode` set
- **THEN** the update succeeds without failing solely due to that key and no
  next-episode counter is written as a live product field

### Requirement: Transcript generation endpoint behavior
`POST /api/sessions/:sessionId/transcript-words/generate` SHALL move from unconditional
`503` to configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| `DEEPGRAM_API_KEY` unset/blank | `503 {detail}` — identical to the current unavailable response |
| configured, success | `200 {words: [...]}` — each word in the same trimmed wire shape `GET …/transcript-words` returns, namely exactly the seven keys `{id, session_time, speaker, word, start_sec, end_sec, ordinal}`; `start_sec`/`end_sec` carry remapped session-timeline seconds (`0` for anchorless words) rounded to 3 decimals; the array is the complete post-replace list in ordinal order |
| configured, session has no audio segments | `400 {detail}` |
| configured, segments exist but none is readable | `400 {detail}` (distinct detail) |
| configured, provider succeeds but returns zero words | `400 {detail}` (no-speech detail); existing words preserved |
| configured, another generation run in flight | `409 {detail}`; the detail names the busy session (title preferred, else id) when the requester may view it (anonymous, or a member of the holder's studio), and falls back to the identifier-free generic in-flight detail for logged-in non-members or when the holder released in the race; no provider request issued |
| configured, request aborted before any provider call | `400 {detail}` — a distinct aborted detail, not `200`/`503`; no provider request issued |
| configured, upstream STT failure/timeout, or a group file over the provider size limit | `502 {detail}` |

`session_id` and `created_at_utc` SHALL NOT appear on any transcript-word wire object: the
former was redundant with the path parameter the caller already holds, the latter is
server-internal bookkeeping. The store and the per-session database keep both, so
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
- **WHEN** a deployment without `DEEPGRAM_API_KEY` receives `POST
  /api/sessions/:id/transcript-words/generate`
- **THEN** the response status and body match the pre-change `503 {detail}` exactly

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
- **WHEN** a generate request arrives while another run is already in flight and the
  requester is anonymous or a member of the holder's studio
- **THEN** the response is `409 {detail}` that identifies the busy session, and no
  provider spend occurs for it

#### Scenario: Concurrent run 409 is identifier-free for non-members
- **WHEN** a generate request from a logged-in requester without membership of the
  holder's studio arrives while another run is in flight
- **THEN** the response is `409` with the generic in-flight `{detail}` naming no session,
  and no provider spend occurs for it

#### Scenario: Pre-provider-call abort maps to 400, not a new status code
- **WHEN** the originating HTTP request is already aborted before any DeepGram request
  would be issued
- **THEN** the response is `400 {detail}` with a detail distinct from the no-audio and
  all-unreadable `400` details, and no provider spend occurs

#### Scenario: Sibling stubs stay frozen
- **WHEN** a configured deployment receives `GET /api/sessions/:id/transcribe.csv`
- **THEN** it still responds with the current `503 {detail}`

### Requirement: Suffix range against a zero-byte audio blob

On the audio download endpoint (`GET /api/sessions/:sessionId/audio/segments/:segmentId`,
the repo's only Range-consuming route), a syntactically valid suffix `Range` request
(`bytes=-N`, `N > 0`) against a zero-byte audio blob SHALL yield the same
unsatisfiable-range response the endpoint already produces for other unsatisfiable
ranges (`416`), rather than an internal error. (Implementation note for the auditor:
`InvalidRangeError → 416` is mapped at two sites — the router's local catch and the app
error handler — which must stay consistent.) This
authorizes converting the current crash-driven `500` on this path to `416`; all other
range-request behavior (including `Content-Range` semantics on satisfiable ranges) is
unchanged, except that the served `Content-Type` is the normalized value defined by
"Audio content types are clamped to non-compressible".

#### Scenario: Suffix range on empty blob returns 416

- **WHEN** a client requests `Range: bytes=-N` for an audio object whose stored blob is
  zero bytes long
- **THEN** the response is the endpoint's existing unsatisfiable-range response (`416`),
  not a `500`

#### Scenario: Satisfiable ranges are unchanged

- **WHEN** a client requests any range against a non-empty blob that the published
  contract satisfies today
- **THEN** the status, `Content-Range`, `Content-Length`, and body bytes are unchanged, and
  the `Content-Type` is the segment's stored type as normalized by the audio content-type
  clamp
