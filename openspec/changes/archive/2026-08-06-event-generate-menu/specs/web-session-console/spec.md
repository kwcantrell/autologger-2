## ADDED Requirements

### Requirement: Event feed Auto Generate menu

The event feed Auto Generate control SHALL be a dropdown whose trigger label is
**Auto Generate** (or **Generating…** while a run for this session is pending).
The menu SHALL offer:

1. **Generate All** when the loaded event list has no row with
   `metadata.auto_generated === true`; otherwise **Regenerate All**.
2. **Custom**, which opens a modal.

Generate All SHALL POST generate with no regenerate flag and no selection.
Regenerate All SHALL POST `{ regenerate: true }`. Existing 503 latch,
no-instructions gate, pending/outcome session scoping, and inline error
channels SHALL continue to apply to runs started from the menu.

#### Scenario: Menu flips to Regenerate All after auto events exist

- **WHEN** the session’s loaded events include at least one auto-generated row
- **THEN** the first menu item is labeled Regenerate All

#### Scenario: Custom opens modal without starting a run

- **WHEN** the operator chooses Custom
- **THEN** a selection modal opens and no generate request is sent until submit

### Requirement: Custom generate modal

The Custom modal SHALL list instruction-bearing buttons and, for DROPDOWN
buttons, each option that has a non-empty `auto_instruction`, as independently
selectable entries. Submit SHALL require at least one selected entry and SHALL
POST generate with `selection` only (`regenerate` false/absent). Cancel SHALL
close without generating.

#### Scenario: Custom submit sends selection

- **WHEN** the operator selects one button-level instruction and one option
  instruction and submits
- **THEN** the client POSTs generate with those two selection entries and
  without `regenerate: true`

### Requirement: Event filter checkmarks

In the event feed Filter popover, each toggled-on category (and Show internal
events when on) SHALL show a checkmark beside the label. Selected items SHALL
NOT use the selected background/text highlight tint used elsewhere for
`PopoverItem selected`.

#### Scenario: Visible category shows checkmark

- **WHEN** a show category is not hidden by the filter
- **THEN** its filter row shows a checkmark and is not highlighted via the
  selected tint
