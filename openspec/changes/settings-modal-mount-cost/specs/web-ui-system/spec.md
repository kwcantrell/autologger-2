## ADDED Requirements

### Requirement: The shell-to-workspace render boundary stays memoizable
Every prop the shell passes across the render-isolation boundary to the mounted session workspace
SHALL hold a stable identity across shell renders, so that the boundary's memoization is able to
bail out. A shell state change SHALL NOT be the reason a boundary prop changes identity.

This requirement is deliberately scoped to prop stability — the property that is observable and
testable at the boundary. It makes no claim about how often the workspace renders in practice: the
change that introduced it originally asserted a large re-render reduction, and that assertion was
withdrawn when the render counts supporting it proved to be a profiling-tool artifact.

#### Scenario: Opening the settings modal does not disturb the boundary props
- **WHEN** a session workspace is mounted and the user opens the settings modal
- **THEN** every prop passed across the shell-to-workspace boundary is referentially identical to
  what it was before the click

#### Scenario: The boundary holds for every shell state change
- **WHEN** the user opens the New Session modal, the Batch Import modal, or the YouTube import
  error modal, closes the settings modal, or toggles the mobile navigation rail, while a session
  workspace is mounted
- **THEN** the boundary props remain referentially identical across each of those state changes

### Requirement: The Settings modal costs nothing while closed
While the Settings modal is closed it SHALL perform no form-initialisation work and SHALL render
no element tree. Specifically: the initialisation that hydrates show drafts from the profile SHALL
NOT run until the modal is open, and the modal SHALL render nothing while closed rather than
building a tree the dialog primitive then declines to show.

This SHALL be behaviour-neutral. The modal is mounted unconditionally by the shell so that it
survives route changes while open; rendering nothing while closed SHALL NOT disturb that, SHALL
NOT change what the DOM contains at any point, and SHALL NOT change what an open modal shows.

#### Scenario: Initialisation is deferred until the modal opens
- **WHEN** the app loads with the modal closed and the profile query resolves
- **THEN** no show drafts are hydrated and no form state is initialised, and that work happens on
  the first open instead — once, not twice

#### Scenario: A closed modal renders nothing
- **WHEN** the shell renders with the modal closed
- **THEN** the modal contributes no elements, and the DOM is identical to what it contained before
  this requirement existed

#### Scenario: An open modal is unaffected
- **WHEN** the user opens the modal, and while it is open the route changes
- **THEN** the modal opens on the General tab fully initialised, and it stays open and functional
  across the route change exactly as before

### Requirement: Settings modal defers inactive tab content
The Settings modal SHALL mount a tab panel's content on that tab's first activation, not on modal
open, and SHALL NOT unmount it on a subsequent tab switch. Each tab control's `aria-controls`
target SHALL resolve to a present element whether or not that panel's content has mounted.

Each open of the modal SHALL restart this discipline together with the existing reset to the
General tab, and SHALL do so without ever committing the previously-active tab's content to the
DOM — a reset applied after the opening commit would mount that content and then remove it, which
is the cost this requirement exists to remove.

Deferral SHALL NOT change what a save writes, and SHALL NOT arm the modal's unsaved-changes state:
because the modal owns the show drafts and the comparison snapshot, saving SHALL persist edits for
every show of the active team regardless of which tabs were visited, and mounting a tab's content
SHALL NOT by itself make the modal read as dirty.

#### Scenario: Opening the modal mounts only the active tab's content
- **WHEN** the user opens the Settings modal, which opens on the General tab
- **THEN** the Event Buttons, Auto Sync, and Debug panel contents are not mounted, and every tab
  control's `aria-controls` target resolves to a present element

#### Scenario: Activating a tab mounts its content and keeps it mounted
- **WHEN** the user selects the Event Buttons tab and then switches back to General
- **THEN** the Event Buttons content mounts on that first activation and remains mounted across the
  switch back, so its in-tab state (such as an open color popover or an in-progress drag order)
  survives the round trip

#### Scenario: Reopening never transiently mounts the previous tab's content
- **WHEN** the user activates the Event Buttons tab, closes the modal, and reopens it
- **THEN** the modal is on the General tab with the Event Buttons content unmounted, and that
  content is not mounted at any point during the reopen — observable as zero mounts of the panel's
  content between close and the settled reopened state, not merely as its absence afterwards

#### Scenario: Saving persists shows whose tab was never visited
- **WHEN** the user opens the Settings modal, edits a field on the General tab, and saves without
  ever activating the Event Buttons tab
- **THEN** the save submits the same show updates it would have submitted before deferral, and the
  modal returns to its saved state

#### Scenario: Mounting a deferred tab does not arm the discard guard
- **WHEN** the user opens the Settings modal, activates the Event Buttons tab, edits nothing, and
  closes the modal
- **THEN** no unsaved-changes confirmation intervenes and the modal closes directly

### Requirement: Event-button rows defer their type control
Each event-button row's button-type control SHALL NOT mount a listbox-style overlay component
until the user shows intent to use that control (pointer or keyboard focus). Rendering the row
SHALL cost only an inert trigger.

The deferred trigger SHALL be indistinguishable from the mounted control in appearance, accessible
name, role, and the ARIA state that role obliges — including its expanded and disabled state — so
that automated accessibility checks pass identically before and after the upgrade.

The upgrade SHALL NOT cost the user an interaction. An activation gesture SHALL both upgrade the
control and open it, and SHALL NOT depend on the upgraded control receiving the same physical
gesture that triggered the upgrade — that gesture is already consumed. This SHALL hold for a
mouse click, for a touch tap, and for a synthesized activation from assistive technology, none of
which are guaranteed to deliver the hover or focus events that a pointer-based upgrade would
otherwise rely on.

When the upgrade is triggered by keyboard focus, focus SHALL end on the upgraded control.

#### Scenario: Rendering rows does not mount per-row overlay components
- **WHEN** the Event Buttons tab's content mounts for a show with many event buttons
- **THEN** no row has mounted a listbox-style overlay component, and the count of such components
  mounted does not grow with the number of rows

#### Scenario: A single activation upgrades and opens
- **WHEN** the user activates a row's button-type control for the first time — by mouse click, by
  touch tap, or by an assistive-technology activation that delivers no prior hover or focus event
- **THEN** the control opens and is operable from that one activation, with the same options,
  selected value, and keyboard behavior as before this change

#### Scenario: Keyboard focus upgrades without losing focus
- **WHEN** the user tabs to a row's button-type control
- **THEN** focus ends on the upgraded control — not on the document body or the next element — and
  the control exposes the same accessible name, role, and ARIA state as before this change and is
  operable by keyboard without any pointer event
