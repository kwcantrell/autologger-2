# Show "Waveform unavailable" instead of a permanent "Generating waveform…"

Tier: 1
Tier reason: a bug fix inside the web waveform hook, one timeline component, the decode helper and their tests. No contract, spec requirement or high-risk path changes.
Panel: waived (small web fix).

Approved-by: pending

## Why

`TimelineWaveform` shows "Generating waveform…" whenever there are no merged peaks and there are
clips, without checking `isDecoding`. `useWaveforms` decodes missing segment peaks in the browser
and stores `null` when the decode fails, so a failed decode looks like an in-progress one and the
label stays forever. For very large files (1.3 GB WAVs) the browser first downloads the whole
file and then fails or runs out of memory.

## What Changes

- **`useWaveforms.ts`.** Returns a new `unavailable` flag (decode finished, at least one segment in
  the layout has no peaks). `isDecoding` is unchanged. A failed or skipped segment is remembered
  and not retried when the layout changes; server-provided peaks clear it.
- **`TimelineWaveform.tsx`.** "Generating waveform…" only while `isDecoding`. With no peaks and
  `unavailable`, a quiet "Waveform unavailable" in the same slot. Partial peaks render as before.
- **`waveformDecode.ts`.** `WAVEFORM_DECODE_MAX_BYTES` (200 MB). The size is the response
  `Content-Length`, checked before the body is read (the fetch body is cancelled when over the cap);
  without it the body is streamed and cancelled once the cap is passed. No segment metadata carries a byte size.
- `Timeline`, `MaximizeLogStrip`, `SessionWorkspace` pass `unavailable` through.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs: true`.

## Non-goals

- The server-side peaks backfill (separate branch).

## Impact

- `web/src/pages/index/hooks/useWaveforms.ts`, `.../timeline/TimelineWaveform.tsx`,
  `web/src/shared/utils/waveformDecode.ts`, pass-through props in three components, three new test files.
