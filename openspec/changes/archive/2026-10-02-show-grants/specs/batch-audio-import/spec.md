## MODIFIED Requirements

### Requirement: Rail Batch Import control

The left rail SHALL expose a Batch Import control immediately under New Session when the active
team has at least one show the user can access (web-home-launch "Session actions follow show
access"); otherwise neither control is shown. The
control's icon SHALL be an up-arrow (upload) affordance. Activating it SHALL open the
Batch Import modal.

#### Scenario: Opens modal from rail

- **WHEN** the user activates Batch Import on the rail
- **THEN** the Batch Import dialog is shown

#### Scenario: Hidden without an accessible show
- **WHEN** a member whose active team has no show they can access views the rail
- **THEN** no Batch Import control is shown
