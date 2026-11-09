# Spec Delta

## ADDED Requirements

### Requirement: YouTube playlist listing endpoint

`POST /api/youtube/playlist-entries` SHALL list the entries of one public or unlisted YouTube
playlist without downloading any media (youtube-playlist-import). It is login-gated like every
`/api/*` route and is not scoped to a session or show. The request body SHALL be
`{ "url": string }` with `url` 1–2048 characters; unknown body keys are ignored.

The URL SHALL be accepted only when all of these hold, checked on the parsed URL:

- the scheme is `http` or `https` and the lowercased hostname is exactly `youtube.com`,
  `www.youtube.com`, `m.youtube.com` or `music.youtube.com`;
- the path is `/playlist` or `/watch`;
- the `list` query parameter matches `^[A-Za-z0-9_-]{2,64}$`.

A `/watch` URL with a `list` parameter SHALL be treated as that playlist; its `v` parameter is
ignored. A list id beginning `RD` (Mix and radio lists) and the private-only list ids `WL`, `LL`
and `LM` SHALL be refused with their own `400` details below.

Responses, decided in this order (each later row only when no earlier row applies):

| Status | When | Body |
| --- | --- | --- |
| `401` | not logged in | `{"detail":"Login required."}` |
| `503` | no `yt-dlp` available (the `youtube-import` gate) | `{"detail":"YouTube import is unavailable on this deployment."}` |
| `403` | not an approved user ("Run features are limited to approved users") | `{"detail":"This feature is limited to approved users on this server."}` |
| `400` | body not JSON, or not `{url: string}` within 1–2048 characters | `{"detail":"Invalid playlist request body."}` |
| `400` | `url` fails the host, path or `list` rules above | `{"detail":"url must be a YouTube playlist link: youtube.com/playlist?list=… or youtube.com/watch?v=…&list=…."}` |
| `400` | list id begins `RD` | `{"detail":"Mix and radio lists can't be imported; use a regular playlist link."}` |
| `400` | list id is `WL`, `LL` or `LM` | `{"detail":"Private lists such as Watch Later and Liked videos can't be imported; use a public or unlisted playlist."}` |
| `503` | two listings are already running in this server process | `{"detail":"Playlist listing is busy; try again."}` |
| `502` | YouTube reports the playlist private or nonexistent | `{"detail":"This playlist is private or does not exist. Only public and unlisted playlists can be imported."}` |
| `502` | YouTube reports the playlist type unviewable | `{"detail":"This playlist type can't be listed; use a regular playlist link."}` |
| `502` | the listing ran longer than 60 seconds | `{"detail":"Listing the playlist timed out."}` |
| `502` | any other listing failure, including output over 16 MiB or output that is not a playlist | `{"detail":"Failed to list the playlist."}` |
| `200` | the listing ran | the object below |

No `400` row, nor the busy `503`, SHALL spawn a subprocess or make an outbound request.

The `200` body SHALL be exactly:

```
{ "playlist": { "id": string, "title": string, "url": string },
  "entries":  [{ "index": number, "video_id": string, "url": string,
                 "title": string | null, "duration_s": number | null,
                 "importable": boolean,
                 "reason": "unavailable" | "live" | "upcoming" | "too_long" | null }],
  "truncated": boolean }
```

- `playlist.id` is the validated list id; `playlist.url` is
  `https://www.youtube.com/playlist?list=<id>`; `playlist.title` is YouTube's title for the
  playlist, or `""` when none is reported.
- `entries` are in playlist order, at most 5000. `index` is the 1-based position in that order.
  An entry whose video id does not match `^[A-Za-z0-9_-]{11}$` is left out, and the positions of
  the remaining entries are not renumbered.
- `url` is `https://www.youtube.com/watch?v=<video_id>`, which `youtube-import` accepts unchanged.
- `title` is the reported video title with control characters (U+0000–U+001F, U+007F–U+009F)
  removed and at most 500 characters; it is `null` when YouTube reports no title.
- `duration_s` is the reported duration in seconds, or `null` when none is reported.
- `reason` is the first that applies of: `unavailable` (no title, or a title of exactly
  `[Private video]` or `[Deleted video]`), `live` (a live stream in progress), `upcoming` (a
  scheduled premiere or stream), `too_long` (a duration over 14,400 seconds, the `youtube-import`
  4-hour limit); otherwise `null`. `importable` is `true` exactly when `reason` is `null`.
- `truncated` is `true` when the playlist reports more entries than were returned.
- An empty playlist SHALL give `200` with `entries: []`.
- The endpoint SHALL set no cookies, SHALL write nothing to the catalog or blob store, and SHALL
  download no media.

#### Scenario: A public playlist is listed
- **WHEN** an approved user posts `{"url":"https://www.youtube.com/playlist?list=PLBB231211A4F62143"}`
  on a deployment with `yt-dlp`
- **THEN** the response is `200` with `playlist.id` `PLBB231211A4F62143`, one entry per listed
  video in playlist order with `index` starting at 1, each entry's `url` of the form
  `https://www.youtube.com/watch?v=<video_id>`, and `truncated` `false`

#### Scenario: A watch link with a list is the playlist
- **WHEN** the posted `url` is `https://www.youtube.com/watch?v=RlJy2Kt8Be0&list=PLBB231211A4F62143`
- **THEN** the response lists the playlist `PLBB231211A4F62143`, not the single video

#### Scenario: Mix lists are refused before any spawn
- **WHEN** the posted `url` is `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ`
- **THEN** the response is `400` with the Mix detail and no subprocess is spawned

#### Scenario: Non-playlist links are refused before any spawn
- **WHEN** the posted `url` is `https://www.youtube.com/watch?v=dQw4w9WgXcQ` (no `list`),
  `https://youtu.be/dQw4w9WgXcQ?list=PLx`, `https://www.youtube.com/@channel`, or a host such as
  `youtube.com.evil.com`
- **THEN** the response is `400` with the playlist-link detail and no subprocess is spawned

#### Scenario: Private-only lists are refused before any spawn
- **WHEN** the posted `url` is `https://www.youtube.com/playlist?list=WL`
- **THEN** the response is `400` with the private-lists detail and no subprocess is spawned

#### Scenario: A private or missing playlist is a clear 502
- **WHEN** YouTube reports that the requested playlist does not exist or is private
- **THEN** the response is `502` with the private-or-nonexistent detail

#### Scenario: Unavailable entries are listed but not importable
- **WHEN** a playlist holds a deleted video (no title reported) and a 5-hour video
- **THEN** both appear in `entries` at their positions with `importable` `false` and `reason`
  `unavailable` and `too_long` respectively

#### Scenario: Unconfigured deployment answers 503 before the approval check
- **WHEN** a user who is not approved posts to the route on a deployment with no `yt-dlp`
- **THEN** the response is `503` with the `youtube-import` unavailable detail

#### Scenario: A third concurrent listing is busy
- **WHEN** two listings are running in the server process and a third request with a valid URL
  arrives
- **THEN** the response is `503` `{"detail":"Playlist listing is busy; try again."}` and no
  subprocess is spawned for it

## MODIFIED Requirements

### Requirement: Run features are limited to approved users

The run-starting routes `POST /api/sessions/:id/ai/chat`, `POST /api/sessions/:id/ai/v2/design`,
`POST /api/sessions/:id/topics/generate`, `POST /api/sessions/:id/events/generate`,
`POST /api/sessions/:id/youtube-import`, `POST /api/sessions/:id/transcript-words/generate` and
`POST /api/youtube/playlist-entries` SHALL
respond `403 {"detail": "This feature is limited to approved users on this server."}` to a logged-in
user who may access the session (for the session routes) but whose verified login email is not an
approved user (run-status-and-sweeper D9; youtube-playlist-import adds the playlist listing, which
makes outbound requests to YouTube). The bootstrap owner (`BOOTSTRAP_OWNER_EMAIL`) SHALL always be an
approved user, and `RUN_FEATURE_EMAILS`, a comma-separated list whose entries are trimmed and whose
blank entries are dropped, SHALL add approved users to it; unset, blank or all-blank (such as `,`)
SHALL mean the bootstrap owner alone. Every match SHALL use the bootstrap-owner rule (trimmed,
`A`-`Z` folded, exact; a non-ASCII token email never matches). The check SHALL run immediately after
the route's configuration `503` (so every earlier refusal of the route's frozen order, such as
`401`, the session-access `404`, the AI v2 principal `404` and, for events/generate, the body `400`,
keeps its place), and before the in-process slot, the run lease and any subprocess or provider
call. For `ai/v2/design` it SHALL run after both the configuration `503` and the agent-credentials
`503`, that is after the whole shared AI v2 guard prologue, and SHALL NOT be part of that prologue,
which the AI v2 answer route also runs and which stays ungated. For `youtube/playlist-entries` it
SHALL run after the configuration `503` and before the body `400`. Each route's own ordered
requirement or status table SHALL list the `403` at that step. No other route SHALL be affected.

#### Scenario: A user who is not approved is refused before any work

- **WHEN** a member of the session's show whose email is not in `RUN_FEATURE_EMAILS` posts to any of
  the seven routes on a configured deployment
- **THEN** the response is `403` with the fixed detail, no subprocess or provider call is made, no
  in-process slot is taken, and no run lease row is written

#### Scenario: Unset list means the bootstrap owner

- **WHEN** `RUN_FEATURE_EMAILS` is unset and the bootstrap owner posts to one of the seven routes
- **THEN** the request proceeds to the route's existing behavior

#### Scenario: An all-blank list means the bootstrap owner alone

- **WHEN** `RUN_FEATURE_EMAILS` is `,` (only blank entries), and the bootstrap owner and then
  another member of the session's show post to one of the seven routes on a configured deployment
- **THEN** the bootstrap owner's request proceeds to the route's existing behavior, and the other
  member's request is answered `403` with the fixed detail

#### Scenario: Granting someone keeps the owner approved

- **WHEN** `RUN_FEATURE_EMAILS` names only another member's address, and the bootstrap owner posts to
  one of the seven routes on a configured deployment
- **THEN** the bootstrap owner's request proceeds to the route's existing behavior, and the named
  member is admitted too

#### Scenario: An unconfigured feature still answers 503

- **WHEN** a user who is not approved posts to a route whose feature is not configured
- **THEN** the response is the route's existing `503`, not `403`

#### Scenario: The playlist listing refuses a user who is not approved before reading the body

- **WHEN** a signed-in user who is not approved posts a malformed body to
  `POST /api/youtube/playlist-entries` on a deployment with `yt-dlp`
- **THEN** the response is `403` with the fixed detail, not `400`, and no subprocess is spawned
