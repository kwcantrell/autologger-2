## MODIFIED Requirements

### Requirement: Honest capability gating on generation features
When transcript, topic, or event generation returns HTTP 503 (feature not configured for this
caller), the panel SHALL latch that state **per mounted panel**, persisting across session switches
within the mount:
- the generate control becomes non-actionable, with the reason reachable by keyboard and assistive
  technology (visible text or `aria-describedby` on a focusable `aria-disabled` control, not solely
  a mouse `title`);
- the empty-state copy names the cause and the remedy, plus the manual alternative.

**Transcription.** The cause and remedy are the caller's own speech-to-text key: "Add a
speech-to-text key in Settings → Advanced", with the audio-egress consequence. The copy SHALL link
or point to that section.

**Clearing the latch.**
- The transcription latch SHALL clear without a reload when the user saves a speech-to-text
  credential in this page load.
- The topic and event generation latches are cleared by reload, and their copy names "no
  integration configured" and tells the operator to reload after configuring.

Generation errors SHALL render in exactly one channel (inline in the panel), not duplicated as
toasts.

#### Scenario: Unconfigured transcription discovered once
- **WHEN** Auto Generate returns 503 on the Transcript tab
- **THEN**:
  - the control becomes non-actionable with a keyboard-reachable reason;
  - the empty state says to add a speech-to-text key in Settings → Advanced and points at Insert;
  - no copy names `DEEPGRAM_API_KEY` or a server setting;
  - no toast duplicates the message

#### Scenario: Saving a key clears the transcription latch
- **WHEN** the Transcript tab is latched unavailable and the user saves a speech-to-text credential
  in Settings → Advanced without reloading
- **THEN** the Transcript tab's generate control is actionable again

#### Scenario: Non-503 generation failure
- **WHEN** generation fails with a non-503 error
- **THEN** the error renders once, inline in the panel toolbar, with the server's detail text

#### Scenario: Unconfigured event generation latches
- **WHEN** AUTO GENERATE on the event feed returns 503
- **THEN** the control latches non-actionable for the mounted panel with a
  keyboard-reachable reason naming the missing integration and the reload-after-configuring
  remedy, and manual logging remains available unchanged
