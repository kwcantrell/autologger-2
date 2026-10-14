# Spec Delta

## ADDED Requirements

### Requirement: Wiki suggestion object
Every wiki suggestion endpoint that returns a suggestion SHALL return exactly this object, and the read endpoint SHALL add `"body_md": string`:

```
{ "id": string, "show_id": string, "session_id": string,
  "status": "pending" | "accepted" | "dismissed" | "superseded",
  "page_id": string | null, "base_revision": number | null,
  "kind": "person" | "topic" | "bit" | "session",
  "title": string, "aliases": [string], "rationale": string,
  "page": { "title": string, "revision": number,
            "state": "live" | "merged" | "deleted" } | null,
  "stale": boolean,
  "created_at_utc": string, "created_by_name": string,
  "resolved_at_utc": string | null, "resolved_by_name": string | null,
  "resolved_revision": number | null }
```

- **`page_id` null** means the suggestion proposes a new page of `kind` and `title`; `base_revision` and `page` are then null and `stale` is false.
- **`page`** describes the target page now: its current title, revision and state.
- **`stale`** is true when the target page's current revision differs from `base_revision`.
- **`*_by_name`** follows the wiki page object's rule: given and family name, recorded at the time of the write, never an email.

Every wiki suggestion endpoint SHALL follow the wiki endpoints' rules for `401`, `422` and cookies. A suggestion that doesn't exist or that the caller can't access under show access SHALL answer `404 {"detail":"Suggestion not found."}`.

#### Scenario: Unauthenticated suggestion request
- **WHEN** an anonymous client requests `GET /api/wiki/suggestions/<id>`
- **THEN** the response is `401 {"detail":"Login required."}`

### Requirement: Wiki update endpoint
**`POST /api/sessions/:sessionId/wiki/generate`** takes no body and SHALL run the wiki-generation turn for the session (wiki-generation capability). The checks run in this order:

| Status | When | Body |
| --- | --- | --- |
| `401` | not logged in | `{"detail":"Login required."}` |
| `404` | the session doesn't exist, has no show, or the caller can't access it | the session routes' masked 404 |
| `503` | the caller has no AI route | `{"detail":"Add a language model in Settings → Advanced to update the wiki."}` |
| `403` | the caller isn't an approved user | the existing run-feature 403 |
| `400` | the session has no transcript words | `{"detail":"This session has no transcript words to update the wiki from."}` |
| `409` | another AI turn holds the session's slot | `{"detail":"A turn (AI chat, AI v2, topic generation, event generation, or wiki update) is already in progress for this session; wait for it to finish before updating the wiki again. These features share one per-session AI slot by design."}` |
| `502` | the run failed | `{"detail":"Wiki update failed."}` |
| `200` | the run succeeded | `{"suggestions": [<suggestion object>]}` |

- The `200` list holds the suggestions this run stored, in the order they were proposed. It MAY be empty.
- No cookies are set.

#### Scenario: Update wiki returns the stored suggestions
- **WHEN** a caller with an AI route and show access posts to `wiki/generate` for a session with a transcript, and the model proposes one new person page
- **THEN** the response is `200` with one suggestion whose `status` is `pending`, `page_id` is null and `kind` is `person`

#### Scenario: A session without transcript words
- **WHEN** the session has no transcript words
- **THEN** the response is `400 {"detail":"This session has no transcript words to update the wiki from."}` and no model request is made

### Requirement: Wiki suggestion list, read, accept and dismiss endpoints
**`GET /api/shows/:showId/wiki/suggestions`** SHALL list the show's suggestions. Query parameters:

| Parameter | Rule |
| --- | --- |
| `status` | optional; one of the four statuses; default `pending` |
| `page_id` | optional; keeps the suggestions for that page |

Unknown parameters SHALL be ignored. The `200` body SHALL be `{"suggestions": [<suggestion object>], "truncated": boolean}`, newest first, at most 500. A show the caller can't access answers `404 {"detail":"Show not found."}`.

**`GET /api/wiki/suggestions/:suggestionId`** SHALL answer `200` with the suggestion object plus `body_md`.

**`POST /api/wiki/suggestions/:suggestionId/accept`** takes `{ "expected_revision"?: number, "title"?, "body_md"?, "aliases"? }`:
- `expected_revision` is required when the suggestion targets an existing page and is the revision the reviewer saw. It is ignored for a new page.
- `title`, `body_md` and `aliases` are optional overrides ("edit, then accept"), with the wiki page limits. Fields not sent take the suggestion's value. The kind can't be changed on accept.

| Status | When | Body |
| --- | --- | --- |
| `200` | an existing page was updated | `{"page": <page object>, "suggestion": <suggestion object>}` |
| `201` | a new page was created | `{"page": <page object>, "suggestion": <suggestion object>}` |
| `409` | `expected_revision` isn't current | `{"detail":"Version conflict.","current":<page object>}` |
| `409` | the target page was merged | `{"detail":"Page was merged.","merged_into":string}` |
| `409` | the target page is deleted | `{"detail":"Page is deleted."}` |
| `409` | a title or alias clash | `{"detail":"Title already used.","page_id":string}` |
| `409` | a new session page when the session already has one | `{"detail":"Session already has a page.","page_id":string}` |
| `409` | the suggestion isn't pending | `{"detail":"Suggestion already resolved.","status":string}` |
| `422` | `expected_revision` missing for an existing page | `{"detail":"expected_revision is required."}` |
| `422` | schema or rule failure | as for every wiki endpoint |

**`POST /api/wiki/suggestions/:suggestionId/dismiss`** takes no body:

| Status | When | Body |
| --- | --- | --- |
| `200` | dismissed | the suggestion object |
| `409` | the suggestion isn't pending | `{"detail":"Suggestion already resolved.","status":string}` |

#### Scenario: Accept a stale suggestion against the current revision
- **WHEN** a suggestion has `base_revision` 3, the page is now at revision 4, and the reviewer accepts with `expected_revision` 4
- **THEN** the response is `200`, `page.revision` is 5, and `suggestion.status` is `accepted` with `resolved_revision` 5

#### Scenario: Accept twice
- **WHEN** a reviewer accepts a suggestion that another reviewer already accepted
- **THEN** the response is `409 {"detail":"Suggestion already resolved.","status":"accepted"}` and the page is unchanged
