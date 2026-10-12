# Spec Delta

## ADDED Requirements

### Requirement: Search endpoint
`GET /api/search` SHALL search what the caller can see (catalog-search). Query parameters:

| Parameter | Rule |
| --- | --- |
| `q` | required; 2–200 characters after trimming whitespace |
| `studio_id` | optional; narrows every group to that studio |
| `show_id` | optional; narrows every group to that show |
| `session_id` | optional; returns only that session's moments, with no per-session cap, and empty `studios`, `shows` and `sessions` |
| `limit` | optional decimal integer 1–25, default 5; the maximum per group |

Unknown parameters SHALL be ignored.

Responses:

| Status | When | Body |
| --- | --- | --- |
| `200` | the search ran | the result object below |
| `401` | not logged in | `{"detail":"Login required."}` |
| `422` | `q` missing or out of range, or `limit` not an integer 1–25 | `{"detail":[…zod issues]}` |
| `503` | the search exceeded its time budget | `{"detail":"Search timed out; try a more specific query."}` |
| `503` | too many searches are already running | `{"detail":"Search is busy; try again."}` |

The `200` body SHALL be exactly:

```
{ "q": string,
  "studios":  [{ "id": string, "name": string }],
  "shows":    [{ "id": string, "name": string, "studio_id": string }],
  "sessions": [{ "id": string, "title": string, "episode": string, "show_id": string,
                 "studio_id": string, "started_at_utc": string, "archived": boolean,
                 "match": "title" | "notes", "snippet": string | null }],
  "moments":  [{ "session_id": string, "session_title": string, "show_id": string,
                 "kind": "transcript" | "topic" | "event", "id": string,
                 "sec": number | null, "speaker": string, "snippet": string }],
  "moment_sessions": [{ "session_id": string, "total": number }] }
```

- `q` echoes the trimmed query.
- `moments[].id` is:
  - the topic id or event id for `topic` and `event`;
  - `<bucket>` (decimal) for `transcript`.
- `speaker` is `""` when not applicable.
- `sec` is a number only for `transcript` moments with timing; it is `null` for `topic` and `event`.
- `moment_sessions` has one entry for each session that appears in `moments`: the session's total number of matching moments, at most 1000.
- A `studio_id`, `show_id` or `session_id` the caller can't see SHALL give `200` with every group empty, the same as an id that doesn't exist.
- The endpoint SHALL set no cookies and SHALL make no writes.

#### Scenario: Search answers grouped results
- **WHEN** a logged-in member requests `GET /api/search?q=budget`
- **THEN** the response is `200` with keys `q`, `studios`, `shows`, `sessions`, `moments` and `moment_sessions`; `studios`, `shows`, `sessions` and `moments` each hold at most 5 entries

#### Scenario: One session's moments
- **WHEN** a logged-in member requests `GET /api/search?q=divorce&session_id=<id>&limit=25` for a session they can access with 12 matching moments
- **THEN** the response is `200` with 12 `moments` from that session, `moment_sessions` `[{"session_id":"<id>","total":12}]`, and `studios`, `shows` and `sessions` empty

#### Scenario: Anonymous search is refused
- **WHEN** an anonymous client requests `GET /api/search?q=budget`
- **THEN** the response is `401` `{"detail":"Login required."}`

#### Scenario: Query bounds
- **WHEN** a logged-in member requests `q=a`, then `q` of 201 characters, then `limit=0`, then `limit=26`
- **THEN** each response is `422`

#### Scenario: Busy is a 503
- **WHEN** a search can't start within 1 second because 2 searches are already running in the process
- **THEN** the response is `503` `{"detail":"Search is busy; try again."}`

#### Scenario: Timeout is a 503
- **WHEN** the search's database work exceeds its time budget
- **THEN** the response is `503` `{"detail":"Search timed out; try a more specific query."}`

### Requirement: Search page HTML route
`GET /search` SHALL respond `200` with the index shell HTML: the same page identity served at `/`, `/sessions/:id` and `/teams`.
- It SHALL respond whether or not the request is authenticated; the login gate renders client-side.
- It SHALL set no cookies.
- It SHALL take no query-parameter semantics on the server.
- Paths below it (`/search/<more>`) and `/search/` SHALL remain outside the inventory and keep responding `404` when no static asset matches.

#### Scenario: Search deep link serves the shell
- **WHEN** `GET /search?q=budget` is requested by an anonymous client
- **THEN** the server responds `200` with the index shell HTML and no `Set-Cookie`

#### Scenario: Nested search path is not a route
- **WHEN** `GET /search/extra` is requested
- **THEN** the server responds `404`
