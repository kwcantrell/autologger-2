## ADDED Requirements

### Requirement: Shell state changes do not re-render the session workspace
Opening or closing a shell-level overlay, or toggling shell-level navigation state, SHALL NOT
cause the mounted session workspace to re-render. The render-isolation boundary that exists
between the shell and the workspace SHALL be effective, which requires every prop crossing it to
hold a stable identity across shell renders.

#### Scenario: Opening the settings modal leaves the workspace untouched
- **WHEN** a session workspace is mounted and the user opens the settings modal
- **THEN** the workspace and its feed panels do not re-render, and the work performed by the click
  does not grow with the open session's event or transcript volume

#### Scenario: The isolation holds for every shell overlay
- **WHEN** the user opens the New Session modal, the Batch Import modal, or the YouTube import
  error modal, or toggles the mobile navigation rail, while a session workspace is mounted
- **THEN** the workspace does not re-render in any of those cases

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
