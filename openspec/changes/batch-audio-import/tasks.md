# batch-audio-import — tasks

## Phase 1 — Mime map

- [x] 1.1 Expand `audioStore` MIME→extension mapping for mp3/mpeg and aiff/aif; unit test.

## Phase 2 — Local audio import API (TDD)

- [x] 2.1 Integration tests for `POST /api/sessions/:id/local-audio-import`: happy path single blob + duration_s + anchor, 400 missing/invalid duration, 404 session, put failure rollback.
- [x] 2.2 Implement router reusing `addAudioSegment` / `anchorImportedTake` / rollback pattern from YouTube import (no ffmpeg, no multi-part stitch, no network fetch).
      *(2026-08-03 remediation: post-put rollback now exceeds the YouTube pattern — it deletes the blob as well as the metadata row; the body read is a counted stream enforcing the 1500 MiB cap mid-read.)*
- [x] 2.3 Wire route into app; update README endpoint inventory.

## Phase 3 — Batch Import UI shell

- [x] 3.1 Rail Batch Import icon → up-arrow; modal header icon match; tests.
- [x] 3.2 Modal: Show dropdown (New Session parity), Import Audio / Import Logs / Start Import layout, progress region; Import Logs no-op test.
- [x] 3.3 Directory picker + folder **name** under Import Audio; close clears selection.

## Phase 4 — Client import runner

- [x] 4.1 Pure helpers: discover audio files, group by stem/`-N`, order segments — unit tests.
      *(2026-08-03 remediation: grouping tightened — `-N` candidates merge only as a contiguous run starting at 1 within the same relative directory; otherwise single-file groups keyed by full stem.)*
- [x] 4.2 Client stitch helper (Web Audio decode→concat→WAV) + duration_s; unit/integration-style test with fixture buffers where feasible.
      *(2026-08-03 remediation: single-file groups pass original bytes through (metadata-probe duration, no decode); multi-file groups pre-flight-capped at 150 MB summed input with a per-group failure line; mono parts up-mix.)*
- [x] 4.3 Match/skip/create against sessions for selected show (active-show align via profile PUT); call local-audio-import; progress lines + percent; AbortController on close; invalidate `sessions`; never navigate; tests.

## Phase 5 — Final gates

- [x] 5.1 `npm run typecheck` + `npm test`.
- [ ] 5.2 `npm run e2e` (chromium + login-gate) and `npm run e2e:visual`; re-bless baselines if Batch Import chrome is in a covered shot.
      *(2026-08-03 remediation: deliberately left unticked — deferred to the whole-branch gate on the PR branch.)*
