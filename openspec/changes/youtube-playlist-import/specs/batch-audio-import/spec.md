# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
