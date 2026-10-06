## MODIFIED Requirements

### Requirement: Single V5 component vocabulary
The frontend SHALL present one component vocabulary: buttons, form controls, and dialogs render
in the V5 glass style (glass gradient surfaces, `--v5-border-strong` borders, uppercase tracked
label type for buttons, sky-tinted primary, red-tinted danger), and no surface renders the
legacy flat grey chrome. This is a steady-state requirement about the rendered result — the
migration mechanism (re-skinning the legacy class family in place versus porting consumers) is
a design decision (design D1), not a spec obligation, and later retiring the legacy class
family at zero consumers is compatible with this requirement. A shared component layer that new
surfaces build on SHALL render this same vocabulary by default, so a surface ported onto it does
not change appearance class.

#### Scenario: Export tab actions match the workspace vocabulary
- **WHEN** the Export feed tab renders its CSV/JSONL download actions
- **THEN** they render as V5 glass buttons (primary variants sky-tinted where applicable)
  with no flat legacy grey (`#2a2d36`) chrome

#### Scenario: Disabled buttons are visibly non-interactive without hover response
- **WHEN** any button in the shared vocabulary is disabled and hovered
- **THEN** it stays at reduced opacity with muted text and no hover border/background change

#### Scenario: Shared-layer button renders the V5 vocabulary
- **WHEN** a button from the shared component layer renders in its default, primary, and
  destructive variants
- **THEN** each renders an uppercase tracked label on a glass surface with a
  `--v5-border-strong`-family border, the primary variant sky-tinted and the destructive variant
  red-tinted, and its disabled state shows no hover response


### Requirement: AA contrast floor on rendered surfaces
Text and data labels SHALL meet WCAG AA (≥4.5:1, composited over the surface's effective base
color) on the surfaces they render on — including timeline tick timecodes, inactive feed-tab
labels, panel eyebrow labels, input placeholder text, recent-session row metadata, the timeline
total-duration readout, event-button-table secondary actions, primary button labels, dialog close
buttons, and the login page's secondary sign-in link. The chosen token values (ticks
`rgba(229,238,252,0.58)`, inactive tabs alpha 0.6, eyebrows alpha 0.62, muted text and placeholder
floor alpha 0.62, primary labels `#e0f2fe`, login secondary link alpha 0.78) are the reference
implementation evidence, not the requirement; any replacement SHALL still clear the floor.
Disabled controls are exempt (WCAG 1.4.3 incidental text). Colors chosen by users as data (for
example category colors) are outside this requirement.

#### Scenario: Timeline ticks are legible
- **WHEN** the session timeline renders its tick timecodes
- **THEN** their computed contrast against the timeline lane is at least 4.5:1
  (the prior `rgba(229,238,252,0.36)` = 2.96:1 is a regression)

#### Scenario: Inactive tab labels are legible
- **WHEN** a feed tab is not selected
- **THEN** its label contrast against the tab surface is at least 4.5:1

#### Scenario: Recent-session metadata is legible
- **WHEN** the recent-sessions list renders a row's date/event-count line and duration
- **THEN** each has contrast of at least 4.5:1 against the row surface
  (the prior muted alpha 0.55 = 4.27:1 is a regression)

#### Scenario: Timeline total duration is legible
- **WHEN** the timeline renders its total-duration readout (`/ hh:mm:ss`)
- **THEN** its contrast against the timeline surface is at least 4.5:1, with no extra
  opacity reduction (the prior 0.82 opacity = 4.01:1 is a regression)

#### Scenario: Event-button secondary action labels are legible
- **WHEN** the Settings Event Buttons table renders a row's "AI Rules" action without
  instructions
- **THEN** its label contrast against the row surface is at least 4.5:1
  (the prior alpha 0.35 = 2.8:1 is a regression)

#### Scenario: Primary button labels are legible
- **WHEN** a primary (sky-tinted) button renders, e.g. New Session's "Create & open"
- **THEN** its label contrast against the button's tinted surface is at least 4.5:1
  (the prior sky-on-sky label = 3.46:1 is a regression)

#### Scenario: Placeholders and dialog close buttons are legible
- **WHEN** a dialog renders an empty text field with a placeholder and its close (`×`) button
- **THEN** the placeholder and the close glyph each have contrast of at least 4.5:1 against
  their surfaces (the prior 0.55 alpha = 4.15:1 and 4.24:1 are regressions)

#### Scenario: Login secondary link is legible
- **WHEN** the signed-out login page renders "Create an account with Google"
- **THEN** its label contrast against the link surface is at least 4.5:1
  (the prior muted alpha 0.55 = 4.32:1 is a regression)
