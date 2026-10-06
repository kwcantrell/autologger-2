# Spec Delta

## MODIFIED Requirements

### Requirement: New Session progressive disclosure
The New Session modal SHALL present the core flow (show, episode, notes, create) directly, with
YouTube import and timecode settings (frame rate, start offset) behind collapsed disclosures
whose summaries show the current values; defaults SHALL be safe without opening either
disclosure. The episode control follows the show's title-suffix preference (session-title-suffix
"New Session modal respects suffix"); the modal SHALL NOT offer a bonus-episode control.

#### Scenario: Creating a session without touching disclosures
- **WHEN** the user opens New Session, picks a show, and submits
- **THEN** the session is created with the profile-default frame rate and zero offset, without
  either disclosure having been opened
