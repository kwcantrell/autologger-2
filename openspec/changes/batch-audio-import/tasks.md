# batch-audio-import — tasks

## Phase 1 — Mime map

- [ ] 1.1 Expand `audioStore` MIME→extension mapping for mp3/mpeg and aiff/aif; unit test.

## Phase 2 — Local audio import API (TDD)

- [ ] 2.1 Integration tests for `POST /api/sessions/:id/local-audio-import`: happy path single blob + duration_s + anchor, 400 missing/invalid duration, 404 session, put failure rollback.
- [ ] 2.2 Implement router reusing `addAudioSegment` / `anchorImportedTake` / rollback pattern from YouTube import (no ffmpeg, no multi-part stitch, no network fetch).
- [ ] 2.3 Wire route into app; update README endpoint inventory.

## Phase 3 — Batch Import UI shell

- [ ] 3.1 Rail Batch Import icon → up-arrow; modal header icon match; tests.
- [ ] 3.2 Modal: Show dropdown (New Session parity), Import Audio / Import Logs / Start Import layout, progress region; Import Logs no-op test.
- [ ] 3.3 Directory picker + folder **name** under Import Audio; close clears selection.

## Phase 4 — Client import runner

- [ ] 4.1 Pure helpers: discover audio files, group by stem/`-N`, order segments — unit tests.
- [ ] 4.2 Client stitch helper (Web Audio decode→concat→WAV) + duration_s; unit/integration-style test with fixture buffers where feasible.
- [ ] 4.3 Match/skip/create against sessions for selected show (active-show align via profile PUT); call local-audio-import; progress lines + percent; AbortController on close; invalidate `sessions`; never navigate; tests.

## Phase 5 — Final gates

- [ ] 5.1 `npm run typecheck` + `npm test`.
- [ ] 5.2 `npm run e2e` (chromium + login-gate) and `npm run e2e:visual`; re-bless baselines if Batch Import chrome is in a covered shot.
