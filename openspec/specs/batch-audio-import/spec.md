# batch-audio-import Specification

## Purpose

Home-rail Batch Import: show-scoped local-folder audio ingest that creates missing
sessions, stitches multi-segment clips in the browser, attaches one timeline take
per group, and reports progress without navigating session workspaces.

## Requirements

### Requirement: Rail Batch Import control

The left rail SHALL expose a Batch Import control immediately under New Session. The
control's icon SHALL be an up-arrow (upload) affordance. Activating it SHALL open the
Batch Import modal.

#### Scenario: Opens modal from rail

- **WHEN** the user activates Batch Import on the rail
- **THEN** the Batch Import dialog is shown

### Requirement: Batch Import modal chrome and actions

The Batch Import modal SHALL include, in order: a Show dropdown equivalent to New
Session's show picker; an Import Audio control; an Import Logs control; a Start
Import control; and a progress region beneath Start Import. Import Logs SHALL not
perform any import action in this change.

#### Scenario: Import Logs is a no-op

- **WHEN** the user activates Import Logs
- **THEN** no session is created, no file picker opens, and no import starts

### Requirement: Folder selection for Import Audio

Import Audio SHALL open a directory file picker. After the user confirms a folder,
the modal SHALL display the selected folder's name beneath the Import Audio
control. Closing and reopening the modal SHALL clear the selection.

#### Scenario: Folder label appears after pick

- **WHEN** the user chooses a folder via Import Audio
- **THEN** a non-empty folder name is shown under Import Audio

### Requirement: Audio file discovery and grouping

Start Import SHALL consider only audio files with supported extensions
(`.mp3`, `.wav`, `.aiff`, `.aif`, `.m4a`, `.mp4`, `.ogg`, `.webm`, case-insensitive).
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
then call local-audio-import with that one blob, a positive `duration_s`, and an
`X-Audio-Seam-Parts` header carrying the ordered per-part durations. The server
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
