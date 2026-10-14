# legacy-data-import Specification

## Purpose
Moves one team's data from a pre-Supabase legacy `DATA_DIR` (SQLite catalog, per-session databases and audio blobs) into the Postgres catalog: one transaction that refuses rather than guesses, rows that look as if the app wrote them, a parity check that proves the copy, and optional lossless FLAC storage for PCM WAV blobs.

## Requirements

### Requirement: One team's legacy data is imported by one transaction
The legacy import tool SHALL read a legacy `DATA_DIR` read-only and emit, for one team, one SQL
transaction for `psql` as `postgres`. The transaction SHALL insert:
- the team's `studio_definitions` row and its shows;
- its `studio_config:<team>` setting;
- every session of those shows, archived and hidden ones included;
- the rows of all nine per-session tables, with every column named explicitly.

It SHALL NOT insert users, memberships, prefs, invites, KV rows, the global
`active_studio_id` / `active_show_id` settings, or another team's rows. Every source value SHALL
travel only as COPY text-format data, never inside SQL text. Every value SHALL round-trip
exactly: text byte for byte, integers as 64-bit, reals to the bit, and NULL as NULL.

#### Scenario: A clean import
- **WHEN** the import for a team is applied to a migrated database that doesn't hold the team
- **THEN** it commits, and the team, its shows, its setting, its sessions and their rows exist
  with the source's values
- **AND** no user, membership, pref, invite or KV row was added, and the team has no owner until
  the bootstrap owner signs in

#### Scenario: A crafted value
- **WHEN** a source value holds quotes, `$$`, backslashes, a line `\.`, newlines, tabs or psql
  variables
- **THEN** it is stored unchanged, and no statement other than the emitted ones runs

### Requirement: The import refuses rather than guesses
The tool SHALL refuse, and emit nothing:
- a source whose `_migrations` set isn't exactly `0001_init.sql` through
  `0006_supabase_identity.sql`;
- a source table whose columns differ from the map;
- a value of the wrong type, a NUL character or invalid UTF-8;
- an audio key that isn't `audio/<its segment's session id>/<file name>`, or whose components
  are empty, start with `-`, or hold `..`, a backslash or a control character.

The tool SHALL write the import's closing `COMMIT` only after every source read, value check,
blob check and output file succeeded, so a failed run never emits a committable import.

The emitted transaction SHALL refuse:
- a target whose newest applied migration isn't the one the map was written for;
- a team, show or session id or `studio_config` key that already exists, unless the import was
  generated with `--replace`. Then it SHALL first delete that team's sessions with all their rows
  (leases and overwrite records included), its shows' wiki pages, aliases, revisions and
  suggestions, its shows, grants, setting, memberships and invites.
  Even then it SHALL refuse a show or session id that belongs to another team. And unless it
  was generated with `--replace-live`, it SHALL refuse, changing nothing, when the team has a
  session, show or audio segment not in the source, or any membership, invite, show grant,
  session lease, overwrite record, wiki page or wiki suggestion. Blob files SHALL never be deleted.

#### Scenario: A second import
- **WHEN** the same import is applied twice
- **THEN** the second run fails with `legacy import refused: team <id> already exists` and
  changes nothing

#### Scenario: Replace
- **WHEN** an import generated with `--replace` is applied after the team was imported but not used
- **THEN** the team's rows are exactly the source's, and other teams are untouched

#### Scenario: Replace refuses live data
- **WHEN** an import generated with `--replace` is applied after someone claimed the team or
  created a session in it
- **THEN** it fails with `legacy import refused: --replace would delete live data of team <id>`,
  naming each kind of live data, and changes nothing
- **AND** the same import generated with `--replace-live` swaps the team

#### Scenario: A failed run
- **WHEN** the run fails after it started writing the import (a blob check or an output file fails)
- **THEN** the emitted import holds no `COMMIT`

### Requirement: Imported rows look like the app wrote them
For each imported session, the import SHALL set:
- the six live-projection columns, from the imported events and transport row (as
  `SessionCore.writeProjectionIfDirty`);
- `revision`, from the `events_stream_revision` meta value when it is a plain integer of at
  most 18 digits, else 0;
- `version = 1` on events, transcript words and topics;
- a default transport row for a session that has none (as `SessionCore.seed`).

#### Scenario: A stale stored projection
- **WHEN** the legacy `sessions` row's `event_count` differs from its events
- **THEN** the imported `event_count` is the number of imported events

### Requirement: Parity proves the import
The tool SHALL emit a parity file that, run after the import, changes nothing. It SHALL fail when:
- any imported table's scoped row count, or the md5 over its sorted canonical row hashes,
  differs from the source's;
- any session's live projection differs from its rows;
- any session's `revision` differs from its imported `events_stream_revision` meta value (0 when
  that is missing or not a plain integer of at most 18 digits), computed in SQL;
- (unless generated with `--allow-signed-in-users`) users, memberships, prefs, invites or login
  sessions exist.

The tool SHALL list every audio key the imported segments reference, with sizes, and optionally
sha256, for the present files, and SHALL report the missing ones.

#### Scenario: Tampering is detected
- **WHEN** one imported word changes by one character, or one real by one ulp
- **THEN** parity fails, naming the table

#### Scenario: A tampered revision
- **WHEN** an imported session's `revision` or its `events_stream_revision` meta value changes
- **THEN** parity fails with `session(s) whose revision differs from events_stream_revision`

### Requirement: Imported PCM WAV blobs can be stored losslessly as FLAC
An operator CLI (`server/scripts/convertWavToFlac.ts`) SHALL convert the blobs of segments whose
key ends `.wav` or whose `mime_type` names WAV to FLAC next to them (`audio/<session id>/<same
stem>.flac`), and SHALL emit SQL that points each converted row at its FLAC (`r2_key`,
`mime_type = 'audio/flac'`). Only 16- and 24-bit integer PCM, probed from the file's header (not
trusted from the key or mime), SHALL be converted; anything else SHALL be reported as skipped. A
FLAC SHALL be accepted only after both files are decoded and their raw PCM (in the WAV's sample
format) has the same MD5 and length, and the FLAC's STREAMINFO carries the WAV's sample rate,
channel count, bit depth and sample count; otherwise the new FLAC SHALL be deleted and the segment
reported failed. The conversion SHALL NOT modify or delete any WAV; a FLAC is written to a temp
file inside the blob directory and linked into place without replacing an existing file; it SHALL
take the WAV's mode (and owner, when run as root). An existing FLAC SHALL be reused only when it
verifies. Each `UPDATE` SHALL match only its `(session_id, id)` row while `r2_key` is still the WAV
key, all in one transaction. Ids and keys SHALL be validated as for the waveform backfill, and the
WAV path SHALL NOT go through a symlink. A separate cleanup mode, given a fresh export of every
referenced key, SHALL only ever delete a WAV whose FLAC sibling exists, is a regular file and is
referenced while the WAV is not, SHALL be a dry run unless `--delete` is given, and SHALL verify
the pair again before deleting. The blob-scan reconciliation (sync-from-disk) SHALL skip a file
whose segment id already has a row, so a WAV and its FLAC never become two segments.

#### Scenario: Converted audio is bit-identical
- **WHEN** a 16-bit stereo and a 24-bit mono WAV are converted
- **THEN** each FLAC decodes to exactly the WAV's samples and has its rate, channels and bit depth

#### Scenario: A corrupt FLAC is never accepted
- **WHEN** the FLAC next to a WAV does not decode to the WAV's samples
- **THEN** the segment is reported failed, no `UPDATE` is emitted for it, and the WAV stays

#### Scenario: A re-run and a stale apply change nothing
- **WHEN** the conversion runs again, or the SQL is applied twice or after the row changed
- **THEN** the verified FLAC is reused, and only rows still holding the WAV key change

#### Scenario: Cleanup deletes only superseded WAVs
- **WHEN** one WAV's FLAC is referenced, another WAV is still referenced, and a third has no FLAC
- **THEN** only the first WAV is listed, and only `--delete` removes it

#### Scenario: Sync-from-disk ignores the sibling
- **WHEN** a segment's WAV and FLAC both exist and sync-from-disk runs
- **THEN** no second segment row is inserted
