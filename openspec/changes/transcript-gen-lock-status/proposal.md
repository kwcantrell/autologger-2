# transcript-gen-lock-status — proposal

## Why

Transcript generation is process-wide single-flight. When a DeepGram run is active
(often multi-minute), visiting any session’s Transcript tab only surfaces the lock if the
operator clicks Auto Generate and receives a generic `409` — no session identity, no
elapsed time. Operators cannot tell whether generate is still working, which session owns
the slot, or how long it has been running.

## What Changes

- **Lock metadata**: the process-wide generate slot records `{ sessionId, startedAtMs }`
  for the run that holds it (cleared in `finally` as today).
- **New status endpoint** `GET /api/transcript-generation/status` (same auth posture as
  sibling transcript routes):
  - Idle: `{ in_flight: false }`
  - Busy: `{ in_flight: true, session_id, session_title, started_at }` where `started_at`
    is ISO-8601 UTC and `session_title` is the catalog title at read time (`null` if the
    session row is gone).
- **Richer `409` detail** on `POST …/transcript-words/generate`: status stays `409`; the
  detail string MUST name the busy session (title preferred, else id) so the Generate
  button path stays actionable without the banner.
- **Transcript tab UI**: while `TranscribeFeed` is mounted, poll status (~2s while busy,
  ~10s while idle). When busy, show a persistent non-danger status line with title +
  live elapsed time (client tick from `started_at`). If the busy session differs from the
  current session, include a link to `/sessions/<id>`. While the current session owns the
  lock, treat Auto Generate as pending/disabled-equivalent.
- **README** endpoint inventory row for the new GET; `api-contract-freeze` +
  `transcript-generation` delta specs authorize the new surface and the enriched `409`
  wording.

## Capabilities

### New Capabilities
- (none — extends existing transcript-generation / api-contract-freeze)

### Modified Capabilities
- `transcript-generation`: observable lock status + enriched concurrent-run `409` detail
- `api-contract-freeze`: new GET route + `409` detail MUST name the busy session

## Non-Goals

- Cancel/abort of an in-flight DeepGram run
- Per-session concurrent generates (still one process-wide slot)
- WebSocket push for lock status (polling is enough)
- Changing DeepGram provider timeouts or retry policy
- Log-import-specific UI (log import already prints progress lines; it shares the same
  lock once that path exists on a branch that extracts `generateTranscriptWords`)

## Contract impact

- **New** `GET /api/transcript-generation/status` JSON shapes as above (frozen on ship).
- **`409` detail string** on concurrent generate becomes more specific (still `{detail}`
  envelope; status code unchanged).
- No change to success `200 {words}`, other generate failure codes, or
  `GET …/transcript-words` list shape.
