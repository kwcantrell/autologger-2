# batch-audio-import Specification

## Purpose

Home-rail Batch Import: show-scoped local-folder audio ingest that creates missing
sessions, stitches multi-segment clips in the browser, attaches one timeline take
per group, and reports progress without navigating session workspaces.

## Requirements

### Requirement: Rail Batch Import control

The left rail SHALL expose a Batch Import control immediately under New Session when the active
team has at least one show the user can access (web-home-launch "Session actions follow show
access"); otherwise neither control is shown. The
control's icon SHALL be an up-arrow (upload) affordance. Activating it SHALL open the
Batch Import modal.

#### Scenario: Opens modal from rail

- **WHEN** the user activates Batch Import on the rail
- **THEN** the Batch Import dialog is shown

#### Scenario: Hidden without an accessible show
- **WHEN** a member whose active team has no show they can access views the rail
- **THEN** no Batch Import control is shown

### Requirement: Batch Import modal layout and actions

The Batch Import modal SHALL include, in order: a Show dropdown equivalent to New
Session's show picker; an Import Audio control; an Import YouTube Playlist control
with its playlist picker beneath it ("YouTube playlist selection"); an Import Logs
control; a Start Import control; and a progress region beneath Start Import. Import
Logs SHALL collect the public Google Sheets URL for the log import specified by
sheets-log-import (through a themed text prompt); the import itself SHALL run
only on Start Import. Import Logs SHALL NOT open a directory picker, import
audio, or create sessions. Start Import SHALL be enabled when a show is selected,
no run is in progress, and at least one of these is ready: a chosen folder, a loaded
playlist with at least one checked entry, or a logs URL. Start Import SHALL run the
ready parts in this order: the folder import, then the playlist import, then the log
import, so that logs can match sessions the audio parts created. All parts SHALL
report into the one progress region, each part's lines following the previous
part's.

#### Scenario: Import Logs collects the Sheets URL for the log import

- **WHEN** the user activates Import Logs
- **THEN** a themed prompt asks for the public Google Sheets URL, no directory picker
  opens, and nothing is imported or created until the user activates Start Import

#### Scenario: A playlist alone enables Start Import

- **WHEN** no folder and no logs URL are chosen, and a loaded playlist has two entries checked
- **THEN** Start Import is enabled, and it is disabled again when the user unchecks both

#### Scenario: Parts run folder, playlist, logs

- **WHEN** the user has chosen a folder, a playlist selection and a logs URL, and activates
  Start Import
- **THEN** the folder groups are processed first, then the playlist entries, then the log
  import, and the progress region keeps every part's lines in that order

### Requirement: Folder selection for Import Audio

Import Audio SHALL open a directory file picker. After the user confirms a folder,
the modal SHALL display the selected folder's name beneath the Import Audio
control. Closing and reopening the modal SHALL clear the selection.

#### Scenario: Folder label appears after pick

- **WHEN** the user chooses a folder via Import Audio
- **THEN** a non-empty folder name is shown under Import Audio

### Requirement: Audio file discovery and grouping

Start Import SHALL consider only audio files with supported extensions
(`.mp3`, `.wav`, `.aiff`, `.aif`, `.m4a`, `.mp4`, `.ogg`, `.webm`, `.flac`,
case-insensitive).
The stem is the file name minus its audio extension. Files SHALL group only
within the same relative directory (the folder picker's `webkitRelativePath`
parent); same-named files in different subfolders never merge. Stems ending in
`-<digits>` are segment *candidates*: candidates sharing a directory and base
(stem minus the suffix) SHALL merge into one multi-segment group, ordered by
numeric suffix ascending, only when their suffixes form a contiguous run
starting at 1 (`-1`, or `-1`/`-2`, …). Otherwise each candidate SHALL stand
alone as a single-file group keyed by its full stem including the suffix.
Stems without a suffix are always their own single-file group.

#### Scenario: Multi-segment group

- **WHEN** the folder contains `YMH_001-1.mp3` and `YMH_001-2.mp3`
- **THEN** they form one group whose base name is `YMH_001` with segment order 1 then 2

#### Scenario: Non-contiguous suffixes stay separate recordings

- **WHEN** the folder contains `2026-08-03.mp3` and `2026-08-04.mp3`
- **THEN** each is its own single-file group keyed by its full stem (no merged
  `2026-08` group)

#### Scenario: Non-audio ignored

- **WHEN** the folder also contains `notes.txt`
- **THEN** `notes.txt` is not imported and does not form a group

#### Scenario: FLAC files are imported

- **WHEN** the folder contains `YMH_002.flac`
- **THEN** it forms the group `YMH_002`, and a single-file upload is stored as `audio/flac`

### Requirement: Show-scoped match, create, and skip

Import SHALL run against the Show selected in the dropdown. When that show is not
the profile active show, Start Import SHALL switch the active show via the existing
profile update path before matching. For each group base name, if any session of
that show has `episode` or `title` equal to the base name, the group SHALL be
skipped and the progress log SHALL record a skipped line naming the base name and
that it is already in the system. Otherwise the system SHALL create a session with
`episode` and `title` set to the base name (frame rate / offset from profile
new-session defaults) and then import audio into that new session. Import SHALL NOT
navigate the app to the created session.

#### Scenario: Existing session skipped

- **WHEN** a session with episode `YMH_001` already exists for the selected show and
  the folder has `YMH_001.mp3`
- **THEN** no new session is created for that group and progress records a skip

#### Scenario: Missing session created

- **WHEN** no session matches base name `YMH_001` and the folder has `YMH_001.mp3`
- **THEN** a session is created with episode and title `YMH_001` and audio is
  attached without navigating to it

### Requirement: Client stitch and single-take attach

For a multi-file group, the client SHALL first check the group's summed
compressed input size against a 150 MB pre-flight cap
(`MAX_STITCH_INPUT_BYTES`): groups over the cap SHALL fail with a per-group
progress line (naming the group's size and the limit, and suggesting importing
the files individually) without crashing the run or affecting other groups.
Under the cap, the client SHALL concatenate the parts (decode in order,
concatenate PCM — mono sources up-mix to the widest channel count — encode WAV)
into one audio blob before upload. Single-file groups SHALL upload the original
bytes unchanged (pass-through, no PCM/WAV expansion), reading duration from
media-element metadata; when the browser leaves the file's MIME type empty, the
client SHALL infer the Content-Type from the file extension. The client SHALL
then attach that one blob with a positive `duration_s` and an `X-Audio-Seam-Parts`
header carrying the ordered per-part durations: through local-audio-import when the
blob is at most the parts threshold (design D12, 40 MiB), and through the resumable
parts upload ("Large imports upload in parts") when it is larger. The server
SHALL attach one audio segment and anchor it as one imported recording take
(Recording N Started / transport advance / Recording N Stopped) using the same
composite pattern as the existing YouTube import route's internal anchor —
without performing any YouTube or network media fetch. Server-side transcript
generation passes MP3 segments through unmerged (the audioMerge `mp3` codec
family streams source bytes as-is), so all-MP3 imported sessions remain
transcribable via `POST …/transcript-words/generate`.

#### Scenario: Two parts become one take

- **WHEN** group `YMH_001` has parts `-1` and `-2` and no matching session exists
  and the browser can decode both files
- **THEN** one session `YMH_001` exists afterward with one anchored imported take
  spanning the concatenated audio

#### Scenario: Decode failure is per-group

- **WHEN** a group's file cannot be decoded in the browser
- **THEN** that group's progress line reports failure and other groups continue

#### Scenario: Oversized multi-file group fails per-group

- **WHEN** a multi-file group's summed compressed input size exceeds 150 MB
- **THEN** that group's progress line reports the size failure and other groups
  continue; no browser decode is attempted for the oversized group

#### Scenario: A large blob takes the parts path
- **WHEN** a single-file group's file is 300 MB, or a stitched WAV comes out at 120 MB
- **THEN** the client uploads it through the parts upload with the same `duration_s` and
  seam parts, never through local-audio-import, and the result is one anchored take as
  before

### Requirement: Progress reporting

While Start Import runs, the progress region SHALL show current work (including a
clip index and percent) and a growing list of per-group lines for completed,
skipped, uploading/in-progress, and failed groups. When the run finishes, the
progress information SHALL remain visible until the modal is closed. Closing the
modal during a run SHALL reset modal UI state, abort further groups, and leave
already-completed sessions and attaches intact.

#### Scenario: Progress survives completion

- **WHEN** all groups have finished processing
- **THEN** the progress lines remain visible until the user closes the modal

#### Scenario: Close mid-run keeps completed work

- **WHEN** the user closes the modal after some groups completed and others have not
  started
- **THEN** completed sessions remain in the system and a subsequent open shows a
  fresh modal without the prior progress lines

### Requirement: Local audio import HTTP surface

The server SHALL expose `POST /api/sessions/:sessionId/local-audio-import` that
accepts one audio body (raw bytes with a non-empty Content-Type), requires a
positive finite `duration_s` query parameter not exceeding 86_400 seconds (24
hours), accepts an optional `X-Audio-Seam-Parts` request header (JSON array of
`{ duration_s }` objects — each positive finite, sum within 0.5 s of
`duration_s`; malformed or sum-mismatched values are `400 { detail }`; absent
or blank means one default part equal to `duration_s`), stores one audio
segment, anchors the imported take, persists the seam parts by APPENDING them
to any parts stored by earlier imports (the meta records the session's full
audio timeline across takes, in take order), and returns `200 { ok: true }` on
success. Requests while the session is actively recording SHALL be rejected
`409 { detail }` — checked before attach and re-checked after the blob put
(the re-check rolls back the attempt). Failure modes SHALL use JSON
`{ detail }` with appropriate status codes; rollback on put failure removes
the segment metadata row, and rollback after a successful put (late rolling
re-check or anchor failure) removes BOTH the metadata row and the stored blob
bytes (row first and transactionally; the blob delete is best-effort so
rollback never masks the original failure). Oversized bodies SHALL be rejected with `413 { detail }` per the
dedicated local-audio-import byte cap (`MAX_LOCAL_AUDIO_IMPORT_BYTES`,
1500 MiB — higher than the 50 MB live recorder segment cap), enforced on the
declared Content-Length, mid-stream during the counted body read (so chunked
bodies and lying Content-Lengths abort with the same 413 without buffering
past the cap), and as a post-read backstop.

#### Scenario: Happy path single blob

- **WHEN** a valid session receives one audio body with a valid `duration_s` and the
  put succeeds
- **THEN** the response is `200 { ok: true }` and the session has one new anchored
  take

#### Scenario: Repeated imports extend the seam timeline

- **WHEN** a session that already holds seam parts from a prior import receives
  a second import carrying `X-Audio-Seam-Parts`
- **THEN** the new parts are appended after the stored ones, never replacing them

#### Scenario: Import refused while recording

- **WHEN** the session is actively recording when the import arrives (or starts
  recording between the blob put and the anchor)
- **THEN** the response is `409 { detail }` and no anchored take or segment row
  from the attempt remains; the stored blob is deleted best-effort (a failed
  delete leaves only an orphan file, never a dangling metadata row)

### Requirement: Large imports upload in parts

For a blob over the parts threshold the client SHALL create an upload
(`POST …/audio/uploads` with the blob's content type, size and the sha256 of each part,
each computed with WebCrypto over that part's bytes alone, never over the whole file at
once), send each part with `PUT …/parts/:n` at the server's `part_size` and in order, one
part in flight, and then call `POST …/complete` with the group's `duration_s` and seam
parts. A failed part SHALL be retried with the chunk upload's backoff; before a retry the
client SHALL read the upload's status and skip parts already received. The `upload_id`
SHALL be remembered in IndexedDB (shared by every tab of the origin) keyed by the file
group's identity (its ordered file names, sizes and last-modified times) for 24 hours, so a
re-run of the import resumes an interrupted upload instead of starting over. Progress
reporting SHALL show per-part progress for such a group. A completed import's segment is
processed by the server like any other new segment (duration, peaks, WAV→FLAC).

#### Scenario: An interrupted large import resumes
- **WHEN** a 400 MB import is interrupted after 7 of 13 parts and the user re-runs the
  import of the same folder within 24 hours
- **THEN** the client finds the remembered upload, sends only parts 8 to 13 and completes,
  producing one anchored take

#### Scenario: Parts never exceed the live cap
- **WHEN** any part is sent
- **THEN** its body is at most the server's `part_size` (32 MiB), below the 50 MB live
  segment cap and the deployment's 100 MB request body limit

#### Scenario: A resume from another tab finds the upload
- **WHEN** the import was started in one tab and re-run in a new tab within 24 hours
- **THEN** the new tab finds the remembered upload by the group's identity and resumes it

#### Scenario: Hashing never holds the whole file
- **WHEN** a 1.4 GB file is prepared for upload
- **THEN** each 32 MiB part is hashed from its own slice and the page never allocates the
  whole file as one buffer

### Requirement: YouTube playlist selection

Import YouTube Playlist SHALL ask for a playlist link through a themed text prompt and,
on submit, load the playlist with the playlist listing endpoint
(api-contract-freeze "YouTube playlist listing endpoint"), showing a loading state
meanwhile. A refused or failed listing SHALL show the server's `detail` beneath the
control, including the `503` unavailable detail on a deployment without `yt-dlp`, and
SHALL leave no playlist loaded. A loaded playlist SHALL show its title, its entry
count, and every entry in playlist order with its position, its title (or
"Unavailable video" when none) and its duration. Importable entries SHALL be checked
by default. Entries that are not importable SHALL be shown greyed with their reason
("unavailable", "live now", "upcoming", "over 4 hours") and SHALL NOT be checkable.
The picker SHALL offer Select all and Select none (over importable entries), a
From/To range by position that checks exactly the importable entries in that
inclusive range and unchecks the rest, a count of checked entries, and a "Use
publish date" checkbox for the whole run, checked by default. When the listing is
`truncated`, the picker SHALL say that only the first 5000 videos are shown. Loading
another link SHALL replace the loaded playlist and its selection. Closing and
reopening the modal SHALL clear it. The picker's controls SHALL be disabled while a
run is in progress.

#### Scenario: Unavailable entries are visible but cannot be selected

- **WHEN** a loaded playlist has 10 entries of which position 4 is `unavailable` and
  position 7 is `too_long`
- **THEN** all 10 are shown, 8 are checked, and positions 4 and 7 are greyed with their
  reasons and cannot be checked, even by Select all

#### Scenario: A range selects only that range

- **WHEN** the user sets From 3 and To 6 and applies the range on a 10-entry playlist
  where position 4 is unavailable
- **THEN** exactly positions 3, 5 and 6 are checked

#### Scenario: Unconfigured deployment explains itself

- **WHEN** the user submits a playlist link on a deployment without `yt-dlp`
- **THEN** the modal shows "YouTube import is unavailable on this deployment." beneath
  the control and no playlist is loaded

#### Scenario: A Mix link is explained

- **WHEN** the user submits a link whose list id begins `RD`
- **THEN** the modal shows the server's Mix detail and no playlist is loaded

### Requirement: YouTube playlist session naming

Each playlist entry with a title SHALL get one session name, used as both `episode`
and `title`, computed over the whole loaded listing (checked or not) so that a name
does not depend on the selection or on the entries' positions. Lengths are counted in
UTF-16 code units; a name of at most 80 units never exceeds the session create schema's
80-character `episode` limit, however that limit counts:

1. Normalize the title to Unicode NFC; replace every control character
   (U+0000–U+001F, U+007F–U+009F) and U+2028/U+2029 with a space; collapse each run
   of whitespace to one space; trim. The result is the entry's *base*.
2. If the base is empty, the name is `YouTube <video_id>`.
3. Otherwise cut the base to at most 80 UTF-16 code units, never splitting a surrogate
   pair (a pair that would straddle the limit is dropped whole), then trim trailing
   whitespace. This is the *plain name*.
4. When two or more titled entries of the listing share a plain name, every one of
   them SHALL be named `<base cut to 66 units, never splitting a pair, trimmed> [<video_id>]`
   (14 units of suffix, so the whole name stays within 80); a plain name shared by no
   other entry is the name as is.

Names SHALL be compared exactly (case-sensitive), as folder import compares stems.

#### Scenario: Control characters and spacing are cleaned

- **WHEN** an entry's title is `"  Episode 12:\n  The\tReturn  "`
- **THEN** its session name is `Episode 12: The Return`

#### Scenario: Long titles fit the episode limit

- **WHEN** an entry's title is 120 ASCII characters long
- **THEN** its session name is its first 80 characters with trailing spaces trimmed

#### Scenario: Emoji titles fit the episode limit in UTF-16 units

- **WHEN** an entry's title is 80 emoji such as `😀` (160 UTF-16 code units)
- **THEN** its session name is 40 of those emoji (80 units), no half pair is left, and
  creating the session with that `episode` and `title` succeeds

#### Scenario: Duplicate titles in one playlist carry their video ids

- **WHEN** positions 2, 5 and 9 all have the title `Q&A`, with video ids `aaaaaaaaaaa`,
  `bbbbbbbbbbb` and `ccccccccccc`
- **THEN** their session names are `Q&A [aaaaaaaaaaa]`, `Q&A [bbbbbbbbbbb]` and
  `Q&A [ccccccccccc]`, whichever of them are checked and in whatever order the playlist
  lists them

### Requirement: YouTube playlist import run

The playlist part of Start Import SHALL run against the selected show (switching the
profile's active show first, as folder import does) and SHALL process the checked
entries one at a time in playlist order. No entry SHALL start while the previous
entry's import may still be running on the server.

For each entry:

- **Fresh session list.** Immediately before deciding to skip or create, the client
  SHALL read the profile; if its active show is no longer the run's show it SHALL
  switch it back (one progress line saying so), then SHALL read the session list and
  consider only sessions whose `show_id` is the run's show.
- **Skip.** If such a session has `episode` or `title` equal to the entry's name, the
  entry SHALL be skipped with the progress line `Skipped <name> (already in system)`,
  unless it is this import's own unfinished session (next item).
- **Retry into an unfinished session.** When the matching session is the one this
  import created for the same show and video id (remembered in the browser for 30
  days, like folder import's created sessions) and it has no audio segments, the
  client SHALL import into it instead of skipping. If that import answers `409`
  (an import for that session is still running on the server), the line SHALL be
  `Still importing <name> on the server; run the import again later to check it` and
  the run SHALL move on.
- **Create and import.** Otherwise the client SHALL create a session with `episode`
  and `title` set to the name (frame rate and offset from the profile's new-session
  defaults), remember it, then call `POST /api/sessions/:id/youtube-import` with the
  entry's `url` and the run's `use_publish_date`. Success SHALL log
  `Completed <name>` and forget the remembered session. The run SHALL NOT navigate to
  any session.
- **Definite failure.** When the import answers with a JSON `{detail}`, the client
  SHALL delete the session it created for the entry (and forget it), log
  `Failed <name>: <detail>`, and continue with the next entry. A `401`, `403` or `503`
  SHALL instead end the playlist part after that entry's line, with one more line
  saying how many checked entries were not attempted, since every later entry would
  fail the same way.
- **Create failure.** A failed create SHALL log `Failed <name>: <detail>`, where a
  `detail` that is an array of validation issues is rendered as each issue's `path`
  (joined with `.`) and `message`, as `<path>: <message>`, joined with `; `; and the run
  SHALL continue.
- **Unknown outcome.** When the import ends with no JSON answer (a network error or a
  proxy timeout such as Cloudflare's `524`), the server may still be downloading. The
  client SHALL keep the session and SHALL NOT start the next entry until the outcome is
  known: it SHALL read the session's audio segments every 15 seconds for at most 32
  minutes (the import's two 15-minute subprocess bounds plus margin), showing
  `Waiting for the server to finish <name>...`. A segment appearing SHALL count as
  `Completed <name>`. If none appears in that time, the line SHALL be
  `Failed <name>: the server did not confirm the import; run the import again to retry`
  (the next run retries into the session, as above), and the run SHALL continue.

While it runs, the progress region SHALL show `Importing <name> (video i of n)...` with
the percent of entries finished. Closing the modal SHALL abort the run: no further
entry starts, the waiting stops, and a session whose import was in flight SHALL be
kept and remembered (the server keeps working on it; a later run completes, skips or
retries it by the rules above). Sessions already completed SHALL remain.

#### Scenario: An existing episode is skipped

- **WHEN** the run's show already has a session titled `Episode 12: The Return` that
  this import did not create, and that entry is checked
- **THEN** no session is created for it and the progress lists
  `Skipped Episode 12: The Return (already in system)`

#### Scenario: A same-named session in another show does not cause a skip

- **WHEN** the active show was switched to another show in another tab mid-run, and
  that other show has a session named like the next entry
- **THEN** the client switches the active show back, the entry is not skipped, and its
  session is created in the run's show

#### Scenario: One failing video does not stop the run

- **WHEN** three entries are checked and the second one's `youtube-import` answers
  `502 {"detail":"Failed to download audio."}`
- **THEN** the first and third entries are completed, the second's created session is
  deleted, and the progress lists `Failed <name>: Failed to download audio.` for it

#### Scenario: Publish date follows the run checkbox

- **WHEN** the user unchecks "Use publish date" and starts the run
- **THEN** every `youtube-import` request of the run carries `use_publish_date: false`

#### Scenario: A gateway timeout waits before the next video

- **WHEN** an entry's `youtube-import` request ends with a non-JSON `524` from a proxy and
  the server attaches the audio four minutes later
- **THEN** the session is kept, no request for the next entry is sent until the segment
  is seen, and the entry is logged `Completed <name>`

#### Scenario: An unconfirmed import is retried on the next run

- **WHEN** an earlier run left this import's session for an entry with no audio segments,
  and the user runs the import again with that entry checked
- **THEN** the client imports into that session instead of skipping it or creating
  another

#### Scenario: A still-running import is not duplicated

- **WHEN** a re-run reaches this import's empty session for an entry and its
  `youtube-import` answers `409`
- **THEN** no session is created, the line says the import is still running on the
  server, and the run moves on

#### Scenario: A validation refusal on create is readable

- **WHEN** creating an entry's session answers `422` with one issue at path `["episode"]`
  and message `Too big`
- **THEN** the progress lists `Failed <name>: episode: Too big`

#### Scenario: Closing mid-run keeps completed and in-flight sessions

- **WHEN** the user closes the modal while the third of five checked entries is importing
- **THEN** the first two sessions remain with their audio, the third entry's session is
  kept and remembered, and entries four and five are not started

#### Scenario: Losing approval stops the playlist part

- **WHEN** the second of five entries' `youtube-import` answers `403`
- **THEN** the progress lists that entry's failure and a line that 3 checked videos were not
  attempted, and no further `youtube-import` request is sent
