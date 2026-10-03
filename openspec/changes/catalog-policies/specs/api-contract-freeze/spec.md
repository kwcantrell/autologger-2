## ADDED Requirements

### Requirement: Writes whose access is revoked in flight change nothing
A write whose access is revoked while the request is in flight SHALL change nothing, and SHALL
get the answer its route already gives for missing access. Revoked in flight means that a grant
revocation, a member removal or a demotion commits after the route's access check and before its
write. Such a write went through with its success response before ADR 0021 slice 6b-2, when the
database did not enforce access.
- `PUT /api/sessions/:id`, `POST /api/sessions/:id/archive`, `POST /api/sessions/:id/restore`
  and `DELETE /api/sessions/:id` SHALL answer `404 {"detail": "Session not found"}` and leave the
  session row unchanged.
- `PUT /api/profile` with team settings or show updates SHALL answer
  `403 {"detail": "Admin role required."}` and write nothing, prefs and names included, as
  "Show creation and team settings need owner or admin" already requires of a member.
- A YouTube import's opt-in publish date SHALL NOT be written. The import's response is
  unchanged, as for any publish date that cannot be stored.

This narrows those routes' success outcome only for this race: a write the caller no longer has
access to is an expected refusal, not a success. Every request that no such revocation races
SHALL get the same status, body and side effects as before.

#### Scenario: A session rename racing a grant revoke
- **WHEN** a granted member's `PUT /api/sessions/:id` has passed its access check, and the
  revocation of the member's grant on the session's show commits before the update
- **THEN** the response is `404 {"detail": "Session not found"}` and the session's title is
  unchanged

#### Scenario: An archive racing a removal
- **WHEN** a member's `POST /api/sessions/:id/archive` has passed its access check, and the
  member's removal from the team commits before the archive
- **THEN** the response is `404 {"detail": "Session not found"}` and the session is not archived

#### Scenario: A profile save racing a demotion
- **WHEN** an admin's `PUT /api/profile` with `settings` has passed its early role check, and the
  admin's demotion to member commits before the save
- **THEN** the response is `403 {"detail": "Admin role required."}` and the team's settings,
  shows, and the admin's prefs and names are unchanged
