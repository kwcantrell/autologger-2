# export-as-feed-tab — tasks

## Phase 1 — Export feed panel

- [x] 1.1 Add client Topics CSV helper (`topicsCsv.ts` + unit tests) if not already on
      branch; keep existing `transcriptCsv` helpers
- [x] 1.2 Refactor Export dialog → inline `ExportFeed` / `ExportPanel` in FeedShell
      (title Export; Event feed CSV, Transcript CSV, Topics CSV, Event feed JSONL; no
      Dialog / onClose / Close)

## Phase 2 — Tab IA + Timeline

- [x] 2.1 Extend `FEED_TABS` / `feedPanels` with Export; remove `showExport`, modal mount,
      and Timeline `onExport`
- [x] 2.2 Remove Timeline Export button, `BTN_EXPORT`, and `onExport` prop (and empty head
      actions if unused)

## Phase 3 — Tests

- [x] 3.1 Update `SessionWorkspace` unit tests (six tabs; Export after Dashboards); fix
      mocks that targeted `ExportModal`
- [x] 3.2 Update `e2e/visual.spec.ts` export flow to open the Export tab; refresh snapshot
      as needed
      - test renamed to `export-tab` / `export-tab.png`; obsolete `export-modal-*-linux.png`
        removed. New `export-tab-*-linux.png` captured on win32 Chromium and renamed for
        the repo's linux-only snapshot convention — re-bless on linux CI if pixels drift.
- [x] 3.3 `npm run typecheck` + scoped web vitest for changed files
      - scoped vitest: 18/18 green
      - web typecheck/build: green after trimming stale fields from
        `TranscribeFeed.lockStatus.test.tsx` status fixture (`SessionStatus` no longer
        carries `timecode_total_frames` / `start_offset_frames` / `audio_segment_count`)
