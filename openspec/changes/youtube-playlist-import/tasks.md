# Tasks

The first commit on `youtube-playlist-import` holds only `openspec/changes/youtube-playlist-import/`
(the approved artifacts). Every task below is test-first: write or extend the named test, run it
and record the red failure line, then write the code and record the green run. If a new test
already passes before the code, record that and say why.

Logs: keep every test and gate run under the session scratchpad as `ypi-<task>-<red|green>.log`,
and name the log in each `Evidence:` line.

Test commands: packages are `npx vitest run <files>` from the package directory
(`packages/contract`, `packages/media-import`); server is `cd server && npx vitest run --project
<unit|integration> <files>`; web is `cd web && npx vitest run <files>`.

## 1. Contract: playlist URL validation and wire types (design D2, D4)

- [ ] 1.1 Test first, `packages/contract/src/schemas.test.ts`, new `describe`
  `validateYoutubePlaylistUrl`:
  - accepted, each giving `listId` and `href` `https://www.youtube.com/playlist?list=<id>`:
    `https://www.youtube.com/playlist?list=PLBB231211A4F62143`, `http://youtube.com/playlist?list=PL_x-1`,
    `https://m.youtube.com/watch?v=RlJy2Kt8Be0&list=PLBB231211A4F62143`,
    `https://music.youtube.com/playlist?list=OLAK5uy_abc`, `https://WWW.YouTube.com/playlist?list=UUBR8-60-B28hp2BmDPdntcQ`,
    and `…/playlist?list=WL` (not special-cased: it reaches yt-dlp and gets the private-or-nonexistent `502`);
  - `not-playlist`: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`, `https://youtu.be/dQw4w9WgXcQ?list=PLx1`,
    `https://www.youtube.com/@channel`, `https://youtube.com.evil.com/playlist?list=PLx1`,
    `https://youtube.com@evil.com/playlist?list=PLx1`, `ftp://youtube.com/playlist?list=PLx1`,
    `https://www.youtube.com/playlist?list=a`, a 65-character list id, `list=PL%20x`, `not a url`;
  - `mix`: `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ`, `…/playlist?list=RDCLAK5uy_x`;
  - `youtubePlaylistBodySchema`: `{url}` 1–2048 accepted, unknown keys stripped; missing `url`,
    `''`, 2049 characters, a number refused.
  Evidence: under 1.2.
- [ ] 1.2 `packages/contract/src/schemas.ts`: `youtubePlaylistBodySchema`,
  `validateYoutubePlaylistUrl`, and the server-side response types `YoutubePlaylistEntry`,
  `YoutubePlaylistResponse`, `YoutubePlaylistUnavailableReason`; export from the package entry.
  (The web client declares its own copies in `web/src/api/types.ts`, task 7.1.)
  Evidence: red/green `cd packages/contract && npx vitest run src/schemas.test.ts`
  (ypi-1.1-red.log, ypi-1.1-green.log); `npm run typecheck` exit 0.

## 2. Spawn: bounded flat-playlist listing (design D3)

- [ ] 2.1 Test first, `packages/media-import/src/ytdlp.test.ts` (existing suite stays green):
  `runYtDlpProcess` with `maxStdoutBytes` kills the process group and reports overflow when the
  fake writes past the bound; with `maxStderrBytes` keeps only that many bytes; with neither, the
  probe and download spawns behave exactly as before (the existing cases).
  Evidence: under 2.3.
- [ ] 2.2 Test first, new `packages/media-import/src/ytdlpPlaylist.test.ts`, driving
  `fixtures/fake-ytdlp.mjs` with new control-file modes `playlist` (prints a fixture from
  `fixtures/playlist-*.json`), `playlist-missing` (stderr `ERROR: [youtube:tab] PLx: YouTube said:
  The playlist does not exist.`, exit 1), `playlist-unviewable` (stderr `… This playlist type is
  unviewable.`, exit 1), `playlist-hang`,
  `playlist-flood` (writes 17 MiB), `playlist-not-playlist` (a `_type: video` object),
  `playlist-garbage`:
  - argv is exactly `PLAYLIST_FLAGS` then `--` then the canonical href (from `argv-log.jsonl`);
  - the child env holds no planted secret and PATH is the binary's directory (from the env
    snapshot);
  - each failure mode raises `YtDlpError` with the contract's fixed message (missing → private or
    nonexistent; hang with `timeoutMs: 500` → timed out; unviewable, flood, not-playlist, garbage,
    other non-zero exit → generic), and no stderr text appears in any message;
  - the hang and flood cases leave no child process (the group is killed).
  Evidence: under 2.3.
- [ ] 2.3 `packages/media-import/src/ytdlp.ts` (bounded `runYtDlpProcess`, exported for the new
  module), new `packages/media-import/src/ytdlpPlaylist.ts` (`PLAYLIST_FLAGS`,
  `listYoutubePlaylist`), fixture modes and recorded fixtures (trimmed from the design's A2 and A8
  outputs: 3 normal entries, one with no title, one `is_live`, one `is_upcoming`, one 16,606 s,
  one malformed id).
  Evidence: red/green `cd packages/media-import && npx vitest run src/ytdlp.test.ts
  src/ytdlpPlaylist.test.ts` (ypi-2.1-red.log, ypi-2.1-green.log).
- [ ] 2.4 Test first, `packages/media-import/src/ytdlp.realbinary.test.ts`: every
  `PLAYLIST_FLAGS` option is a real yt-dlp option (same shape as the probe/download cases; skips
  without a binary). Then, if it fails, fix the flag. Run it with the image's binary:
  `docker run --rm -v "$PWD":/w -w /w/packages/media-import -e YTDLP_PATH=/opt/ytdlp/yt-dlp
  --entrypoint npx autologger-api:dev vitest run src/ytdlp.realbinary.test.ts`, or on the dev
  stack.
  Evidence: the run output with the new case passing, not skipped (ypi-2.4-green.log).

## 3. Entry projection (design D4)

- [ ] 3.1 Test first, new `packages/media-import/src/playlistEntries.test.ts` over the recorded
  fixtures: positions are 1-based and keep a gap where the malformed id was dropped; `url` is
  `https://www.youtube.com/watch?v=<id>`; a title with `\u0000`, `\n` and `\u0085` loses them; a
  600-character title is cut to 500; `reason` is `unavailable` for a `null` title and for exactly
  `[Deleted video]`/`[Private video]` with null duration but `null` for `[MV] Song`; `live` for
  `is_live`, `upcoming` for `is_upcoming`, `null` for `was_live` with a duration; `too_long` for
  16,606 s and for exactly 14,400 s (the download filter is `duration < 14400`), `null` for
  14,399 s; `importable` iff `reason === null`; `truncated` true
  only for 5000 entries with `playlist_count` 7000; playlist `title` `""` when missing.
  Evidence: under 3.2.
- [ ] 3.2 New `packages/media-import/src/playlistEntries.ts` (`projectPlaylist(raw, listId)`);
  export it and `listYoutubePlaylist` from the package entry.
  Evidence: red/green `cd packages/media-import && npx vitest run src/playlistEntries.test.ts`
  (ypi-3.1-red.log, ypi-3.1-green.log).

## 4. Listing guard (design D3)

- [ ] 4.1 Test first, new `packages/media-import/src/playlistListingGuard.test.ts`: two
  `tryAcquire()` succeed, the third returns `null`, a release frees one slot, a double release
  frees only one, `reset()` clears.
  Evidence: under 4.2.
- [ ] 4.2 New `packages/media-import/src/playlistListingGuard.ts` (cap 2, module singleton).
  Evidence: red/green `cd packages/media-import && npx vitest run src/playlistListingGuard.test.ts`
  (ypi-4.1-red.log, ypi-4.1-green.log).

## 5. Route (design D1; api-contract-freeze "YouTube playlist listing endpoint", "Run features")

- [ ] 5.1 Test first, new `server/src/routers/youtubePlaylist.int.test.ts` with the fake binary
  (pattern of `sessions.youtubeImport.int.test.ts`):
  - signed out → `401`; no yt-dlp → `503` with the import's detail, for an approved and an
    unapproved user, with no spawn; unapproved user with yt-dlp → `403` before a malformed body;
  - a body that is not JSON, `{}`, `{"url": 5}` and a 2049-character `url` → `422` with an array
    `detail` (an issue at `["url"]` for the last three); each `400` row (playlist link, Mix) with
    its exact detail; none of them spawns (`argv-log.jsonl` absent);
  - two listings held open (fake `playlist-hang`) → a third valid request `503` busy, no third
    spawn; after they end, a request succeeds;
  - each `502` row with its exact detail, including `list=WL` with the fake's `playlist-missing`
    → the private-or-nonexistent detail, and `playlist-unviewable` → the generic detail;
  - `200`: body keys exactly `playlist`, `entries`, `truncated`; entry keys exactly the contract's
    seven; the watch-with-list URL lists the playlist; an empty playlist gives `entries: []`;
  - no `Set-Cookie`; the temp dir is gone after success, a failure and a timeout; no catalog row
    or blob written (session and segment counts unchanged).
  Evidence: under 5.3.
- [ ] 5.2 Test first, in the new route's `server/src/routers/youtubePlaylist.int.test.ts` (there is
  no shared run-feature test; each route's int test carries its own cases, as
  `sessions.youtubeImport.int.test.ts` does): `RUN_FEATURE_EMAILS` unset → the bootstrap owner
  proceeds; `,` → owner proceeds, another member `403`; only another member listed → both proceed;
  an unapproved user with a malformed body → `403`, not `422`; unconfigured → `503` for an
  unapproved user.
  Evidence: under 5.3.
- [ ] 5.3 New `server/src/routers/youtubePlaylist.ts` (guard order: config `503` → `403` → body
  `422` (the repo's zod-issue helper) → URL `400` → busy `503` → temp dir → `listYoutubePlaylist` → `projectPlaylist` → `200`;
  `finally` releases the guard and removes the temp dir); mount in `server/src/app.ts`.
  Evidence: red/green `cd server && npx vitest run --project integration
  src/routers/youtubePlaylist.int.test.ts src/routers/sessions.youtubeImport.int.test.ts`
  (ypi-5.1-red.log, ypi-5.1-green.log); the existing `youtube-import` cases unchanged and green.

## 6. README (design D8)

- [ ] 6.1 Test first, `server/src/routers/readmeEndpoints.repo.test.ts`: add the route
  (`server/src/routers/youtubePlaylist.ts`, `post`, `'/api/youtube/playlist-entries'`, README text
  `POST /api/youtube/playlist-entries`, statuses `200`, `400`, `403`, `422`, `502`, `503`).
  Evidence: under 6.2.
- [ ] 6.2 README: the endpoint table row (body, `200` shape, every status and detail, the bounds);
  "Run features: approved users only" lists seven routes; the `RUN_FEATURE_EMAILS` row of the
  settings table (README.md:1267) adds "YouTube playlist listing" to its run features; "YouTube
  audio import" gains a playlist paragraph (accepted links, refused Mix lists, private lists as the
  `502`, the 5000-entry, 16 MiB, 60 s and 2-at-once bounds, no downloads); `routers/youtubePlaylist.ts` and the new media-import files in
  the source map.
  Evidence: red/green `cd server && npx vitest run --project unit
  src/routers/readmeEndpoints.repo.test.ts` (ypi-6.1-red.log, ypi-6.1-green.log).

## 7. API-response conformance (design D8; web-api-response-conformance)

- [ ] 7.1 Test first:
  - `server/src/routers/apiResponseFixtures.int.test.ts`: capture a real `200` body of
    `POST /api/youtube/playlist-entries` (fake binary, the recorded fixture with one importable,
    one unavailable and one `too_long` entry) as a new fixture, generated with
    `UPDATE_API_FIXTURES=1` like the existing ones, and assert the capture has exactly the
    contract's top-level and entry keys;
  - `web/src/api/types.conformance.test.ts`: assign the capture to `YoutubePlaylistResponse`
    (and an entry to `YoutubePlaylistEntry`), so a missing or mistyped field fails `tsc`;
  - `web/src/apiResponseShapes.repo.test.ts`, run before the types exist and again after task 8.2
    adds `playlistRunner.ts`: every new site is listed (the listing call, and the profile, session
    list, segment list, create, `youtube-import` and delete calls the runner makes) and each has a
    conformance assignment or a recorded exemption with its reason. The moved calls reuse the
    existing captures for their endpoints; record a verdict row for each new site (endpoint,
    client shape, emitted shape, conforms) where the audit keeps them.
  Then `web/src/api/types.ts`: `YoutubePlaylistResponse`, `YoutubePlaylistEntry`,
  `YoutubePlaylistUnavailableReason` (web does not depend on `@autologger/contract`).
  Evidence: red/green `cd server && UPDATE_API_FIXTURES=1 npx vitest run --project integration
  src/routers/apiResponseFixtures.int.test.ts`, then `cd web && npx vitest run
  src/api/types.conformance.test.ts src/apiResponseShapes.repo.test.ts` and `npx tsc --noEmit`
  (ypi-7.1-red.log, ypi-7.1-green.log); the repo test re-run after 8.2 (ypi-7.1-after-8.2.log).

## 8. Web: naming, picker, runner, modal (design D5, D6, D7; batch-audio-import)

- [ ] 8.1 Test first, new `web/src/pages/index/batchImport/playlistNames.test.ts`: the spec
  scenarios (cleaning; 120 ASCII characters → 80; 80 `😀` → 40 `😀`, length 80 in UTF-16 units, no
  lone surrogate; `Q&A` at three positions → `Q&A [<id>]` each); a title whose 80th unit is the
  first half of a pair → cut to 79 units; an all-whitespace title → `YouTube <video_id>`; a shared
  plain name with a long base → base cut to 66 units, total ≤ 80, no split pair; a unique title
  keeps no suffix; names unchanged when the selection changes and when the listing's order is
  reversed; untitled entries get no name; every produced name passes the create schema's
  `episode` rule (`z.string().max(80)` mirrored in the test).
  Then `web/src/pages/index/batchImport/playlistNames.ts`.
  Evidence: red/green `cd web && npx vitest run src/pages/index/batchImport/playlistNames.test.ts`
  (ypi-8.1-red.log, ypi-8.1-green.log).
- [ ] 8.2 Test first, new `web/src/pages/index/batchImport/playlistRunner.test.ts` (mocked
  `apiFetch` and an in-memory import-session memory, as `runner.test.ts`; injected `sleep`):
  - active show aligned at start; before each entry the profile is read and, when another tab
    switched the active show, it is switched back with one line; the session list is read right
    before each create; a same-named session whose `show_id` is another show does not cause a skip;
  - skip on `episode` or `title` match in the run's show with the skipped line; a remembered,
    segment-less session for the same show and video is imported into (no create); the same with a
    `409` → the still-importing line, no create, next entry; a remembered session that has a
    segment is skipped;
  - create body `{show_id, episode: name, title: name, frame_rate, start_offset_frames: 0}`; the
    created session is remembered under `youtube:<showId>:<video_id>` and forgotten on success;
    `youtube-import` body `{url, use_publish_date}` for both checkbox values;
  - a `502 {detail}` → failed line, session deleted and forgotten, loop continues; a create `422`
    with issue `["episode"]`/`Too big` → `Failed <name>: episode: Too big`;
  - a non-JSON `524` → session kept; no request for the next entry until the segment list shows a
    segment (polled every 15 s by fake time) → `Completed`; with no segment after 32 minutes of
    fake time → the did-not-confirm line, session kept and remembered, next entry starts; no
    `youtube-import` re-send while waiting;
  - `403` → failed line, a not-attempted line with the count, no further request;
  - abort during an import or during the wait → no further entry, the in-flight session kept and
    remembered (no delete), rejects with `AbortError`;
  - `initialLines` kept ahead of the playlist lines; `current` reads
    `Importing <name> (video i of n)...` and, while waiting, `Waiting for the server to finish
    <name>...`; sessions query invalidated after each create.
  Then `web/src/pages/index/batchImport/playlistRunner.ts` and the validation-detail formatter, and
  export the shared helpers from `runner.ts` (`runner.test.ts` and `runner.parts.test.ts` stay
  green).
  Evidence: red/green `cd web && npx vitest run src/pages/index/batchImport/` (ypi-8.2-red.log,
  ypi-8.2-green.log).
- [ ] 8.3 Test first, new `web/src/pages/index/components/PlaylistPicker.test.tsx`: the
  selection scenarios (unavailable and too-long entries greyed with reasons and uncheckable even by
  Select all; From 3 To 6 with position 4 unavailable checks exactly 3, 5, 6; Select none; checked
  count), "Use publish date" checked by default, the truncated notice, controls disabled while
  running, a new listing passed in replaces the rows and resets the selection to its importable
  entries (no position carried over from the previous playlist), and a 5000-entry listing renders
  and Select all completes within the test timeout.
  Then `web/src/pages/index/components/PlaylistPicker.tsx`.
  Evidence: red/green `cd web && npx vitest run src/pages/index/components/PlaylistPicker.test.tsx`
  (ypi-8.3-red.log, ypi-8.3-green.log).
- [ ] 8.4 Test first, `web/src/pages/index/components/BatchImportModal.test.tsx`: control order
  (Import Audio, Import YouTube Playlist, Import Logs, Start Import); the prompt and loading state;
  a `503` and a Mix `400` show the server detail beneath the control with no playlist loaded;
  loading a second link replaces the first playlist's title, rows and selection (and a failed
  second load leaves no playlist loaded); a playlist alone enables Start Import and unchecking all
  disables it; folder, playlist and logs run in that order with lines in that order; closing
  mid-run aborts and a reopen is empty.
  Then `BatchImportModal.tsx`.
  Evidence: red/green `cd web && npx vitest run src/pages/index/components/BatchImportModal.test.tsx`
  (ypi-8.4-red.log, ypi-8.4-green.log).

## V. Verify

- [ ] V.1 `scripts/check-change.sh` green (tests, typecheck, audit, openspec, tests-with-code,
  evidence), and `scripts/check-change.sh --stage hook` before finishing; `openspec validate
  youtube-playlist-import --strict`.
  Evidence: the gate summary lines (ypi-V.1.log).
- [ ] V.2 On the dev stack (`make dev-up`, branch deployed to autologger-dev), as the bootstrap
  owner: load `https://www.youtube.com/playlist?list=PLBB231211A4F62143` (29 entries) in Batch
  Import; a Mix link (`400`) and `list=WL` (private-or-nonexistent `502`) show their details; check positions 1–3 with "Use publish date"
  on into a test show; three sessions are created with the video titles, audio attached and
  `episode_date` set; re-running the same selection skips all three "already in system"; a
  playlist with an unavailable entry (`PLsyOSbh5bs16vubvKePAQ1x3PhKavfBIl`) shows it greyed.
  Delete the test sessions after.
  Evidence: the progress lines and session titles observed (ypi-V.2.log).
- [ ] V.3 Tier 2 consistency read (`consistency-read` skill) over the whole branch against D1–D8
  and the three spec deltas; record it in `panel.md`.
  Evidence: the panel.md section and its findings line.
