# sheets-log-import — tasks

## Phase 0 — Seam prerequisite (batch-audio amend)

- [x] 0.1 Persist `audio_seam_parts_json` from optional `X-Audio-Seam-Parts` on
      `local-audio-import` (default single part = `duration_s`); hub get/set; validate
      sum ≈ duration; client stitch sends part durations; tests.

## Phase 1 — Pure sync / parse / category (TDD)

- [x] 1.1 Sheet timecode parser (`8:48`, `1:07:05` → seconds; frame 0) + tests.
- [x] 1.2 Score-based transcript aligner + part window/offset rules (solid/decent,
      ≥60s fail) + HD_385-shaped golden unit tests.
- [x] 1.3 Category mapper (BUTTON/TEXT/DROPDOWN/ON_OFF, OTHER, longest, append) + tests.

## Phase 2 — Event create-at-frames + Sheets fetch

- [x] 2.1 `EventStore.addEventAtTotalFrames` + SessionHub wrapper; unit test.
- [x] 2.2 Public XLSX fetch + exceljs parse (rows from 7, A/B/C); unit/integration with
      fixture buffer; fail on non-public.
- [x] 2.3 Add `exceljs` dependency to server workspace.

## Phase 3 — Job orchestrator + HTTP

- [x] 3.1 In-process job store; `POST /api/shows/:showId/log-import` +
      `GET /api/log-import/:jobId`; progress shape; wire app + README inventory.
- [x] 3.2 Per-session pipeline: match title → seams → ensure transcript (generate) →
      sync → map categories → create/skip duplicates; fail rules; integration tests.

## Phase 4 — Modal

- [x] 4.1 Import Logs URL prompt; store URL; Start Import starts job when URL set;
      poll + progress lines; tests.

## Phase 5 — Gates

- [x] 5.1 `npm run typecheck` + `npm test` (server + web relevant).
