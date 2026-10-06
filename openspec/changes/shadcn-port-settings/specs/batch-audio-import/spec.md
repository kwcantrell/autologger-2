# Spec Delta

## REMOVED Requirements

### Requirement: Batch Import modal chrome and actions

**Reason**: Its "Import Logs SHALL not perform any import action" clause and the "Import Logs is a no-op" scenario contradict sheets-log-import, which since shipped the log import driven from this control.
**Migration**: Replaced by "Batch Import modal layout and actions" below; the control order is unchanged.

## ADDED Requirements

### Requirement: Batch Import modal layout and actions

The Batch Import modal SHALL include, in order: a Show dropdown equivalent to New
Session's show picker; an Import Audio control; an Import Logs control; a Start
Import control; and a progress region beneath Start Import. Import Logs SHALL
collect the public Google Sheets URL for the log import specified by
sheets-log-import (through a themed text prompt); the import itself SHALL run
only on Start Import. Import Logs SHALL NOT open a directory picker, import
audio, or create sessions.

#### Scenario: Import Logs collects the Sheets URL for the log import

- **WHEN** the user activates Import Logs
- **THEN** a themed prompt asks for the public Google Sheets URL, no directory picker
  opens, and nothing is imported or created until the user activates Start Import
