## MODIFIED Requirements

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
