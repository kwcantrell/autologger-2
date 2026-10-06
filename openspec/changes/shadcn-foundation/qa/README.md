# shadcn migration QA (Phase 0 and every gate)

## Tools

- **`screens.sh <dir>`**: the fixed walk. It covers 26 screens (pages, the six workspace tabs, Settings tabs, dialogs and menus), each at 1440×900 and 390×844, through the `shadcn-qa` agent-browser session. Dialogs and menus are opened only to look at them and are always left with Escape or Close. It never presses Save, Delete or Confirm.
- **`cap.sh <dir> <name>`**: moves the mouse to a corner, then takes the screenshot and runs the contrast probe at both widths. `QA_INJECT='<css>'` injects a candidate fix first, which is for design measurements only.
- **`contrast.js`**: an in-page WCAG probe.
  - It composites each text color, including placeholders, over every ancestor background layer.
  - For each gradient layer it picks the stop that gives the lowest contrast. That's conservative: it over-reports rather than under-reports.
  - It skips disabled controls and text at effective opacity below 0.05.
  - It doesn't model `backdrop-filter`, glows or images.
- **Outputs:** `baseline/` holds the state before any shadcn work. Each gate writes `after-<step>/` and compares with `agent-browser diff screenshot --baseline`.
- **PNGs aren't tracked** (`qa/.gitignore`). Only the scripts and the `*.contrast.json` files are.

## Dev data at baseline

One session, TS_261006: no events, no audio, no transcript, no topics. The show has three event buttons (BUTTON, DROPDOWN, TEXT). The feeds show their empty states.

## Not reachable by the walk with this data

These need a code review for Preflight drift (task 4.1) and a human dev-stack pass:
- the themed confirm dialog (the session-menu Delete path is blocked for the agent)
- TranscribeModal (needs recorded audio)
- EventGenerateCustomModal
- YouTubeImportErrorModal
- MaximizeLogStrip (needs a recording)
- AudioSaveOverlay
- ChunkRescueBanner
- populated event, transcript and topic rows
- TeamCard member lists with several members
- the AI v2 dashboard widgets with data

## Baseline AA failures (corrected probe, at 1440)

| Ratio | Text | Screens | Disposition |
| --- | --- | --- | --- |
| 2.8 | "AI Rules" label | settings-event-buttons | fix (D7) |
| 3.46 | "Create & open" primary label | new-session | fix (D7) |
| 3.64 | "Audio issue" filter item | filter-menu | **out of scope**: a user-chosen category color |
| 4.01 | `/ 00:00:05` timeline duration | all workspace screens | fix (D7) |
| 4.15 | placeholders (Session notes, YouTube URL, `e.g. …`) | new-session, event-instruction, event-options | fix (D7) |
| 4.24 | dialog close `×` | new-session, batch-import | fix (D7) |
| 4.27 | recent-session details and duration | all workspace screens | fix (D7) |
| 4.32 | "Create an account with Google" | login | fix (D7) |
| 4.48 | "Add new button" primary label | settings-event-buttons | fix (D7) |
