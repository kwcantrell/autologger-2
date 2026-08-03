# web-session-console — delta (maximize-log-view)

## ADDED Requirements

### Requirement: Maximize-log layout preference
The workspace SHALL persist a browser-local layout preference with exactly two values:
**default** and **maximize-log**. Missing or invalid stored values SHALL mean **default**.
Changing the preference SHALL NOT require a reload. The preference SHALL survive navigating
between sessions in the same browser profile. Forcing the default layout because the open
session is rolling or recording SHALL NOT write or clear the stored preference.

#### Scenario: Preference survives session navigation
- **WHEN** the operator sets maximize-log, then opens a different idle session
- **THEN** the displayed layout for that idle session is maximize-log

#### Scenario: Force-default does not clear preference
- **WHEN** preference is maximize-log and the open session begins rolling or recording
- **THEN** the displayed layout becomes default while the stored preference remains
  maximize-log

#### Scenario: Idle session restores maximize-log after forced default
- **WHEN** preference is maximize-log, the operator views a rolling or recording session
  (displayed default), then opens an idle session that is neither rolling nor recording
- **THEN** the displayed layout is maximize-log

### Requirement: Displayed layout selection
The workspace SHALL display maximize-log layout only when the stored preference is
maximize-log **and** the open session is neither rolling nor recording (recording means the
session-wide audio recording lease is alive). Otherwise the workspace SHALL display the
default two-panel deck (Timeline panel + Session Controls panel) with existing live-dock and
stopped-state strip behavior unchanged.

#### Scenario: Maximize-log when idle
- **WHEN** preference is maximize-log and the open session is stopped (not rolling, lease
  not alive)
- **THEN** the maximize-log fused strip is shown and the default twin panels are not

#### Scenario: Rolling forces default
- **WHEN** preference is maximize-log and the open session is rolling
- **THEN** the default two-panel deck is shown (including live category dock rules)

#### Scenario: Recording forces default
- **WHEN** preference is maximize-log and the open session’s recording lease is alive
- **THEN** the default two-panel deck is shown

### Requirement: Maximize-log fused transport strip
In maximize-log layout the workspace SHALL render one fused horizontal transport strip in
place of the default twin deck panels. The strip SHALL include the timeline
scrubber/waveform/markers surface, the session timecode, and the transport controls, and
SHALL omit the default Timeline panel head (session title cluster and marker-nav chrome) and
the default Session Controls panel head chrome (eyebrow, session-ID chip). The strip’s
height SHALL be approximately **80% of the `#timeline-clips` lane height** (the
clips/waveform row in the default Timeline). The strip SHALL include a keyboard-shortcuts
control equivalent to the default Session Controls `?` button (opens the shortcuts dialog);
the existing global `?` key remains available as well.

#### Scenario: Strip contents
- **WHEN** maximize-log layout is displayed
- **THEN** the operator can scrub the timeline, read the timecode, use transport controls,
  and open the shortcuts dialog from the strip’s `?` control, without the default twin
  panel headers

### Requirement: Maximize-log toggle on the feed tablist row
The workspace SHALL provide a labeled control on the Feed tabs row, trailing the tab
buttons, that is **not** a tab (it SHALL NOT appear in the tablist’s tab inventory or own a
tabpanel). Labels follow the **stored preference** (not the forced display): when preference
is default the label SHALL be **Maximize log** and activation SHALL set preference to
maximize-log; when preference is maximize-log the label SHALL be **Default view** and
activation SHALL set preference to default. While the open session is rolling or recording,
**Maximize log** (preference still default) SHALL be non-actionable with a
keyboard-reachable reason naming rolling or recording; **Default view** remains actionable
so the operator can clear maximize-log preference even under force-default.

#### Scenario: Toggle sets preference on idle session
- **WHEN** the open session is idle and the operator activates Maximize log
- **THEN** preference becomes maximize-log and the fused strip is displayed

#### Scenario: Maximize log blocked while rolling
- **WHEN** the open session is rolling and preference is default
- **THEN** Maximize log is non-actionable with a keyboard-reachable reason and preference
  remains default

#### Scenario: Default view still clears preference while recording
- **WHEN** preference is maximize-log, the open session is recording (displayed default),
  and the operator activates Default view
- **THEN** preference becomes default (display stays default)
