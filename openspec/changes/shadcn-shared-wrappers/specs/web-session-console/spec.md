## MODIFIED Requirements

### Requirement: Logging hotkeys 1–9
While the live dock is shown (rolling or audio-recording — the same condition that enables the
live category tiles), digit keys `1`–`9` SHALL trigger the 1st–9th category buttons (identical
behavior to clicking, including dropdown/text modal flows), and the first nine live tiles
SHALL display their digit as a badge (`aria-hidden`). Hotkeys SHALL fire at most once per
physical keypress (auto-repeat ignored via `event.repeat`), and SHALL NOT fire: while a
text-entry element (input, textarea, select, contenteditable) has focus; while any dialog,
alert dialog, or menu is open; or with Ctrl, Meta, or Alt held. Shift is deliberately permitted
(digits require Shift on some layouts).

#### Scenario: Hotkey logs an event
- **WHEN** the live dock is shown and the user presses `2` with no dialog open and focus
  outside any input
- **THEN** the second category button's action fires (e.g. a BUTTON-type category logs an
  event)

#### Scenario: Held key logs once
- **WHEN** the user holds a digit key so the OS auto-repeats it
- **THEN** exactly one activation fires for the physical keypress

#### Scenario: Hotkeys stay out of text entry
- **WHEN** focus is in an input, textarea, select, or contenteditable and the user presses a
  digit
- **THEN** no category action fires
