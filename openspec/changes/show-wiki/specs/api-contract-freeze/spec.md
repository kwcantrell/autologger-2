# Spec Delta

## ADDED Requirements

### Requirement: Wiki page object
Every wiki endpoint that returns a page SHALL return exactly this object:

```
{ "id": string, "show_id": string,
  "kind": "person" | "topic" | "bit" | "session",
  "title": string, "body_md": string, "aliases": [string],
  "session_id": string | null, "revision": number,
  "merged_into": string | null, "deleted": boolean,
  "created_at_utc": string, "created_by_name": string,
  "updated_at_utc": string, "updated_by_name": string }
```

- **`aliases`** is in the order saved. For a merged or deleted page, it is the aliases of the page's newest revision.
- **`*_by_name`** is the writer's given and family name, joined by a space, as recorded at the time of that write. It is `""` when neither was set, and never an email address.
- **Times** are ISO-8601 UTC strings.

Every wiki endpoint SHALL follow these rules:
- **`401`** `{"detail":"Login required."}` when not logged in.
- **`404`** when a show or page doesn't exist or the caller can't access it under show access. The body is the same in both cases: `{"detail":"Show not found."}` for show-scoped routes, `{"detail":"Page not found."}` for page-scoped routes.
- **`422 {"detail":[…zod issues]}`** when a body or query fails its schema.
- **`422 {"detail":"<message>"}`** for a rule the schema can't check:
  - a bad `cite:` or `wiki:` link (the message names the link);
  - a session outside the show;
  - a `kind` change to or from `session`;
  - a merge into itself or involving a `session` page;
  - a merge whose result would exceed the body or alias limits;
  - a `session` kind in a split.
- **No cookies** are set.

#### Scenario: Unauthenticated wiki request
- **WHEN** an anonymous client requests `GET /api/wiki/pages/<id>`
- **THEN** the response is `401 {"detail":"Login required."}`

### Requirement: Wiki page list and create endpoints
**`GET /api/shows/:showId/wiki/pages`** SHALL list the show's pages. Query parameters:

| Parameter | Rule |
| --- | --- |
| `kind` | optional; one of the four kinds |
| `session_id` | optional; keeps the session page of that session |
| `deleted` | optional `1`; lists deleted pages instead of live ones |

Unknown parameters SHALL be ignored. Merged pages SHALL NOT be listed.

The `200` body SHALL be exactly:

```
{ "pages": [{ "id": string, "kind": string, "title": string, "aliases": [string],
              "session_id": string | null, "revision": number,
              "updated_at_utc": string, "updated_by_name": string }],
  "truncated": boolean }
```

- Pages are sorted by title, ignoring case and accents.
- At most 2000 pages are returned, and `truncated` says whether more matched.

**`POST /api/shows/:showId/wiki/pages`** takes `{ "kind", "title", "body_md"?, "aliases"?, "session_id"? }`. `session_id` is required exactly when `kind` is `session`.

| Status | When | Body |
| --- | --- | --- |
| `201` | created | the page object |
| `409` | a live page holds the title or an alias | `{"detail":"Title already used.","page_id":string}` |
| `409` | the session already has a page | `{"detail":"Session already has a page.","page_id":string}` |
| `422` | schema or rule failure | as for every wiki endpoint |

#### Scenario: Create then list
- **WHEN** a user with show access posts `{"kind":"person","title":"Christina Ramos"}` and then lists `?kind=person`
- **THEN** the post answers `201` with `revision` 1, and the list contains that page with `truncated` false

### Requirement: Wiki page read, edit, delete and restore endpoints
**`GET /api/wiki/pages/:pageId`** SHALL answer `200` with the page object, including merged and deleted pages.

**`PUT /api/wiki/pages/:pageId`** takes `{ "expected_revision": number, "title"?, "kind"?, "body_md"?, "aliases"?, "restored_from"? }`.
- Fields not sent stay unchanged, and `aliases` replaces the whole list.
- `restored_from` is a revision number below the current one. It only labels the new revision as a restore of that revision.
- A `PUT` that changes nothing answers `200` with the unchanged page.

**`DELETE /api/wiki/pages/:pageId?expected_revision=<n>`** soft-deletes the page.

**`POST /api/wiki/pages/:pageId/restore`** takes `{ "expected_revision": number }` and makes a deleted page live again.

| Status | When | Body |
| --- | --- | --- |
| `200` | done | the page object after the change |
| `409` | `expected_revision` isn't current | `{"detail":"Version conflict.","current":<page object>}` |
| `409` | the page was merged | `{"detail":"Page was merged.","merged_into":string}` |
| `409` | edit or delete of a deleted page | `{"detail":"Page is deleted."}` |
| `409` | restore of a live page | `{"detail":"Page is not deleted."}` |
| `409` | a title or alias clash | `{"detail":"Title already used.","page_id":string}` |
| `409` | restore when the session already has another page | `{"detail":"Session already has a page.","page_id":string}` |

#### Scenario: Stale edit
- **WHEN** a client sends `PUT` with `expected_revision` 3 to a page at revision 4
- **THEN** the response is `409` with `detail` `Version conflict.` and `current.revision` 4

### Requirement: Wiki revision endpoints
**`GET /api/wiki/pages/:pageId/revisions`** SHALL answer `200` with the page's revisions, newest first. Query parameters:

| Parameter | Rule |
| --- | --- |
| `limit` | optional integer 1–100; default 50 |
| `before` | optional revision number; returns only revisions below it |

The `200` body is:

```
{ "revisions": [{ "revision": number, "title": string, "kind": string,
                  "author_name": string, "at_utc": string, "note": string }],
  "next_before": number | null }
```

`next_before` is the cursor for the next older page, or `null` when there are no more.

**`GET /api/wiki/pages/:pageId/revisions/:rev`** SHALL answer `200` with one revision. It has the same fields plus `"body_md": string` and `"aliases": [string]`. A revision number that doesn't exist answers `404 {"detail":"Revision not found."}`.

#### Scenario: Read an old revision
- **WHEN** a user requests revision 1 of a page now at revision 3
- **THEN** the response is `200` with revision 1's title and body and the note `created`

#### Scenario: Revisions page backwards
- **WHEN** a page has 120 revisions and a client requests `?limit=50`, then `?limit=50&before=<next_before>`
- **THEN** the first answer holds revisions 120–71 with `next_before` 71, and the second holds 70–21

### Requirement: Wiki merge and split endpoints
**`POST /api/wiki/pages/:pageId/merge`** SHALL merge the page into another page. It takes `{ "into_page_id": string, "expected_revision": number, "into_expected_revision": number }`.

| Status | When | Body |
| --- | --- | --- |
| `200` | merged | `{ "page": <the target page> }` |
| `409` | either page is stale | `Version conflict.`, with `current` set to the stale page |
| `404` | `into_page_id` is missing, in another show, or not accessible | `Page not found.` |
| `422` | the two pages are the same page, either is a `session` page, or the result would exceed the limits | as for every wiki endpoint |
| `409` | the target was merged or deleted | as for `PUT` |

**`POST /api/wiki/pages/:pageId/split`** takes `{ "expected_revision": number, "remaining_body_md": string, "new_page": { "kind", "title", "body_md", "aliases"? } }`.

| Status | When | Body |
| --- | --- | --- |
| `201` | split | `{ "page": <the source page>, "new_page": <the new page> }` |
| `422` | `new_page.kind` is `session` | as for every wiki endpoint |
| `409` | a conflict | as for `PUT` |

#### Scenario: Merge answers the target
- **WHEN** a client merges page A (revision 2) into page B (revision 5) with matching expected revisions
- **THEN** the response is `200` with `page.id` B, `page.revision` 6, and A's title among `page.aliases`

### Requirement: Wiki page HTML routes
`GET /wiki` and `GET /wiki/<id>` SHALL respond `200` with the index shell HTML: the same page served at `/`, `/sessions/:id`, `/teams` and `/search`.
- They SHALL respond whether or not the request is authenticated; the login gate renders client-side.
- They SHALL set no cookies.
- They SHALL give query parameters no meaning on the server.
- `/wiki/`, `/wiki/<id>/` and any deeper path (`/wiki/<id>/<more>`) SHALL remain outside the inventory, and SHALL keep responding `404` when no static asset matches.

#### Scenario: Wiki deep link serves the shell
- **WHEN** `GET /wiki/abc` is requested by an anonymous client
- **THEN** the server responds `200` with the index shell HTML and no `Set-Cookie`

#### Scenario: Nested wiki path is not a route
- **WHEN** `GET /wiki/abc/history` is requested
- **THEN** the server responds `404`
