# web-session-console — delta (export-as-feed-tab)

## MODIFIED Requirements

### Requirement: Workspace tab IA (single owner)
This capability is the sole owner of the session-workspace tab inventory, order, and labels.
The workspace SHALL present exactly six top-level tabs in one `Feed tabs` tablist, in order:
**Event Feed, Transcript, Topics, Assistant, Dashboards, Export**, defaulting to Event Feed.
Transcript and Topics SHALL be top-level panels (not nested under an agent tab); the agent
surfaces carry the names "Assistant" (chat) and "Dashboards" (AI v2) — the labels "AI" and
"AI v2" SHALL NOT appear in the tab navigation (other capabilities' references to tab labels
are non-normative and defer here). All six panels SHALL stay mounted with visibility toggled
via the `hidden` attribute (the established mounted-hidden discipline), and the Dashboards
panel SHALL keep `key={sessionId}` at its mount site. (The Assistant panel is deliberately
NOT keyed by session — its cross-session conversation persistence is pre-existing behavior,
recorded as an accepted residual in design.) The Export panel SHALL present the session's
download actions inline (not as a dialog) and SHALL NOT depend on a Timeline Export control.

#### Scenario: Tab inventory and default
- **WHEN** a session workspace mounts
- **THEN** the `Feed tabs` tablist contains exactly Event Feed, Transcript, Topics, Assistant,
  Dashboards, Export, with Event Feed selected

#### Scenario: Chat survives tab switches (no unmount)
- **WHEN** the user switches from Assistant to any other tab and back
- **THEN** the chat panel's DOM node is the same object (never unmounted) and an in-flight
  stream is not aborted

#### Scenario: Tab strip on narrow viewports
- **WHEN** the viewport is under 768px wide
- **THEN** the tablist scrolls horizontally with single-line tab labels (no wrapping), and
  every tab remains reachable by keyboard

#### Scenario: Export tab is mounted-hidden like other feeds
- **WHEN** the user is on Event Feed (or any non-Export tab)
- **THEN** the Export tabpanel remains in the DOM with the `hidden` attribute set
