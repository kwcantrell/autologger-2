## MODIFIED Requirements

### Requirement: Themed confirmations replace browser chrome
Destructive or discard-style confirmations SHALL use a shared themed confirm (an alert dialog
on desktop and a bottom sheet on mobile, danger-variant confirm action where the action is
destructive; Escape, overlay dismissal, and mobile sheet drag-dismiss all resolve as decline).
The frontend SHALL invoke neither `window.confirm`/`window.prompt` nor the bare
`confirm()`/`prompt()` globals — including the admin-users page and hook-initiated flows.
If a pending themed confirmation is replaced by another or unmounted before the user decides,
the pending decision SHALL resolve as declined (no awaiting flow may hang).

#### Scenario: Deleting a log row
- **WHEN** the user activates a row's Delete action outside batch-edit mode
- **THEN** a themed dialog titled for the action offers Cancel and a danger-styled Delete, and
  the row is deleted only on explicit confirm

#### Scenario: No browser-native confirm/prompt remains
- **WHEN** the web source is checked for invocations of `window.confirm`/`window.prompt` or
  the bare `confirm()`/`prompt()` globals (comment prose and the `useConfirm` hook's own API
  are not matches)
- **THEN** there are zero occurrences, and a repo test fails the build on any new occurrence

#### Scenario: Orphan-recording recovery warning is themed and race-safe
- **WHEN** a session opens with an orphan recording (recording event with no matching stop)
- **THEN** the synthetic-stop decision renders once per session mount in the themed confirm
  dialog (modal — workspace interaction paused as with any Radix modal); dismissal by any
  means is decline (nothing is posted); on accept the client SHALL re-validate the orphan
  against current events/status and the recording lease before posting, and SHALL no-op
  (dismissing the dialog) if the orphan no longer exists or the lease is alive; the posted
  `marked_at_utc` is accept-time, and the dialog copy SHALL NOT promise a specific timecode;
  a pending decision SHALL be dismissed (as decline) on session switch


### Requirement: Global single-key handlers yield to dialogs and interactive targets
Global single-key shortcuts (Space play/pause, `+`/`−` zoom, `1–9` logging, `?`) SHALL NOT
fire while any dialog, alert dialog, or menu is open (`role` `dialog`, `alertdialog`, or `menu`),
and SHALL NOT intercept a key when the event target
is a button or other interactive element that consumes that key (a focused button's Space
activation always wins over the global handler).

#### Scenario: Space activates a focused confirm button, not playback
- **WHEN** a themed confirm dialog is open in a session with recorded audio and the user
  presses Space with the confirm button focused
- **THEN** the button activates and audio playback does not toggle

#### Scenario: Zoom keys ignored behind dialogs
- **WHEN** any dialog is open and the user presses `+` or `−`
- **THEN** the timeline zoom does not change

#### Scenario: Shortcuts yield to an open confirm
- **WHEN** a themed confirm is open as an alert dialog and the user presses Space, `+`, a digit
  `1`–`9`, or `?` with focus outside any control that consumes the key
- **THEN** no global shortcut fires
