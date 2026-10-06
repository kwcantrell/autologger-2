# session-edit-conflicts QA (task 8.2)

The walk (`screens.sh`, `cap.sh`, `contrast.js`, `feedprobe.js`, `focusprobe.sh`) is copied from
the archived `remove-admin-users-page/qa`. A fresh **`before`** baseline was captured on the
artifacts commit, before any web code changed. **`after`** was then diffed against it, with one
pass per width (`QA_VP="1440 900"` and `"390 844"`). PNGs are gitignored.

## Regression walk

**Screen diffs.** 41 screens × 2 widths = 82 captures.

| Result | Screens |
| --- | --- |
| Pixel-identical | 70 captures |
| 19–20 px (≤ 0.01%) | `add-show-dialog`@1440, `event-instruction-modal`, `event-options-modal`, `import-logs-prompt`: caret and focus-ring noise inside open dialogs |
| 90 px (0.01% / 0.03%) | `reveal-in-feed`: the reveal highlight caught at a different animation phase (the red diff marker sits on the revealed row's accent bar) |

None of these screens renders a changed component. The conflict dialog only appears on a `409`,
and the walk never edits a row.

**Contrast.** 82 captures, with 0 failures apart from the out-of-scope user-data "Audio issue"
(3.64, `filter-menu`). That failure is unchanged from `before`.

## Conflict paths (dev stack, session ATS_youtube `0c8aaf43`, 1440)

"Another person" is an unversioned request sent from the page with `fetch`, standing in for a
second editor; the server checks versions regardless of who writes. Each value was restored
afterwards with an unversioned write. Screenshots are in `conflict/`.

| Surface | Steps | Result |
| --- | --- | --- |
| Topic (Duration) | Type 109; another person sets 120; blur | "Row changed" shows `Duration (s): theirs "120", yours "109"`, with Keep theirs and Overwrite (`topic-conflict.1440.png`) |
| | Escape | The dialog closes. The control still shows 109, and the server still has 120 v2. |
| | Refocus, blur | The dialog shows again. |
| | Overwrite | The server has 109 v3. |
| Topic (Level) | Type 9; another person sets 5; blur; Keep theirs | The control shows 5, and the server has 5 v4. Nothing was sent. |
| Transcript word | Type "Reckless1"; another person sets "RECKLESS"; blur | `Word: theirs "RECKLESS", yours "Reckless1"` (`word-conflict.1440.png`) |
| | Keep theirs | The row shows "RECKLESS". |
| | Type "Reckless2"; another person sets "RECKLESS!"; blur; Overwrite | The server has "Reckless2" v4. |
| Event batch (stopped session) | Edit Scene to "Scene A" and Lav to "Lav B"; another person sets Scene to "Scene X"; Save | One prompt, for Scene only: `Message: theirs "Scene X", yours "Scene A"` (`event-batch-conflict.1440.png`) |
| | Keep theirs | The batch continued: the server has "Scene X" v4 and "Lav B" v4. The toast reads "Changes saved, 1 kept theirs." and batch mode ended. |
| Event batch | Edit Scene to "Scene A"; another person sets "Scene Y"; Save; Overwrite | The server has "Scene A" v6, and the toast reads "Changes saved." |

**Audit.** The query was
`select table_name, replaced_version from catalog.session_overwrites where session_id = '0c8aaf43…'`.
It returns exactly **3 rows**, one per Overwrite:

| `table_name` | `replaced_version` |
| --- | --- |
| `session_topics` | 2 |
| `session_transcript_words` | 3 |
| `session_events` | 5 |

Keep theirs, dismissals and the unversioned restores wrote no audit rows.

## Not exercised here

- **Event inline edit.** It only runs while rolling or with a recording lease. The probe session
  is stopped, and rolling it would add events to the owner's data. The inline paths are covered
  by the `EventLogSheet.virtualization.test.tsx` conflict describe and by the owner pass (8.3).
- **Event delete conflict, both "Delete anyway" and "Keep theirs".** The QA tooling cannot click
  Delete. This path is left to the owner's pass (8.3).
