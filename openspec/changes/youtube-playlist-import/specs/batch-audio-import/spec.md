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
does not depend on the selection:

1. Normalize the title to Unicode NFC; replace every control character
   (U+0000–U+001F, U+007F–U+009F) and U+2028/U+2029 with a space; collapse each run
   of whitespace to one space; trim.
2. If the result is empty, use `YouTube <video_id>`.
3. Shorten it to at most 80 characters (Unicode code points; the session `episode`
   limit), then trim trailing whitespace.
4. Walking entries in playlist order, the first entry with a given name keeps it; each
   later entry with the same name gets ` (k)` appended, with the smallest `k ≥ 2` not
   already assigned, shortening the base (then trimming it) so the whole name stays
   within 80 characters.

Names SHALL be compared exactly (case-sensitive), as folder import compares stems.

#### Scenario: Control characters and spacing are cleaned

- **WHEN** an entry's title is `"  Episode 12:\n  The\tReturn  "`
- **THEN** its session name is `Episode 12: The Return`

#### Scenario: Long titles fit the episode limit

- **WHEN** an entry's title is 120 characters long
- **THEN** its session name is its first 80 characters with trailing spaces trimmed

#### Scenario: Duplicate titles in one playlist get numbered

- **WHEN** positions 2, 5 and 9 all have the title `Q&A`
- **THEN** their session names are `Q&A`, `Q&A (2)` and `Q&A (3)` respectively, whichever
  of them are checked

### Requirement: YouTube playlist import run

The playlist part of Start Import SHALL run against the selected show (switching the
profile's active show first, as folder import does) and SHALL process the checked
entries one at a time in playlist order:

- If any session of that show has `episode` or `title` equal to the entry's name, the
  entry SHALL be skipped with the progress line `Skipped <name> (already in system)`.
- Otherwise the client SHALL create a session with `episode` and `title` set to the
  name (frame rate and offset from the profile's new-session defaults), then call
  `POST /api/sessions/:id/youtube-import` with the entry's `url` and the run's
  `use_publish_date`. Success SHALL log `Completed <name>`. The run SHALL NOT navigate
  to any session.
- A failure SHALL log `Failed <name>: <detail>` and the run SHALL continue with the next
  entry. When the server answered with a JSON `{detail}` (a definite failure) the
  created session SHALL be deleted, so a re-run retries the entry. When there was no
  such answer (a network error or a proxy timeout, where the server may still finish),
  the session SHALL be kept and the line SHALL say the import may still finish and to
  check the session.
- A `401`, `403` or `503` from `youtube-import` SHALL end the playlist part after that
  entry's line, with one more line saying how many checked entries were not attempted,
  since every later entry would fail the same way.

While it runs, the progress region SHALL show `Importing <name> (video i of n)...` with
the percent of entries finished. Closing the modal SHALL abort the run: no further
entry starts, a session created for the in-flight entry SHALL be deleted best-effort,
and sessions already completed SHALL remain.

#### Scenario: An existing episode is skipped

- **WHEN** the show already has a session titled `Episode 12: The Return` and that entry
  is checked
- **THEN** no session is created for it and the progress lists
  `Skipped Episode 12: The Return (already in system)`

#### Scenario: One failing video does not stop the run

- **WHEN** three entries are checked and the second one's `youtube-import` answers
  `502 {"detail":"Failed to download audio."}`
- **THEN** the first and third entries are completed, the second's created session is
  deleted, and the progress lists `Failed <name>: Failed to download audio.` for it

#### Scenario: Publish date follows the run checkbox

- **WHEN** the user unchecks "Use publish date" and starts the run
- **THEN** every `youtube-import` request of the run carries `use_publish_date: false`

#### Scenario: A gateway timeout keeps the session

- **WHEN** an entry's `youtube-import` request ends with a non-JSON `524` from a proxy
- **THEN** the session created for it is kept, its line says the import may still finish,
  and the run continues

#### Scenario: Closing mid-run keeps completed sessions

- **WHEN** the user closes the modal while the third of five checked entries is importing
- **THEN** the first two sessions remain with their audio, the third entry's session is
  deleted best-effort, and entries four and five are not started

#### Scenario: Losing approval stops the playlist part

- **WHEN** the second of five entries' `youtube-import` answers `403`
- **THEN** the progress lists that entry's failure and a line that 3 checked videos were not
  attempted, and no further `youtube-import` request is sent
