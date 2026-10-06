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

## Preflight (task 2.3)

`preflight-drift.js` lists every element whose computed style Preflight changes: it removes Preflight's rules live and diffs the result. **The owner accepted the normalization on 2026-10-06** (design D4). Because of it:
- button and input text uses Inter, not the browser's Arial
- headings inherit their weight
- SVGs are blocks

Only the League Gothic titles get an explicit `font-bold` back. Expect `after-*` diffs of roughly 0.1–5% against `baseline` from this.

## Preflight drift review of unreachable surfaces (task 4.1)

The review scanned the components listed above for elements that relied on browser defaults, which Preflight now resets: bare `p`, headings and lists, class-less `button`/`input`, and inline `svg`.

| Finding | Action |
| --- | --- |
| `YouTubeImportErrorModal` bare `<p>` lost its 1em margins | `my-[1em]` |
| `TranscribeModal` `.modal-transcribe-status` / `-error` `<p>` (no CSS margin) | `my-[1em]` |
| `TeamCard` three bare `<ul>` (members, invites, read-only members) lost bullets, 40px indent and 1em margins | `my-[1em] list-disc pl-10` |
| `ConfirmDialog .modal-lead`, `TeamCard`/`EventGenerateCustomModal .modal-hint` | no change: the legacy CSS sets the margins |
| `MaximizeLogStrip` session-meta `<p>` | no change: it already has `m-0` |
| Checkboxes (`EventGenerateCustomModal`, `TeamCard`) lose the browser's 3–4px margin | accepted as part of the normalization |
| Inputs and buttons in `EventLogRow`, `TranscribeRow`, `DashboardEditor`, `AiV2Design` and `CatalogPicker` | no change: they set explicit classes (the scanner had cut off at `=>`) |
| SVGs in `MaximizeLogStrip`, `EventLogRow` and `UnavailableState` | no change: each sits inside an `inline-flex`/`flex` parent, so `display:block` doesn't affect layout |

These surfaces still need the owner's dev-stack pass, because the walk can't reach them with the current data.

## Final gate: `after-foundation` vs `baseline` (tasks 5.1/5.2)

Contrast: all 52 captures pass, except the out-of-scope user-data `Audio issue` (3.64). Pixel diffs come from the accepted Preflight normalization (button and input text in Inter instead of Arial, headings and cards a few px taller) and from the contrast fixes. Pairs are in `baseline/<screen>.<w>.png` and `after-foundation/<screen>.<w>.png`, and the diff overlays are in `after-foundation/*.diff.png` (local only).

| Screen | 1440 | 390 |
| --- | --- | --- |
| admin-users | 0.61% | 0.09% |
| batch-import | 0.66% | 1.26% |
| color-popover | 2.14% | 3.98% |
| event-instruction-modal | 2.26% | 2.78% |
| event-options-modal | 2.27% | 0.57% |
| filter-menu | 0.57% | 0.09% |
| home | 1.10% | 3.08% |
| login | 0.05% | 0.20% |
| new-session-expanded | 1.41% | 4.77% |
| new-session | 0.95% | 3.95% |
| not-found | 0% | 0% |
| session-menu | 1.10% | 2.65% |
| settings-auto-sync | 0.04% | 0.10% |
| settings-debug | 0.04% | 0.10% |
| settings-event-buttons | 1.99% | 3.98% |
| settings-general | 0.34% | 0.11% |
| shortcuts | 0.14% | 0.06% |
| teams | 1.19% | 4.04% |
| time-display-menu | 0.56% | 0.09% |
| transcribe-modal | 0.59% | 0.09% |
| ws-assistant | 0.21% | 0.09% |
| ws-dashboards | 0.27% | 0.09% |
| ws-event-feed | 0.42% | 0.09% |
| ws-export | 0.20% | 0.09% |
| ws-topics | 0.53% | 0.09% |
| ws-transcript | 0.49% | 0.09% |

**The human reviews the pairs and does the dev-stack pass on the unreachable surfaces: pending.**
