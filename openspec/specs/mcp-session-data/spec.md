# mcp-session-data Specification

## Purpose
Lets a connected Claude client read a session's data through AutoLogger's public MCP endpoint, under the signed-in user's own permissions, behind `CUSTOM_DASHBOARDS_ENABLED` (ADR 0035 decisions 2 and 11; design `docs/design/custom-session-dashboards.md` sections 3.3, 4.6 and 5.1 to 5.4; job J5). This capability covers `POST /mcp`, its bearer, its transport, the model-visible read tools, their paging contract and the associated wiki pages. The tokens themselves come from `mcp-authorization`. The dashboard tools and the View are added by later jobs (J7, J8).

## Requirements

### Requirement: The endpoint exists only with the flag on
`/mcp` SHALL answer as specified only while `CUSTOM_DASHBOARDS_ENABLED` is on, read per request.
With it off, every method on `/mcp` SHALL answer exactly what the same request answers with no
such route mounted (a `GET` or `HEAD` reaches the frontend bridge, any other method gets Hono's
`404`), the authentication middleware SHALL have no `/mcp` branch, and a Bearer there SHALL be
ignored as on any path outside `/api/companion/`.

#### Scenario: Flag off
- **WHEN** the flag is off and `GET`, `POST`, `DELETE` and `HEAD` are sent to `/mcp`, with and
  without a live MCP access token
- **THEN** each answer is byte for byte the answer of an unmounted path, with no
  `WWW-Authenticate` or `Allow` header

### Requirement: The /mcp bearer
On a `POST` to exactly `/mcp` (the percent-decoded path the router matches) with the flag on, the
authentication middleware SHALL decide the caller from the `Authorization: Bearer` header and SHALL
ignore any session cookie. It SHALL hash the token with SHA-256 and read, as a system read under
`auth-resolve`, the access token joined to its grant and user, and SHALL accept it only when:
- the token is unexpired;
- the grant is not revoked and not past its 90-day cap;
- the grant's resource is `PUBLIC_BASE_URL + "/mcp"` (the audience check);
- the user is not disabled.

On success the request SHALL run as that user, with the catalog bound to the user, and SHALL carry
the grant's id and client id. The grant's last-used time SHALL be updated at most once a minute,
after the lookup, and a failure of that update SHALL only log a warning.

Otherwise (no Bearer, an empty one, an unknown, expired, capped, revoked or wrong-audience token,
or a disabled user) the answer SHALL be `401` `{"detail": "Login required."}` with
`WWW-Authenticate: Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource/mcp", scope="dashboards"`,
and no handler SHALL run. A method other than `POST` on `/mcp` SHALL reach the route with no
caller. No token carries a role, studio or session: each tool checks access on every call.

#### Scenario: No or bad token
- **WHEN** `POST /mcp` is sent with no `Authorization`, with `Bearer` and no token, with an unknown
  token, or with a `Basic` credential
- **THEN** each answers `401` `{"detail": "Login required."}` with the exact challenge

#### Scenario: Wrong audience, expired and capped tokens
- **WHEN** `POST /mcp` is sent with a token whose grant was minted for another resource, with an
  expired token, and with a token whose grant is past its 90-day cap
- **THEN** each answers `401` with the challenge

#### Scenario: A revoked grant
- **WHEN** a grant is revoked (Connected apps or `POST /oauth/revoke`, which delete its tokens)
  and its access token is sent to `POST /mcp`
- **THEN** the answer is `401` with the challenge

#### Scenario: The cookie is ignored
- **WHEN** `POST /mcp` is sent with a valid session cookie and no Bearer
- **THEN** the answer is `401` with the challenge

### Requirement: Transport
`POST /mcp` SHALL use the MCP Streamable HTTP transport in stateless mode, protocol `2025-11-25` as
negotiated by the pinned SDK: no `Mcp-Session-Id` is issued or required, each request builds its
own server, answers are `application/json`, and any process serves any request. The server's name
SHALL be `autologger`, and it SHALL declare the `tools` capability.
- `GET`, `DELETE` and every other method other than `POST` SHALL answer `405` with `Allow: POST`.
- A request whose `Origin` header is present and is not exactly `https://claude.ai` or one of the
  serialized origins of `MCP_ALLOWED_ORIGINS` SHALL get `403` `{"detail": "Origin not allowed."}`.
  A request with no `Origin` is not refused for it.
- A body over 512 KiB (524,288 bytes), declared or streamed, SHALL get `413` before it is parsed.

#### Scenario: Methods
- **WHEN** `GET`, `DELETE`, `PUT`, `PATCH` and `HEAD` are sent to `/mcp` with the flag on, with and
  without a token
- **THEN** each answers `405` with `Allow: POST`

#### Scenario: Origins
- **WHEN** `MCP_ALLOWED_ORIGINS` is `https://desk.example.org` and requests carry no `Origin`,
  `https://claude.ai`, `https://desk.example.org`, `https://evil.example`, `http://claude.ai` and
  `null`
- **THEN** the first three are served and the others answer `403`

#### Scenario: Body cap
- **WHEN** a JSON-RPC body of exactly 512 KiB and one of 512 KiB plus one byte are posted
- **THEN** the first is served and the second answers `413`

#### Scenario: Stateless
- **WHEN** `initialize` is posted and later a `tools/call` is posted with no `Mcp-Session-Id`, or
  with a made-up one
- **THEN** no answer carries `Mcp-Session-Id`, and the call is served

### Requirement: The read tools
`/mcp` SHALL list exactly these tools, in this order, each with a strict input schema (unknown
keys refused), an output schema and the `readOnlyHint` annotation: `list_studios`, `list_shows`,
`list_sessions`, `get_session`, `list_events`, `list_transcript_paragraphs`,
`list_transcript_words`, `list_topics`, `get_session_aggregates`, `list_wiki_pages`,
`get_wiki_page`. None of them SHALL write session data, wiki pages or catalog rows (decision 11);
the only writes a call makes are the grant's last-used time and the rate window.

Each tool SHALL authorize from its own arguments on every call, as the token's user:
- a session tool through `requireSession` (hidden sessions included): an unknown session and one
  the user can't read both answer `Session not found`;
- `list_sessions` through `requireShowAccess`: `Show not found.`;
- `list_shows` through the user's membership of the studio: `Studio not found`.

A result SHALL carry `structuredContent` and a short text. A refusal SHALL be a tool result with
`isError: true` and one fixed text: `Session not found`, `Studio not found`, `Show not found.`,
`Wiki page not found`, `Invalid cursor.`, `Rate limit exceeded; retry in N s.`, or, for anything
unexpected, `Internal error.` (logged by name and code only). No refusal SHALL carry provider, SQL
or stack detail.

Items:
- `list_studios`: `{studio_id, name, role}`, every membership (at most 100), with `total`.
- `list_shows`: `{show_id, name, show_code, can_access}` (the `/api/profile` rule), by show id.
- `list_sessions`: `{session_id, title, date, archived, hidden}` (`date` is the episode date, else
  the start time; hidden sessions only with `include_hidden`), by session id.
- `get_session`: `{session_id, show_id, studio_id, title, date, fps, counts: {events, words,
  paragraphs, topics, wiki_pages}, revision}`.
- `list_events`: the event wire shape of `GET /api/sessions/:id/events`.
- `list_transcript_paragraphs`: `{ordinal, speaker, session_time, start_sec, end_sec, text}`;
  `session_time` is `null`, since paragraphs store none.
- `list_transcript_words`: `{ordinal, session_time, speaker, word, start_sec, end_sec}`.
- `list_topics`: the topics wire shape.
- `get_session_aggregates`: the `aggregates.ts` results, each `{available, reason?}`.
- `list_wiki_pages`: `{page_id, kind, title, aliases, revision, association, body_chars}`.
- `get_wiki_page`: `{page_id, kind, title, revision, body_md, offset, next_offset, body_chars}`,
  a slice of an associated page's body.

#### Scenario: A member with no grant
- **WHEN** a member of a session's studio who holds no grant on its show calls every session tool
  on it
- **THEN** each answers `Session not found`, as for a session that doesn't exist

#### Scenario: Role changes take effect on the next call
- **WHEN** an admin reads a session's events, is demoted to member with no grant, is granted the
  show, and is removed from the studio, calling `list_events` after each step
- **THEN** the calls answer: allowed, `Session not found`, allowed, `Session not found`

#### Scenario: Read-only
- **WHEN** every tool is called on a session
- **THEN** the session's revision and its event, word and wiki rows are unchanged

### Requirement: Paging contract
Every list tool (`list_shows`, `list_sessions`, `list_events`, `list_transcript_paragraphs`,
`list_transcript_words`, `list_topics`, `list_wiki_pages`) SHALL take `cursor?` and `limit?` and
answer `{items, next_cursor, total, truncated, note?}`:
- **Limits.** A missing `limit` SHALL be the tool's default, one above the maximum SHALL be the
  maximum, and one below 1 SHALL be 1; none is refused. Default and maximum: `list_shows` 50/200,
  `list_sessions` 50/200, `list_events` 200/500, `list_transcript_paragraphs` 100/300,
  `list_transcript_words` 1,000/3,000, `list_topics` 200/500, `list_wiki_pages` 20/50.
  `get_wiki_page`'s `max_chars` is 20,000 by default, at most 40,000.
- **Cursor.** base64url JSON `{v: 1, t: tool, s: scope id, k: position key, r: revision}`. It
  carries no authority. A cursor that doesn't parse, isn't version 1, is for another tool or
  another scope (session, show or studio), or whose key isn't the tool's shape SHALL get
  `Invalid cursor.`
- **Keyed reads.** The key SHALL be the last item's position in the order the store sorts by, and
  the next page SHALL be the items after it, never an offset.
- **Character cap.** A result's serialized structured content SHALL be at most 40,000 characters.
  When `limit` items would pass it, the page SHALL end early with `truncated: true` and a cursor
  after the last item it includes. One item over the cap on its own SHALL be skipped with
  `truncated: true`, a cursor after it, and the note
  `an item over the 40,000-character page cap was skipped`.
- **Next cursor.** `next_cursor` SHALL be `null` when the read returned fewer than `limit` items;
  a full read gets a cursor even when nothing follows, so a walk may end on an empty page.
- **Changes.** When the revision the cursor carries differs from the current one, the page SHALL
  still continue after the key, and `note` SHALL be `session changed since the first page`. The
  next cursor keeps the first page's revision, so the note follows the rest of the walk. For the
  session tools the revision is the session's; for `list_wiki_pages` it is a fingerprint of the
  associated set (each page's rule, id and revision); for `list_shows` and `list_sessions` it is
  `0`.
- **Totals.** `total` SHALL be the full count for the scope.

#### Scenario: Clamped limits
- **WHEN** `list_wiki_pages` is called on a session with 53 associated pages with `limit` 100,000,
  with no `limit`, with `0` and with `-5`
- **THEN** it returns 50, 20, 1 and 1 items, with `total` 53

#### Scenario: The character cap
- **WHEN** `list_events` is called with `limit` 10 on ten events of 8,000-character messages
- **THEN** the page holds fewer than ten, `truncated` is true, its serialized form is at most
  40,000 characters, and walking its cursors returns all ten once, in order

#### Scenario: A cursor for something else
- **WHEN** a `list_events` cursor is passed to `list_topics`, to `list_events` for another session,
  and garbage is passed as a cursor
- **THEN** each answers `Invalid cursor.`

#### Scenario: The changed-session note
- **WHEN** a walk of `list_events` reads its first page, an event is added, and the walk continues
- **THEN** the later pages carry `note: "session changed since the first page"` and continue after
  the key

### Requirement: Keyed session reads
The session hub SHALL offer keyed reads beside its whole reads, which stay as they are:
`listEventsAfter` in `(wall_time_utc, id)` order, and `listTranscriptWordsAfter`,
`listTranscriptParagraphsAfter` and `listTopicsAfter` in `(ordinal, id)` order. Each SHALL return
the rows strictly after the given key (or from the first row), at most `limit` of them, with the
session's count of that kind and its revision read in the same snapshot. Each page SHALL send one
row read bounded by `LIMIT limit` and count reads only, never a read of the whole transcript,
topic list or event log.

#### Scenario: A late-logged event
- **WHEN** a session has events logged in wall-clock order plus one logged later whose wall time
  is later but whose timecode is the earliest, and `list_events` is walked two at a time
- **THEN** every event is returned exactly once, in `(wall_time_utc, id)` order, matching the hub's
  whole read

#### Scenario: Bounded reads
- **WHEN** a keyed read is called with `limit` N
- **THEN** it sends one row statement ending `ORDER BY … LIMIT ?` bound to N, plus counts

### Requirement: Associated wiki pages
For session `S` of show `H`, a wiki page `P` SHALL be associated with `S` when `P` belongs to
`H`, is live and not merged, and at least one of these holds:
1. **Session page:** `P.kind = 'session'` and `P.session_id = S`.
2. **Cites the session:** `P`'s current body holds a citation to `S` as `citationsOf` reports it
   (inline, reference or autolink forms; not in code). The database pre-filters the show's live
   pages to bodies holding `cite:<S>@` case-insensitively; the parser confirms each.
3. **Linked from the session page:** `P` is the target of a valid `wiki:<page_id>` link in the
   current body of the rule 1 page. One hop only.

Each page SHALL be listed once, under its first rule, ordered by `(rule, page_id)`, and the
`list_wiki_pages` cursor key SHALL be `(rule, page_id)`, so a rename never moves a page across
the cursor. `get_wiki_page` SHALL answer only an associated page (any other, in any show, is
`Wiki page not found`), as a slice from `offset` (UTF-16 code units) of at most `max_chars`
characters, shortened so the result stays within 40,000 serialized characters and never splits a
surrogate pair; `next_offset` is `null` at the end. Every read runs under the user's binding, so
the wiki policies apply on top of `requireSession`.

#### Scenario: The three rules
- **WHEN** a show has the session's page, pages citing the session inline, by reference and in an
  angle-bracket link, a page cited and also linked, and a page linked from the session page that
  itself links further
- **THEN** `list_wiki_pages` lists the session page, then the citing pages by id, then the linked
  page, each once; the page two hops away is not listed

#### Scenario: Excluded pages
- **WHEN** pages cite the session only inside a code span, cite another session, are deleted, are
  merged, belong to another show (citing the session, or linked from the session page)
- **THEN** none is listed, and `get_wiki_page` answers `Wiki page not found` for them

#### Scenario: Rename during a walk
- **WHEN** a walk of `list_wiki_pages` two at a time reads its first page and then the pages around
  the cursor are renamed
- **THEN** the walk returns every page exactly once, and the later pages carry the changed note

### Requirement: The model tool window
Each user SHALL get at most 120 model-visible tool calls a minute and 2,000 an hour, counted in
fixed windows in `mcp_rate_windows` shared by every process (`mcp-model-minute:<user>` and
`mcp-model-hour:<user>`). Every `tools/call` of a tool of this capability SHALL count once; other
methods (`initialize`, `tools/list`) and calls refused by input validation SHALL NOT. A call past
either window SHALL answer the tool error `Rate limit exceeded; retry in N s.`, `N` being the
whole seconds left in that window (at least 1).

#### Scenario: Past 120 a minute
- **WHEN** a user's minute window already holds 119 calls and they make two more
- **THEN** the first is served and the second answers `Rate limit exceeded; retry in N s.`; another
  user's call is still served

#### Scenario: Past 2,000 an hour
- **WHEN** a user's hour window already holds 1,999 calls and they make two more
- **THEN** the first is served and the second is refused with the rate text
