## ADDED Requirements

### Requirement: Settings manages the user's AI providers
The Settings view SHALL have an **Advanced** section, in the "You" group after Companion devices,
available to every signed-in user whatever their team role. It SHALL show and change only the
signed-in user's own provider credentials, through api-contract-freeze "Provider credential
routes".

It SHALL be composed from the shared shadcn primitives and the existing Settings parts, with no
one-off markup where a primitive exists.

**Approval note.** When `GET /api/me/providers` reports `run_features_allowed: false`, the
section SHALL show, above the tabs, a status note: "Transcription and AI features are limited to
approved users on this server." The user can still save and test keys.

**Layout.**
- The section SHALL show two tabs, **Language model** and **Speech to text**.
- Both tab panels SHALL stay mounted while the section is mounted, so an unsaved edit in one
  survives switching to the other.
- Each panel SHALL show:
  - a status badge, "Connected" when a credential is saved and "Not set up" otherwise;
  - one-line help naming what the provider powers.

**Fields.**
- **Language model:** Base URL, Model, API key.
- **Speech to text:** Provider (DeepGram, the only choice), Model, API key.

**The API key is write-only.**
- With no saved credential, the key is a password input.
- With one, the row reads "Key set, ending in ••<last4>." and offers **Replace**, which shows the
  password input, and **Remove**, which asks through the themed confirm dialog and then deletes the
  credential.
- A typed key SHALL live only in the panel's component state. It SHALL NOT be written to the query
  cache or any storage, and SHALL be cleared after a save.

**Saving.**
- Each panel SHALL have its own save bar, following "Honest save model in Settings".
- Save SHALL be disabled until the panel's fields are valid:
  - a model is required;
  - a base URL is required for the language model;
  - a key is required when none is saved;
  - a key is required when the language model's base URL host changes. The key row then shows
    the password input with the help "A new host needs its key entered again."

**Testing.**
- Each panel with a saved credential SHALL offer **Test connection**. It shows a busy state while
  running, then the response's `detail` as a success or error alert.
- Editing any field SHALL clear the last result.

**Errors.** A failed load, save, remove or test request SHALL show the response's `detail` and
change nothing else.

#### Scenario: Saving a key shows only its last four characters
- **WHEN** a user enters a base URL, a model and the key `sk-test-9f2c` on Language model and saves
- **THEN** the badge reads "Connected", the key row reads "Key set, ending in ••9f2c.", and the
  key appears nowhere else on the page or in the query cache

#### Scenario: A draft survives a tab switch
- **WHEN** the user types a model on Language model, switches to Speech to text, and switches back
- **THEN** the typed model is still there and the Language model save bar still offers Save

#### Scenario: Removing a key asks first
- **WHEN** the user presses Remove, declines, presses it again and confirms
- **THEN** after declining nothing was sent; after confirming the credential is deleted and the
  panel shows "Not set up" with an empty key input

#### Scenario: A failed test shows the server's reason
- **WHEN** the user tests a credential and the response is `{ok: false, detail: "The provider
  rejected the API key."}`
- **THEN** the panel shows that detail in an error alert

#### Scenario: Users who are not approved are told before adding a key
- **WHEN** a user whose providers response has `run_features_allowed: false` opens Advanced
- **THEN** the approval note shows above the tabs, and the fields still work

#### Scenario: Changing the host asks for the key again
- **WHEN** a user with a saved language model changes its base URL to another host
- **THEN** the key row shows an empty password input with the new-host help, and Save stays
  disabled until a key is entered

#### Scenario: A member manages their own providers
- **WHEN** a plain member of a team, with no grants, opens Settings
- **THEN** the Advanced section is enabled and shows only that member's credentials

## MODIFIED Requirements

### Requirement: Settings modal defers inactive tab content
The Settings view SHALL mount a section's content on that section's first visit, not on open, and SHALL NOT unmount it on a later section switch while the view stays open. Each navigation control's `aria-controls` target SHALL resolve to a present element whether or not that section's content has mounted. (The requirement keeps its historical name.)

The view's sections are:
- **You:** Account, Companion devices, Advanced.
- **Team:** Members, Shows, Team details.
- **Show:** Show details, Event buttons.

There is no Auto Sync section and no Debug section.

Each open SHALL restart this discipline on the section the open names: the section the invoking control asks for, otherwise the section last visited during this page load, initially Show details. The open SHALL never commit a previously visited section's content to the DOM. A reset applied after the opening commit would mount that content and then remove it, which is the cost this requirement exists to remove.

Deferral SHALL NOT change what a save writes, and SHALL NOT arm the unsaved-changes state. The view owns the show drafts and the comparison snapshot, so an inline section's save SHALL persist that section's edits regardless of which other sections were visited. Mounting a section's content SHALL NOT by itself make the view read as dirty.

#### Scenario: Companion devices is listed in the You group
- **WHEN** the Settings view is open for any role
- **THEN** the "You" group's navigation lists Account and then Companion devices, and the
  Companion devices content mounts only on its first visit

#### Scenario: Advanced is listed after Companion devices
- **WHEN** the Settings view is open for any role
- **THEN** the "You" group's navigation lists Account, Companion devices and then Advanced, and
  the Advanced content mounts only on its first visit

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
