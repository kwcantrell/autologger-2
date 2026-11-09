# Import a YouTube playlist from Batch Import

Tier: 2
Tier reason: adds a new HTTP route (`POST /api/youtube/playlist-entries`) to the frozen contract,
adds it to the approved-users run-feature gate, and spawns an external process on untrusted
input; touches `server/src/routers/**` and `packages/contract/**`.

## Why

Shows that publish on YouTube keep their back catalogue in playlists. Today each video has to be
imported one at a time: create a session, paste the link into `youtube-import`, wait, repeat. The
Batch Import modal already does the same job for a folder of local files (create missing sessions
in a show, skip those already in the system, attach one take each). The owner wants the same for a
YouTube playlist.

## Owner decisions (owner, 2026-11-09)

1. **Browser-side loop**, like folder import. One new server route lists a playlist's entries
   (metadata only, no downloads), hardened like the existing `yt-dlp` spawn. The client then, per
   selected video, creates a session in the selected show and calls the existing
   `POST /api/sessions/:id/youtube-import`, unchanged.
2. **Session name** = the video title (sanitized and trimmed, design D6) for both `episode` and
   `title`. Skip semantics are batch import's: a session in the show whose `episode` or `title`
   equals that name is skipped and logged "already in system". Duplicate titles inside one
   playlist carry their video id (`Q&A [dQw4w9WgXcQ]`, design D6).
3. **Publish date**: one checkbox for the whole run, default on, sent as `use_publish_date`.
4. **No size cap on the import.** The listing returns every entry (up to YouTube's own playlist
   limit, design D3) and the user picks which to import with checkboxes and a range.
5. **Accepted URLs**: public or unlisted playlists, as `youtube.com/playlist?list=…` or
   `youtube.com/watch?v=…&list=…` (treated as the playlist). Mix/radio lists (`RD…`) and anything
   that is not a playlist are refused with a clear `400`. Private lists fail with a clear message.
   No cookies.
6. **Show selection**: the modal's existing Show dropdown.
7. **Autogenerate after import** is wanted but depends on the separate `batch-autogenerate` change;
   it is not in this change (Out of scope).

## What changes

- **New route** `POST /api/youtube/playlist-entries` `{url}` → `200 {playlist, entries, truncated}`.
  It validates the body (`422` zod issues, the frozen convention) and the URL (exact YouTube
  hosts, playlist forms only, Mix lists refused with `400`), then runs `yt-dlp` once in flat-playlist mode against a canonical
  `https://www.youtube.com/playlist?list=<id>` with the same lockdown as the existing import spawn
  (discrete argv, `--` terminator, `--ignore-config`, `--no-plugin-dirs`, scrubbed env) and new
  bounds: at most 5000 entries, 16 MiB of output, 60 s wall clock, two listings at once per
  process. Each entry says whether it is importable and, if not, why (unavailable, live, upcoming,
  over 4 hours). Gated like `youtube-import`: the same `503` when no `yt-dlp`, the same approved-user
  `403`. No writes, no downloads.
- **Batch Import modal**: an "Import YouTube Playlist" control asks for the playlist link, loads the
  listing, and shows the entries with checkboxes, select all/none, a from–to range, and a "Use
  publish date" checkbox (default on). Unimportable entries are shown, greyed, with their reason,
  and cannot be checked. Start Import runs the folder import (if any), then the playlist, then the
  log import (if any), in that order, with one progress region.
- **Playlist runner** (browser): per selected entry, in playlist order: skip if a session of the
  show already has that name; otherwise create the session and call `youtube-import` with the
  entry's `https://www.youtube.com/watch?v=<id>` URL. A per-video failure is logged and the loop
  continues; a definite failure rolls the created session back (as folder import does). When the
  outcome is unknown (a proxy timeout), the runner waits, polling the session's segments for up to
  32 minutes, before starting the next video, so one run never stacks server downloads. Sessions it
  created and that are still empty are retried into on the next run, not skipped. The skip check
  reads a fresh session list for the run's show before each entry. Closing the modal aborts the
  run and keeps the in-flight session for the next run.
- **Docs**: README endpoint table row, the "Run features" route list, the `RUN_FEATURE_EMAILS`
  settings row, and the "YouTube audio import" section.
- **API-response conformance** for every new web call site (client types in `web/src/api/types.ts`,
  a captured fixture, verdicts).

## Contract impact

Observable additions only: one new route (statuses `200`, `400`, `401`, `403`, `422`, `502`,
`503`),
and the run-feature gate grows from six routes to seven. `POST /api/sessions/:id/youtube-import`,
`POST /api/sessions` and every other route are unchanged. No WebSocket change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `api-contract-freeze`: ADDED "YouTube playlist listing endpoint"; MODIFIED "Run features are
  limited to approved users" (seventh route).
- `youtube-audio-import`: ADDED "Playlist listing is gated, validated and bounded" and "Playlist
  entries report whether they can be imported".
- `batch-audio-import`: MODIFIED "Batch Import modal layout and actions" (the playlist control and
  the run order); ADDED "YouTube playlist selection", "YouTube playlist session naming" and
  "YouTube playlist import run".

## Non-goals

- No server-side playlist job, queue or polling surface; the browser drives the loop.
- No change to `youtube-import` itself (bounds, statuses, anchoring, single-flight).
- No cookies, sign-in, or private playlists; no Mix/radio lists; no channel URLs (`/@name`,
  `/channel/…`) and no `youtu.be` links.
- No re-sync of a playlist later (new videos are picked up only by running the import again; the
  skip rule makes that safe).
- No "autogenerate after import" checkbox (follow-up below).

## Out of scope / follow-up

- **Autogenerate after import**: a run-wide checkbox that generates transcript and events for each
  imported session. Depends on `batch-autogenerate` (proposed separately, worktree
  `autologger-2-batch-autogenerate`); add it to the playlist run in a follow-up once that change is
  approved.

## Impact

- Server: `server/src/routers/youtubePlaylist.ts` (new), `server/src/app.ts` (mount),
  `packages/media-import/src/{ytdlpPlaylist,playlistEntries,playlistListingGuard}.ts` (new),
  `packages/media-import/src/ytdlp.ts` (stdout/stderr bounds on the shared spawn helper), `packages/contract/src/schemas.ts`
  (body schema, playlist URL validator, response types).
- Web: `web/src/api/types.ts` (response types), `web/src/pages/index/components/BatchImportModal.tsx`, new
  `web/src/pages/index/components/PlaylistPicker.tsx`, new
  `web/src/pages/index/batchImport/playlistRunner.ts` and `playlistNames.ts`, small exports from
  `batchImport/runner.ts`.
- Docs: README.
- No migration, no new setting, no new dependency (uses the `yt-dlp` already in the image).
