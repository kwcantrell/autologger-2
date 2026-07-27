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
Files SHALL be grouped by base name: strip the extension, then strip a trailing
`-<digits>` suffix when present. Groups with multiple members SHALL be ordered by
that numeric suffix ascending.

#### Scenario: Multi-segment group

- **WHEN** the folder contains `YMH_001-1.mp3` and `YMH_001-2.mp3`
- **THEN** they form one group whose base name is `YMH_001` with segment order 1 then 2

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

For a multi-file group, the client SHALL concatenate the parts (decode in order,
concatenate PCM, encode WAV) into one audio blob before upload. Single-file groups
MAY upload the original bytes when the Content-Type is accepted, or decode→WAV when
needed. The client SHALL then call local-audio-import with that one blob and a
positive `duration_s`. The server SHALL attach one audio segment and anchor it as
one imported recording take (Recording N Started / transport advance / Recording N
Stopped) using the same composite pattern as the existing YouTube import route's
internal anchor — without performing any YouTube or network media fetch.

#### Scenario: Two parts become one take

- **WHEN** group `YMH_001` has parts `-1` and `-2` and no matching session exists
  and the browser can decode both files
- **THEN** one session `YMH_001` exists afterward with one anchored imported take
  spanning the concatenated audio

#### Scenario: Decode failure is per-group

- **WHEN** a group's file cannot be decoded in the browser
- **THEN** that group's progress line reports failure and other groups continue

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
hours), stores one audio segment, anchors the imported take, and returns
`200 { ok: true }` on success. Failure modes SHALL use JSON `{ detail }`
with appropriate status codes and SHALL roll back segment metadata on put/anchor
failure. Oversized bodies SHALL be rejected with `413 { detail }` per the
existing audio upload cap.

#### Scenario: Happy path single blob

- **WHEN** a valid session receives one audio body with a valid `duration_s` and the
  put succeeds
- **THEN** the response is `200 { ok: true }` and the session has one new anchored
  take
