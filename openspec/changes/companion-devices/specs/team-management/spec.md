## MODIFIED Requirements

### Requirement: Member content access
A user SHALL be able to access a show when:
- they are the `owner` or an `admin` of the show's team; or
- they are a `member` of the show's team who holds a grant for that show.

A user SHALL be able to access a session when they can access the session's show. A session with no show SHALL be denied.

This one rule SHALL decide:
- every session-scoped API route;
- the session WebSocket upgrade;
- the show-scoped log import, checked when it is requested and again before each sheet it imports;
- every Companion route, called by a signed-in user or by a Companion device acting as the user
  who created it (api-contract-freeze "Companion routes run as the caller's user");
- which sessions the transcript-generation lock names to a requester.

A denial SHALL be the same masked `404` a non-member gets today, so a member without a grant cannot tell whether the session exists.

What a member without a grant keeps:
- the team's show list and each show's details (`GET /api/shows`, `GET /api/shows/:showId`);
- the session list of their active show, in the usual entry shape with only identity, titles and dates filled; the fields that carry content or live state are blanked (api-contract-freeze "Session list entries for a show without access");
- switching their active team and show, and editing their own names.

What needs a role, whatever the grants:
- creating a show, changing team settings and editing a show's settings need `owner` or `admin` (`403`).

Creating a session in a show the caller can see but cannot access SHALL get `403` (the show is not masked). The check is decided inside the creating transaction, so a revoke that commits first refuses the create.

The web app SHALL follow the same rule (web-home-launch "Session actions follow show access"). Its Settings view SHALL stay reachable for a member (owner, 2026-10-02, confirmed at approval):
- a member's view SHALL disable the team settings and the show editing controls under a notice naming their role;
- a member SHALL still be able to edit and save their own account settings (their names), and that save SHALL NOT send team or show settings — the default frame rate is a team setting and lives in Team details, not Account.

#### Scenario: A member without a grant is masked
- **WHEN** a member with no grant for show S requests a session of S, its events, an export, its audio, an AI route, its WebSocket, or the log import for S
- **THEN** each responds with the same masked `404` a non-member of the team gets

#### Scenario: Titles stay visible
- **WHEN** a member with no grant for their active show S requests the session list
- **THEN** the response lists S's sessions in the usual shape, with titles and dates and with `notes` empty, `event_count` 0 and `is_rolling` false

#### Scenario: Owners and admins need no grant
- **WHEN** the owner and an admin of team T, holding no grants, open a session of any show of T
- **THEN** both get the session

#### Scenario: Members don't create shows or change settings
- **WHEN** a member, with or without grants, creates a show in their team or saves team or show settings
- **THEN** each request responds `403` and nothing changes

#### Scenario: A revoke racing a session create
- **WHEN** an admin revokes member M's grant for show S while M creates a session in S
- **THEN** either the create commits first and the session exists, or the revoke commits first and the create responds `403` and creates nothing

#### Scenario: A member saves Settings
- **WHEN** a member switches the active team in the top bar, opens Settings, edits their name and saves
- **THEN** the team and show controls render disabled under a role notice, the save succeeds, and the request carried no team or show settings
