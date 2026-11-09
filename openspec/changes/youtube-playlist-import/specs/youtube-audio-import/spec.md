# Spec Delta

## ADDED Requirements

### Requirement: Playlist listing is gated, validated and bounded

The server SHALL offer a metadata-only listing of a YouTube playlist's entries
(`POST /api/youtube/playlist-entries`, api-contract-freeze "YouTube playlist listing endpoint")
behind the same gate as `youtube-import`: the startup-resolved `yt-dlp` binary, with the same
unavailable `503` when there is none, and the approved-user `403`. The URL SHALL be validated
before any subprocess or outbound request, accepting only the playlist forms the contract lists,
and the subprocess SHALL be given a canonical `https://www.youtube.com/playlist?list=<id>` built
from the validated list id, never the caller's raw string.

The listing subprocess SHALL carry the same hardening as the import's: a discrete argument array
(never a shell string), a `--` terminator before the URL, configuration and plugin loading
disabled, and the same minimal, scrubbed child environment. It SHALL run in flat-playlist mode, so
no video page is fetched and no media is downloaded, and SHALL run in a per-request temporary
directory outside the audio blob prefix, removed on every exit path and covered by the startup
sweep of orphaned import directories.

It SHALL be bounded on four axes, any breach ending the request with its `502` and killing the
subprocess's whole process group:

1. **Entries**: at most 5000 entries are requested from YouTube (its own playlist limit); a longer
   list (a large channel's uploads) is returned truncated, with `truncated: true`.
2. **Output**: at most 16 MiB of standard output is read; more kills the subprocess. Standard error
   is read up to 64 KiB, used only to tell a private-or-nonexistent playlist from other failures,
   and never echoed.
3. **Time**: 60 seconds of wall clock.
4. **Concurrency**: at most two listings run at once in a server process; a third is refused with
   the busy `503` before spawning.

#### Scenario: The listing spawn is locked down like the import spawn

- **WHEN** a valid listing request is served
- **THEN** `yt-dlp` is spawned once with discrete arguments including `--ignore-config`,
  `--no-plugin-dirs`, flat-playlist mode, a 5000-entry end bound and `--` followed by
  `https://www.youtube.com/playlist?list=<id>`, with a child environment that holds no server
  secret

#### Scenario: Oversized output is cut off

- **WHEN** the subprocess writes more than 16 MiB to standard output
- **THEN** its process group is killed and the response is `502 {"detail":"Failed to list the playlist."}`

#### Scenario: A hung listing is cut off

- **WHEN** the subprocess runs longer than 60 seconds
- **THEN** its process group is killed and the response is `502 {"detail":"Listing the playlist timed out."}`

#### Scenario: The temp directory is removed

- **WHEN** a listing finishes on any path
- **THEN** its per-request temporary directory no longer exists

#### Scenario: A long uploads list is truncated, not refused

- **WHEN** the playlist reports 7000 entries
- **THEN** the response is `200` with the first 5000 entries and `truncated: true`

### Requirement: Playlist entries report whether they can be imported

Each listed entry SHALL carry `importable` and `reason` so a client can avoid sending
`youtube-import` requests that are certain to fail: an entry with no reported title (a deleted or
private video) is `unavailable`, a live stream in progress is `live`, a scheduled premiere or
stream is `upcoming`, and a reported duration of 14,400 seconds or more (which the import's
download filter `duration < 14400` refuses) is `too_long`. An
entry whose problem cannot be seen in flat-playlist metadata (such as an age-restricted or
members-only video) SHALL be listed as importable; its `youtube-import` then fails through that
route's existing `502`.

#### Scenario: A deleted video is not importable

- **WHEN** the listing contains an entry whose title YouTube does not report
- **THEN** that entry has `title` `null`, `importable` `false` and `reason` `unavailable`

#### Scenario: A finished live stream is importable

- **WHEN** the listing contains a past live stream with a known duration under 4 hours
- **THEN** that entry is `importable` with `reason` `null`

#### Scenario: Exactly four hours is not importable

- **WHEN** the listing contains an entry whose duration is exactly 14,400 seconds
- **THEN** that entry has `importable` `false` and `reason` `too_long`
