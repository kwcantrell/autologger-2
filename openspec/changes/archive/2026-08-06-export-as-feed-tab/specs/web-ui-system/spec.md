# web-ui-system — delta (export-as-feed-tab)

## MODIFIED Requirements

### Requirement: Single V5 component vocabulary
The frontend SHALL present one component vocabulary: buttons, form controls, and dialogs render
in the V5 glass style (glass gradient surfaces, `--v5-border-strong` borders, uppercase tracked
label type for buttons, sky-tinted primary, red-tinted danger), and no surface renders the
legacy flat grey chrome. This is a steady-state requirement about the rendered result — the
migration mechanism (re-skinning the legacy class family in place versus porting consumers) is
a design decision (design D1), not a spec obligation, and later retiring the legacy class
family at zero consumers is compatible with this requirement.

#### Scenario: Export tab actions match the workspace vocabulary
- **WHEN** the Export feed tab renders its CSV/JSONL download actions
- **THEN** they render as V5 glass buttons (primary variants sky-tinted where applicable)
  with no flat legacy grey (`#2a2d36`) chrome

#### Scenario: Disabled buttons are visibly non-interactive without hover response
- **WHEN** any button in the shared vocabulary is disabled and hovered
- **THEN** it stays at reduced opacity with muted text and no hover border/background change
