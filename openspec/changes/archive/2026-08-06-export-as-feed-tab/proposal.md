# export-as-feed-tab — proposal

## Why

Session export lives behind a Timeline **Export** button that opens a Dialog. Operators
already navigate feeds via the tab strip; export belongs with those surfaces as a sixth
tab after Dashboards — same download actions, no modal chrome, no Timeline button.

`web-session-console` freezes tab IA as exactly five tabs, so this is a capability delta,
not a silent UI tweak. `web-ui-system` still describes Export as a dialog with Close.

## What Changes

- **Tab IA**: six feed tabs in order Event Feed → Transcript → Topics → Assistant →
  Dashboards → **Export**, default still Event Feed; Export panel mounted-hidden like
  the others.
- **Export surface**: inline feed panel (FeedShell) with the download actions formerly in
  the Export dialog (Event feed CSV, Transcript CSV, Topics CSV, Event feed JSONL). No
  Dialog; no Close control (leaving the tab is enough).
- **Timeline**: remove the Export button and `onExport` wiring.
- **Tests / e2e**: SessionWorkspace tab inventory; visual e2e opens the Export tab instead
  of `#btn-export-log` / modal heading.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `web-session-console`: tab inventory/order/labels and mounted-hidden discipline extend
  to six tabs including Export
- `web-ui-system`: Export actions scenario refers to the Export **tab**, not a Dialog

## Non-Goals

- New export formats or server endpoints
- Changing Transcript’s separate toolbar “Export CSV” control
- Redesigning the export action list beyond inlining the current modal body
- HTTP/WS contract changes

## Contract impact

None — web-only IA and presentation.
