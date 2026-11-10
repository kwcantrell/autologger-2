# Design: youtube-playlist-import

## Context

See proposal.md (Why, Owner decisions). The current state that shapes the approach:

- **The single-video import** is `POST /api/sessions/:sessionId/youtube-import`
  (`server/src/routers/sessions.ts:480-664`). Guard order: `requireSession` → config `503`
  (`YTDLP_RESOLVED_PATH`) → `requireRunFeature` `403` → body/URL `400` → per-session guard and run
  lease `409` → rolling `409` → download → access re-check → blob put, segment, anchor → optional
  `episode_date`. Its success is `200 {ok: true}`; every post-validation failure is
  `502 {detail}` with a fixed, safe message. It holds the request open for the whole download.
- **The spawn module** is `packages/media-import/src/ytdlp.ts`: `buildYtDlpChildEnv` (HOME, PATH
  pinned to the binary's directory, a proxy/TLS allowlist), `LOCKDOWN_ARGV`
  (`--ignore-config --no-plugin-dirs --no-warnings`), `runYtDlpProcess` (`shell: false`,
  `detached: true`, process-group SIGKILL on timeout). `runYtDlpProcess` accumulates **all** of
  stdout with no bound and discards stderr; that was fine for one `--dump-json` object, not for a
  playlist.
- **Temp dirs** use the prefix `youtube-import-` under `ports.audio.scratchRoot()`, and
  `sweepStaleYoutubeImportTempDirs` removes leftovers at startup
  (`packages/media-import/src/youtubeImportScratch.ts:27,33`).
- **The fake binary** `packages/media-import/fixtures/fake-ytdlp.mjs` is driven by a
  `.ytdlp-stub.json` control file in the spawn's cwd, so any spawn the tests exercise must run in a
  per-request directory.
- **Folder batch import** is a browser loop (`web/src/pages/index/batchImport/runner.ts`): align
  the active show, list sessions, per group skip on `episode`/`title` match, create, upload, on a
  failure delete the created session (no abort signal, so it runs even on abort), and report
  through `BatchImportProgressState {current, percent, lines}`. The modal
  (`web/src/pages/index/components/BatchImportModal.tsx`) runs audio then logs, and an unmount
  aborts.
- **Session create** caps `episode` at 80 and `title` at 200 characters
  (`packages/contract/src/schemas.ts:41,51`); an explicit title bypasses title-suffix derivation
  (api-contract-freeze "Create-session optional episode under date suffix").
- **Deleted sessions are hidden, not removed**, and `canAccessSession` (the import's post-download
  re-check) includes hidden sessions (`server/src/routers/_helpers.ts:126`).
- **`apiFetch`** throws `ApiError(status, detail, body)` with `body` `undefined` when the response
  is not JSON (`web/src/api/client.ts`), which lets the client tell a server `{detail}` from a
  proxy page.
- **The README endpoint table** is the normative route list, and
  `server/src/routers/readmeEndpoints.repo.test.ts` checks that listed routes are registered with
  their statuses.

## Goals / Non-Goals

**Goals:**
- One listing request returns everything the picker needs, in one bounded subprocess, in well
  under Cloudflare's 100 s proxy limit.
- The import of each video reuses `youtube-import` byte for byte; no server change outside the
  new route.
- A re-run of the same playlist is safe: done videos skip, failed ones retry.

**Non-Goals:**
- Server-side progress, resumability across tabs, or a background job.
- Detecting age-restricted or members-only videos before import.

## Decisions

### D1. One stateless listing route, outside the session routes

`POST /api/youtube/playlist-entries` in a new `server/src/routers/youtubePlaylist.ts`, mounted in
`server/src/app.ts` next to `sessionsRouter`. Not session-scoped (nothing exists yet to scope to)
and not show-scoped (the listing reads no show data; the run-feature `403` is the abuse gate).
POST with a JSON body rather than `GET ?url=`: the body schema mirrors `youtube-import`'s and the
playlist URL stays out of access logs.

**Alternatives:** `POST /api/shows/:showId/youtube-playlist` (adds a show-access check that guards
nothing the listing touches); a server-side import job (owner decision 1 chose the browser loop).

### D2. URL validation and canonicalization in `@autologger/contract`

`validateYoutubePlaylistUrl(raw)` beside `validateYoutubeImportUrl` returns
`{ok: true, listId, href}` or `{ok: false, reason: 'not-playlist' | 'mix'}`:
`new URL()` parse, `http(s)`, exact host in `{youtube.com, www.youtube.com, m.youtube.com,
music.youtube.com}`, pathname `/playlist` or `/watch`, `list` matching `^[A-Za-z0-9_-]{2,64}$`;
then `RD*` → `mix`. Private lists such as `WL` and `LL` are not special-cased: YouTube answers
them "does not exist" (A4), which is already the private-or-nonexistent `502` (panel: no frozen
surface without user value). The body itself is checked by `youtubePlaylistBodySchema` and refused
with the frozen `422 {detail: [zod issues]}` (api-contract-freeze "Validation error bodies carry
zod 4 issues"); only the URL rules give `400`. `href` is always
`https://www.youtube.com/playlist?list=<listId>`, which is what yt-dlp gets. Canonicalizing means
the `v` of a watch link can never make yt-dlp take the single-video path, `music.youtube.com`
never selects a different extractor, and no caller-controlled query parameter reaches the child.
`youtu.be` and `youtube-nocookie.com` are left out: owner decision 5 names only the two
`youtube.com` forms.

### D3. Spawn: one flat-playlist call with output, time and entry bounds

New `packages/media-import/src/ytdlpPlaylist.ts` exports `listYoutubePlaylist({listId, href,
tempDir, binaryPath, procEnv?, timeoutMs?, maxStdoutBytes?})`. Flags (exported as
`PLAYLIST_FLAGS` for the real-binary smoke test): `LOCKDOWN_ARGV`, `--flat-playlist`,
`--dump-single-json`, `--playlist-end 5000`, then `--` and `href`.

`runYtDlpProcess` gains an optional `maxStdoutBytes` (kill the group and report
`overflow: true`) and `maxStderrBytes` (keep the first N bytes, default 0 so the import spawn is
unchanged). The import's calls pass neither, so `fetchYoutubeAudio` keeps its behavior; it is
refactored only to share the helper.

Bounds, from the measurements in Assumptions:

| Axis | Bound | Basis |
| --- | --- | --- |
| Entries | 5000 (`--playlist-end`) | YouTube's own playlist cap; uploads lists exceed it (A7) |
| Stdout | 16 MiB | ~1.36 KB per entry (A2, A6) → 5000 ≈ 6.8 MB; 2.3× headroom |
| Stderr | first 64 KiB, classify only | error lines are under 200 bytes (A4) |
| Wall clock | 60 s | 1702 entries in 9.4 s (A6) → 5000 ≈ 28 s; under the 100 s proxy limit |
| Concurrency | 2 per process, else busy `503` | as search's 2-at-once; each listing is one short child |

Failure classification (fixed details, stderr never echoed): stderr matching
`/does not exist|is private|private playlist/i` → private-or-nonexistent `502`; timeout →
timed-out `502`; anything else (overflow, another non-zero exit such as an unviewable playlist
type, unparseable JSON, a `_type` other than `playlist`) → generic `502`.

The process cap is a module singleton like `youtubeImportGuard` (`playlistListingGuard`,
`tryAcquire(): lease | null`), acquired after the `422`/`400` checks and released in `finally`. The
per-request temp dir is `youtube-import-playlist-<random>` under `scratchRoot()`, so the existing
startup sweep covers it.

### D4. Entry projection is the server's job

`projectPlaylist(raw, listId)` in `packages/media-import/src/playlistEntries.ts` maps yt-dlp's
entry objects to the contract shape, so the client never sees yt-dlp's schema: keep only
entries whose `id` matches `^[A-Za-z0-9_-]{11}$`; `index` is the 1-based
position in yt-dlp's `entries` array (a dropped malformed entry leaves a gap rather than shifting
later positions); `title` with control characters stripped and capped at 500; `duration_s` a
finite non-negative number or `null`; `reason` by the contract's order (title `null` or the
literal `[Private video]`/`[Deleted video]` → `unavailable`; `live_status` `is_live` → `live`,
`is_upcoming` → `upcoming`; `duration_s >= 14400` → `too_long`, matching the download filter
`duration < 14400` in `downloadFlags`, so an exactly-4-hour video is never offered and then
refused). `truncated` is
`entries.length === 5000 && (playlist_count ?? 0) > 5000`. The mapper is a pure function with
unit tests over recorded fixtures (A2, A8).

### D5. Client: a picker component and a second runner

- `web/src/pages/index/components/PlaylistPicker.tsx`: the loaded listing, checkboxes, Select
  all/none, From/To range, count, "Use publish date", truncated notice. Rows render in a
  scrollable list (max height) of plain checkboxes, each row styled `content-visibility: auto` so
  off-screen rows are not laid out; selection is one `Set<number>` of positions, so Select all and
  the range are one state update. No virtualization library: a 5000-row render test (task 8.3)
  bounds the cost, and the picker is mounted only while a playlist is loaded.
- `web/src/pages/index/batchImport/playlistNames.ts`: `playlistSessionNames(entries) → Map<index,
  name>` implementing the naming requirement; pure, unit-tested.
- `web/src/pages/index/batchImport/playlistRunner.ts`: `runPlaylistImport({showId, entries,
  names, usePublishDate, profile, signal, initialLines, onProgress, onSessionCreated, sleep?})`.
  It reuses `alignActiveShow`, `fetchSessions`, `createSessionForStem`, `deleteSession`,
  `findMatchingSession` and the `format*Line` helpers, which `runner.ts` exports (today they are
  module-private, except the formatters and matcher). `initialLines` carries the folder part's
  lines so the one progress state keeps every part (`runBatchImport` replaces `lines` wholesale
  through `onProgress`). `sleep` is injectable so the 15 s polling is tested with fake time.
- **Per-entry show check and fresh list.** `GET /api/sessions` lists the profile's *current*
  active show (`server/src/routers/sessions.ts:147-177`), not the run's, and a run lasts hours.
  Before each entry the runner reads `GET /api/profile`; if `active_show_id` is not the run's show
  it re-runs `alignActiveShow` (one progress line), then fetches the list and keeps only sessions
  with `show_id === showId`. The filter means a switch that lands between the profile read and the
  list read can only cause a missed skip, never a skip against another show's session. The list is
  read immediately before each create, so a session another tab or member made for the same video
  a moment ago is skipped.
- **Created-session memory.** The runner remembers each session it creates with the folder
  import's `rememberImportSession` (IndexedDB, 30 days, `web/src/api/uploads.ts:184`) under the key
  `youtube:<showId>:<video_id>`, and forgets it on completion or after a definite-failure delete.
  A name match that is remembered for this show and video and has zero audio segments
  (`GET …/audio/segments`, as `resumableSessionFor` reads) is retried into, not skipped; a `409`
  there means the server is still importing it (its per-session guard and run lease), so the
  runner logs that and moves on without creating anything. A session someone made by hand is
  never imported into.
- **Validation details.** `apiFetch` turns an array `detail` into `JSON.stringify` text. The
  runner formats `ApiError.body.detail` arrays itself as `<path joined with .>: <message>` joined
  with `; ` (a helper beside the line formatters).
- The modal runs folder → playlist → logs (logs last so they can match sessions just created).

### D6. Session naming (owner decision 2)

The name must fit `episode` (`z.string().max(80)`; the locked zod 4.6.5 counts code points, A16)
because both fields get it, must survive the create path's trim,
and must never carry NUL (api-contract-freeze "Text containing NUL is refused"). Hence NFC,
control characters to spaces, whitespace collapse, trim, then a cut at 80 UTF-16 units (stricter than
the schema's count, so it always fits however the schema counts) that drops
a surrogate pair rather than splitting it (a lone surrogate would be stored as U+FFFD or refused).

Duplicates within a listing get ` [<video_id>]` on **every** entry sharing the plain name, with
the title part cut to 66 units. A positional ` (k)` (the first draft) shifts when a same-titled
video is added above or removed, and a re-run then skips a video that was never imported because
its new name matches another video's session (panel). With the id suffix every name depends only on
the video and on whether its title is shared, never on positions or the selection.

**Residual:** if a playlist later gains a second video with an already-imported title, the first
video's name changes from `Q&A` to `Q&A [id]`, so a re-run imports it once more under the new
name. That is a visible duplicate, not a silent skip, and needs a new same-titled upload.

**Alternatives:** suffix every name with the id (stable always, but the owner asked for the title);
positional suffixes (rejected above).

### D7. Failure, abort and unknown outcomes

- A `{detail}` failure is definite (the route rolls back its own segment on every path), so the
  runner deletes the session it created and forgets it, as folder import does, and a re-run
  retries the video.
- `401`, `403` and `503` end the playlist part: every later request would fail identically.
- **A failure with no JSON body** (network error, Cloudflare `524` after 100 s) is an unknown
  outcome: the server keeps downloading (it does not watch the client connection). Moving on would
  let one run stack up concurrent server downloads, each up to 2 GB buffered by `readFile`
  (`server/src/routers/sessions.ts:556`), with no global cap (panel). So the runner keeps the
  session and waits: it reads `GET …/audio/segments` every 15 s for at most 32 minutes (the probe
  and download spawns each have a 15-minute hang bound, `DEFAULT_HANG_TIMEOUT_MS`, plus 2 minutes
  for the blob write and anchor). A segment means success. It never re-sends `youtube-import`
  while waiting: a re-send racing the first import's finish would attach the audio twice, because
  the lease is released only after the segment is attached. If nothing appears, the line says so
  and the remembered empty session is retried by the next run (D5).
- **Abort** (modal close) stops the run and any waiting, and **keeps** the in-flight session,
  remembered: the server finishes or fails on its own, and the next run skips it (has audio),
  retries it (empty), or gets `409` (still running). The first draft deleted it, which left the
  server attaching audio to a hidden session (`canAccessSession` includes hidden sessions).
- With these rules one run has at most one server download in flight. A user who closes and
  reopens the modal and starts again can add one more per restart (the restarted run gets `409`
  for the in-flight video and moves on to the next). A process-wide cap on `youtube-import`
  downloads would bound that, but it would add a new refusal to `youtube-import`, whose frozen
  contract has none for other sessions ("No global import ceiling on claude_cli"); left as an open
  question.

### D8. Contract and docs

api-contract-freeze ADDED "YouTube playlist listing endpoint" and MODIFIED "Run features are
limited to approved users" (seven routes). README: endpoint table row (statuses 200, 400, 403,
422, 502, 503), "Run features: approved users only" route list (six → seven), the
`RUN_FEATURE_EMAILS` row of the settings table (README.md:1267, which names the run features),
"YouTube audio import" section paragraph on playlists. `readmeEndpoints.repo.test.ts` gains the
route.

**API-response conformance** (web-api-response-conformance): the new `POST youtube/playlist-entries`
site and the create, import, delete, profile, session-list and segment-list calls in
`playlistRunner.ts` are response-consuming sites that `web/src/apiResponseShapes.repo.test.ts`
scans. The response types (`YoutubePlaylistResponse`, `YoutubePlaylistEntry`) are declared in
`web/src/api/types.ts`, because `web` does not depend on `@autologger/contract`
(`grep -n contract web/package.json` → none). A real `200` body is captured by
`server/src/routers/apiResponseFixtures.int.test.ts` (fake binary), and
`web/src/api/types.conformance.test.ts` assigns the capture to the client type; the moved runner
calls reuse the existing captures for their endpoints (session, sessions list, profile, segments,
`{ok: true}`), with a recorded verdict for each new site.

## Assumptions

Each was checked on 2026-11-09 with the yt-dlp pinned in the project image (`autologger-api:dev`,
the same binary prod uses) or by reading the code. `Y` below is
`docker run --rm --entrypoint /opt/ytdlp/yt-dlp autologger-api:dev --ignore-config --no-plugin-dirs --no-warnings --flat-playlist -J --`.

- **A1. The image's yt-dlp version.** `docker run --rm --entrypoint /opt/ytdlp/yt-dlp
  autologger-api:dev --version` → `2026.08.19`.
- **A2. Flat listing shape.** `$Y 'https://www.youtube.com/playlist?list=PLBB231211A4F62143'` →
  exit 0, 40,030 bytes; `_type: playlist`, `id: PLBB231211A4F62143`, `title: Team Fortress 2 [2010
  Version]`, `playlist_count: 29`, 29 entries, 1312 bytes per entry; entry keys include `id`,
  `title`, `duration`, `live_status`, `availability`, `url`
  (`https://www.youtube.com/watch?v=RlJy2Kt8Be0`).
- **A3. A watch link with `list` lists the playlist.** `$Y
  'https://www.youtube.com/watch?v=RlJy2Kt8Be0&list=PLBB231211A4F62143'` → `playlist
  PLBB231211A4F62143 29`. (D2 canonicalizes anyway.)
- **A4. Missing and private-only lists fail fast with a classifiable line.** `$Y
  'https://www.youtube.com/playlist?list=PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'` → exit 1 in 1.2 s,
  `ERROR: [youtube:tab] PLaaaa…: YouTube said: The playlist does not exist.`; `list=WL` → the same
  message, exit 1.
- **A5. Mix lists are unviewable.** `list=RDdQw4w9WgXcQ` → `WARNING: … This playlist type is
  unviewable.` / `ERROR: … This playlist type is unviewable.` (D2 refuses `RD` before spawning.)
- **A6. Size and time at scale.** `time $Y
  'https://www.youtube.com/playlist?list=UUBR8-60-B28hp2BmDPdntcQ'` → `real 0m9.356s`, 2,308,987
  bytes, 1702 entries, 1355 bytes per entry; max duration 16,606 s (so `too_long` occurs in real
  lists); 7 entries `live_status: was_live` with durations.
- **A7. `--playlist-end` keeps the total.** `… --dump-single-json --playlist-end 100 -- <uploads
  list>` → `playlist_count` 1702, 100 entries.
- **A8. Unavailable entries are listed with no title.** `$Y
  'https://www.youtube.com/playlist?list=PLsyOSbh5bs16vubvKePAQ1x3PhKavfBIl'` → 1768 entries, 8 of
  them `{'title': None, 'duration': None, 'availability': None, 'live_status': None}`. Bracketed
  real titles such as `[MV] …` exist, so only the exact `[Private video]`/`[Deleted video]`
  literals count as unavailable.
- **A9. Empty playlists list cleanly.** `list=PL4lCao7KL_QFVb7Iudeipvc2BCavECqzc` → `playlist
  youtube-dl public playlist unlisted 0`.
- **A10. The import spawn reads unbounded stdout and no stderr.**
  `packages/media-import/src/ytdlp.ts` `runYtDlpProcess`: `stdout += chunk…`;
  `child.stderr?.on('data', () => {})`.
- **A11. Entry URLs carry no `list`, so the import downloads one video.** `grep -n "no-playlist"
  packages/media-import/src/ytdlp.ts` → no match (exit 1): the download spawn would follow a
  `list` parameter, so the runner must send the server-built `watch?v=<id>` URL only.
- **A12. Episode limit.** `packages/contract/src/schemas.ts:51` `episode:
  z.string().max(80).nullish()`.
- **A13. Hidden sessions pass the import's access re-check.** `server/src/routers/_helpers.ts:126`
  `getSessionIndexRow(sessionId, { includeHidden: true })`.
- **A14. Non-JSON errors are distinguishable.** `web/src/api/client.ts`: `body` stays `undefined`
  when `res.json()` throws.
- **A15. The startup sweep covers the new temp dir prefix.**
  `packages/media-import/src/youtubeImportScratch.ts:41` `if
  (!name.startsWith(YOUTUBE_IMPORT_TMP_PREFIX)) continue;` with the prefix `youtube-import-`.

- **A16. The locked zod counts code points; an 80-UTF-16-unit name always fits.** Corrected
  2026-11-09: the original probe (`false true` for 41/40 emoji) ran against the main checkout's
  stale zod 3.25.76 `zod/v4`. With the locked zod 4.6.5 (`package-lock.json`), from the change's
  worktree: `node --input-type=module -e "import {z} from 'zod'; const s=z.string().max(80); for
  (const n of [40,41,80,81]) console.log(n, s.safeParse('😀'.repeat(n)).success)"` → `40 true`,
  `41 true`, `80 true`, `81 false`. The UTF-16 cut is kept as the stricter bound; the real schema
  accepts the produced names (`packages/contract/src/schemas.test.ts` "newSessionBodySchema accepts
  playlist session names").
- **A17. The session list follows the profile's active show.** `sed -n 147,177p
  server/src/routers/sessions.ts` → `listSessionsForShow(activeShowId)`, with `activeShowId` read
  from the user's prefs on every request; each entry carries `show_id`.
- **A18. `web` cannot import `@autologger/contract`.** `grep -n contract web/package.json` → no
  match (exit 1).
- **A19. The created-session memory lives 30 days.** `web/src/api/uploads.ts:184`
  `IMPORT_SESSION_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000`.

## Risks / Trade-offs

- **[Proxy timeouts on long downloads]** `youtube-import` holds the request for the whole
  download; behind Cloudflare a request over 100 s gets a `524` while the server finishes. One
  manual import hits this rarely; a playlist of long videos may hit it often. → D7 waits for
  the outcome instead of moving on, so a run never stacks downloads; Open question 1.
- **[Restarts add server downloads]** Closing and restarting the run while a video downloads adds
  one concurrent server download per restart (D7). → Bounded by the import's 15-minute and 2 GB
  bounds per download; Open question 2.
- **[A newly duplicated title re-imports once]** D6 residual: visible duplicate session, never a
  silent skip.
- **[Two tabs importing the same playlist]** Both read the list, both see no match, both create
  within the same second. → Accepted: the list is read right before each create, so the window is
  one round trip; the duplicate is visible and can be deleted.
- **[Same-name videos already in the show]** A video whose title equals an unrelated existing
  session is skipped as "already in system" (owner decision 2, same as folder import).
- **[Stderr classification is text-matching]** A yt-dlp release could change wording, falling
  back to the generic `502`. → The real-binary smoke test asserts the classification on a missing
  list; the image pins yt-dlp's version.
- **[Long runs need the tab open]** Hundreds of videos run for hours in the browser. → Re-running
  resumes by skipping completed sessions.
- **[YouTube rate limiting]** Many sequential downloads from one server IP may be throttled; each
  failure is per-video and logged.

## Migration Plan

No migration or setting. Deploy as usual; a deployment without `yt-dlp` shows the unavailable
message in the picker. Rollback: revert the change; no data depends on it (sessions it created are
ordinary sessions).

## Open Questions

1. **Cloudflare 100 s limit on `youtube-import` (prod, behind the tunnel).** How often does a
   real download exceed it? If often, a follow-up could make `youtube-import` asynchronous; that
   would be its own contract change. This change only keeps the outcome honest (D7).
2. **A process-wide cap on concurrent `youtube-import` downloads.** D7 limits one run to one
   in-flight download, but restarts and several users can still stack them (each up to 2 GB
   buffered). A cap would add a new `409`/`503` to `youtube-import` for reasons outside the
   session, which its frozen "No global import ceiling on claude_cli" requirement rules out, so it
   needs its own contract change. Decide whether to propose it (or stream the blob write instead of
   `readFile`).
3. *(Closed by the panel: duplicate titles carry ` [<video_id>]`, design D6.)*
4. **`youtu.be/<id>?list=…` share links** are refused with the playlist-link `400` under owner
   decision 5. Accepting them is a one-line host addition if the owner wants it.
5. **Per-user fairness of the busy `503`.** Two listings per process is global; one user
   repeatedly loading playlists can make another see "busy" for up to 60 s. Acceptable at current
   scale (approved users only).
6. **Age-restricted and members-only videos** cannot be seen in flat metadata and fail at import
   with `youtube-import`'s generic download `502`. A clearer per-video message would need a
   `youtube-import` change.
