## ADDED Requirements

### Requirement: Missing waveform peaks can be backfilled offline
An operator CLI (`server/scripts/backfillWaveforms.ts`) SHALL compute waveform peaks for audio
segments whose `waveform_peaks_json` is `NULL` and SHALL emit them as SQL for the operator to apply.
The stored values SHALL be what the browser would store for that segment decoded on its own: the
same bucket-count rule (`segmentWaveformDecodeBucketCount(duration, duration)`), the same
max-abs-across-channels bucket peak, the same dB envelope and `-48` floor, values in `[0, 1]`, and
the same JSON number array; the bucket computation SHALL be one shared pure function pinned to the
web's copy by a test. Decoding SHALL stream (memory independent of file size). Each `UPDATE` SHALL
match only its `(session_id, id)` row while `waveform_peaks_json` is still `NULL`, so a re-run, or a
browser that stored peaks meanwhile, is never overwritten. Segment ids and blob keys SHALL be
validated (`audio/<session id>/<file>`, no `..`, no leading `-`, resolved inside the blob directory)
before any path is opened or any SQL is written. A segment that fails SHALL be reported and SHALL NOT
stop the others; the CLI SHALL exit non-zero when any segment was not filled.

#### Scenario: Backfilled peaks equal the browser's
- **WHEN** the same PCM is given to the web's `computeDbPeaks01` and to the backfill's accumulator
- **THEN** the two peak arrays are bit-identical

#### Scenario: A re-run changes nothing
- **WHEN** the emitted SQL is applied twice, or after a browser stored peaks for one of the rows
- **THEN** only rows that were `NULL` at apply time change, and existing peaks are untouched

#### Scenario: One bad file does not stop the run
- **WHEN** the segment list holds a missing blob, an undecodable blob and a valid one
- **THEN** the valid one gets an `UPDATE`, the other two are reported, and the exit code is 1
