## MODIFIED Requirements

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

## ADDED Requirements

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
