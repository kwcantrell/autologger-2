# sheets-log-import — proposal

## Why

Operators keep episode logs in Google Sheets (one tab per episode). Pasting those
notes into Autologger by hand is slow and error-prone, especially when the sheet
timecode clock does not match the session audio clock. Batch Import already has an
**Import Logs** control (currently a no-op on `batch-audio-import`). This change
turns it into a server-side import that reads a public Sheets workbook, matches
tabs to sessions by title, aligns log rows to the transcript with a scored sync,
and creates feed events at corrected session times.

## What Changes

### Prerequisite (batch-audio-import amend, landed first)

- Stitched local-audio imports persist ordered **seam part durations** on the
  session (`audio_seam_parts_json`) so multi-file episodes can sync per original
  part. Playback remains one blob.

### Server — Sheets log import

- Accept a public Google Sheets URL (anyone-with-link). Fetch workbook export
  (XLSX preferred); parse tabs.
- Per tab: rows from row 7; col A timecode, B message, C optional type.
- Match `sheet.name === session.title` for the Batch Import–selected show.
- Ensure transcript exists (generate via existing DeepGram path if empty).
- Score-based transcript↔log alignment; per seam-part offset rules; fail the
  session on missing solid/corroborated sync.
- Map column C to show categories (BUTTON/TEXT → name; DROPDOWN/ON_OFF → labels;
  longest wins; blank/unmatched → OTHER).
- Bulk-create events at computed session timecodes (new contract surface).
- In-process job + progress polling API.

### Web

- Import Logs prompts for Sheets URL; Start Import runs log-import job when URL
  set (independent of audio folder); progress lines include sync confidence.

## Capabilities

### New Capabilities

- `sheets-log-import`: public workbook ingest, title match, scored sync, category
  mapping, job progress, modal wiring.

### Modified Capabilities

- `api-contract-freeze`: delta for log-import job endpoints and bulk
  event-at-timecode import (or equivalent create-at-frames path used only by the
  job). Seam header on local-audio-import is request-only (no response-shape change).

## Impact

- Server: fetch/parse, sync/scoring, category match, job store, event create-at-frames,
  README inventory, tests (incl. HD_385 golden cases).
- Web: BatchImportModal Import Logs URL + Start Import polling.
- Contract: yes — new endpoints.
- Ops: public Sheets egress; DeepGram when transcript missing; no new Google OAuth.

## Non-Goals

- Private Sheets / OAuth scopes beyond login.
- Client-side sync.
- Merging task list into batch-audio-import OpenSpec (wiring only).
- Multi-blob playback (stitch stays one blob).
- Changing frozen `GET …/transcribe.csv` (stays 503).
