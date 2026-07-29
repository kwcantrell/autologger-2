# web-ui-system — delta spec (auto-generate-event-logs)

The Settings event-buttons table gains per-button (and per-dropdown-option) generation
instruction fields. Additive: no existing Settings requirement changes behavior — the
existing dirtiness derivation (snapshot comparison) covers the new fields without
instrumentation.

## ADDED Requirements

### Requirement: Generation instruction fields in Settings
The Settings event-buttons table SHALL let the user view and edit each BUTTON,
DROPDOWN, and TEXT button's optional `auto_instruction` (multi-line-capable text
entry, max 2000 chars, clearable to absent), and, for DROPDOWN buttons, each dropdown
option's optional `auto_instruction` in the options modal alongside the existing
label/needs-context fields — plus the whole-button instruction, which remains editable
for DROPDOWN buttons. ON_OFF buttons SHALL NOT offer the field (they are excluded from
generation), and switching a button's type to ON_OFF drops its instructions from the
draft. Instruction edits SHALL participate in the existing draft-then-Save model
(enable Save, discard-guard on close) via the snapshot comparison — no new per-field
dirty flag. An **instruction-bearing** button (per `auto-event-generation`'s
definition: its own instruction non-empty, or any of its options') SHALL be visibly
distinguishable in the table (a compact indicator or summary) so users can tell which
buttons participate in AUTO GENERATE without opening each editor — an option-only
DROPDOWN lights the indicator. The Copy-Buttons-From flow SHALL carry instruction
fields with the copied buttons.

#### Scenario: Editing an instruction arms Save
- **WHEN** the user types an instruction on a button and closes the modal via Escape
  without saving
- **THEN** Save had become enabled and the themed discard confirmation intervenes

#### Scenario: Dropdown options carry their own instructions
- **WHEN** the user opens the options editor for a DROPDOWN button
- **THEN** each option row offers its own instruction field, the whole-button
  instruction is also editable, and saved values round-trip on reopen

#### Scenario: Copy from show preserves instructions
- **WHEN** the user copies buttons from another show whose buttons carry instructions
- **THEN** the copied drafts include the button- and option-level instruction fields

#### Scenario: ON_OFF buttons offer no instruction field
- **WHEN** the user views an ON_OFF button's row, or switches an instruction-bearing
  BUTTON to ON_OFF
- **THEN** no instruction field is offered, and the switched button's draft carries no
  instructions

#### Scenario: Option-only instructions light the indicator
- **WHEN** a DROPDOWN button has instructions only on its options
- **THEN** the table row shows the instruction-bearing indicator
