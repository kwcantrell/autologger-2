## MODIFIED Requirements

### Requirement: Settings modal defers inactive tab content
The Settings view SHALL mount a section's content on that section's first visit, not on open, and SHALL NOT unmount it on a later section switch while the view stays open. Each navigation control's `aria-controls` target SHALL resolve to a present element whether or not that section's content has mounted. (The requirement keeps its historical name.)

The view's sections are:
- **You:** Account, Companion devices.
- **Team:** Members, Shows, Team details.
- **Show:** Show details, Event buttons.

There is no Auto Sync section and no Debug section.

Each open SHALL restart this discipline on the section the open names: the section the invoking control asks for, otherwise the section last visited during this page load, initially Show details. The open SHALL never commit a previously visited section's content to the DOM. A reset applied after the opening commit would mount that content and then remove it, which is the cost this requirement exists to remove.

Deferral SHALL NOT change what a save writes, and SHALL NOT arm the unsaved-changes state. The view owns the show drafts and the comparison snapshot, so an inline section's save SHALL persist that section's edits regardless of which other sections were visited. Mounting a section's content SHALL NOT by itself make the view read as dirty.

#### Scenario: Companion devices is listed in the You group
- **WHEN** the Settings view is open for any role
- **THEN** the "You" group's navigation lists Account and then Companion devices, and the
  Companion devices content mounts only on its first visit

#### Scenario: Opening the modal mounts only the active tab's content
- **WHEN** the user opens Settings from the rail
- **THEN** only the named section's content is mounted, the other sections' contents are not, and every navigation control's `aria-controls` target resolves to a present element

#### Scenario: Activating a tab mounts its content and keeps it mounted
- **WHEN** the user visits Event buttons and then switches to Show details
- **THEN** the Event buttons content mounts on that first visit and remains mounted across the switch, so its in-section state (such as a scroll position or a palette preview) survives the round trip

#### Scenario: Reopening never transiently mounts the previous tab's content
- **WHEN** the user visits Event buttons, closes Settings, and reopens it on Members
- **THEN** the Event buttons content is not mounted at any point during the reopen. This is observable as zero mounts of that content between close and the settled reopened state, not merely as its absence afterwards.

#### Scenario: Removed sections are gone
- **WHEN** the Settings view is open for any role
- **THEN** no Auto Sync and no Debug section or navigation control is present

#### Scenario: Saving persists shows whose tab was never visited
- **WHEN** the user opens Settings on Show details, edits the show's name, and saves without ever visiting Event buttons
- **THEN** the save submits the same show update (the show's name together with its unchanged categories and palette) it would have submitted had Event buttons been visited, and the section returns to its saved state

#### Scenario: Mounting a deferred tab does not arm the discard guard
- **WHEN** the user opens Settings, visits Event buttons, edits nothing, and closes Settings
- **THEN** no unsaved-changes confirmation intervenes and the view closes directly

## ADDED Requirements

### Requirement: Settings manages the user's Companion devices
The Settings view SHALL have a **Companion devices** section, in the "You" group after Account
(see "Settings modal defers inactive tab content"), available to every
signed-in user whatever their team role (ADR 0021 slice 9d, owner decision 4). It SHALL use the
existing Settings parts and the shared component vocabulary, and it SHALL show and change only the
signed-in user's own devices, through the routes of api-contract-freeze "Companion device
management routes".

- **List.** The section SHALL list the user's devices with name, created time, and last-used time
  or "Never". A device the server reports as `expired` (unused for 90 days, api-contract-freeze
  "Companion device tokens authenticate only the Companion surface") SHALL be marked "Expired"
  and still offer Revoke.
- **Add.** A name field and an Add button SHALL create a device. On success a dialog SHALL show
  the new token in a read-only field with a Copy control and the line "Copy this token now. It
  won't be shown again." The token SHALL live only in that dialog's component state: it SHALL NOT
  be written to the query cache or any storage, and closing the dialog SHALL drop it. The list
  SHALL then show the new device.
- **Revoke.** Each device SHALL offer Revoke, which SHALL ask through the themed confirm dialog
  and then delete the device and refresh the list.
- **Errors.** A failed list, add or revoke SHALL show the response's `detail` (for example the
  ten-device limit) and change nothing else.

The section acts immediately; it has no save bar and no unsaved state, so "Honest save model in
Settings" does not apply to it.

#### Scenario: Adding a device shows its token once
- **WHEN** the user enters a device name, presses Add, copies the token, closes the dialog and
  reopens the section
- **THEN** the dialog showed the token with Copy and the one-time warning, the token was copied,
  the list shows the new device with last used "Never", and the token is shown nowhere afterwards

#### Scenario: Revoking asks first
- **WHEN** the user presses Revoke on a device and declines the confirmation, then presses it
  again and confirms
- **THEN** after declining the device is still listed and no request was sent; after confirming
  the device is deleted and no longer listed

#### Scenario: The device limit is explained
- **WHEN** a user who holds 10 devices adds another
- **THEN** the section shows the server's detail naming the ten-device limit, and the list is
  unchanged

#### Scenario: An expired device is marked
- **WHEN** the list response includes a device with `expired: true`
- **THEN** that device is listed with an "Expired" marker and a Revoke control, and the other
  devices carry no marker

#### Scenario: A member manages their own devices
- **WHEN** a plain member of a team, with no grants, opens Settings
- **THEN** the Companion devices section is enabled, and it lists only that member's devices
