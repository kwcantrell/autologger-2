# Spec Delta

## MODIFIED Requirements

### Requirement: Team roles, owner anchor and show access
Every team membership SHALL carry a role: `owner`, `admin` or `member`. A team SHALL have at
most one `owner`, and the catalog SHALL refuse a second one. All `/api/teams/*` endpoints SHALL
require an authenticated user (`401` otherwise). For a team the caller is not a member of, team
endpoints SHALL respond with a masked `404` (existence not confirmed, matching the sessions
posture). For a team the caller is a member of without the required role, they SHALL respond
`403`. Team-management operations SHALL require these roles:

| Operation | owner | admin | member |
| --- | --- | --- | --- |
| rename | yes | yes | `403` |
| invite, revoke an invite | yes | yes | `403` |
| remove a `member` | yes | yes | `403` |
| remove an `admin` | yes | `403` | `403` |
| change a role (promote or demote) | yes | `403` | `403` |
| delete the team | yes | `403` | `403` |
| transfer ownership | yes | `403` | `403` |
| grant or revoke show grants | yes | yes | `403` |
| create a show, change team or show settings | yes | yes | `403` |
| preview, start, view or cancel a batch autogenerate job | yes | yes | `403` |
| leave | `409` | yes | yes |

No operation on this surface SHALL target the owner: removing the owner or changing the owner's
role SHALL be refused with `409` and change nothing, whoever the caller is. Content access SHALL
follow "Member content access": owners and admins reach every show of their team, and a member
reaches only the shows they hold a grant for. There are no built-in teams: every team,
`test-studios` and `test-studio-2` included, is managed through this surface.

#### Scenario: Admin manages, member cannot
- **WHEN** a team `admin` renames the team and a plain `member` of the same team attempts the
  same rename
- **THEN** the admin's request succeeds and the member's responds `403`

#### Scenario: Only the owner changes roles and deletes
- **WHEN** a team `admin` attempts to promote a member, demote another admin, or delete the
  team
- **THEN** each request responds `403` and nothing changes, and the same requests by the owner
  succeed (the delete subject to the shows rule)

#### Scenario: Non-member cannot probe a team
- **WHEN** an authenticated user who is not a member of team T calls any `/api/teams/T/*`
  operation, and another user calls the same operation for a team id that does not exist
- **THEN** both receive the same masked `404`

#### Scenario: Former built-ins are ordinary teams
- **WHEN** the owner of `test-studios` (after the bootstrap claim) renames it, and a non-member
  calls any `/api/teams/test-studios/*` operation
- **THEN** the rename succeeds and the non-member gets the masked `404`; no request gets the old
  built-in `400`

#### Scenario: Content access follows the role and the grants
- **WHEN** the owner, an admin, a member with a grant for show S and a member without one each
  open a session of S in their team
- **THEN** the first three get the session, and the member without a grant gets the masked
  `404`

#### Scenario: Batch autogenerate is a manager operation
- **WHEN** an admin and a plain member of the same team each list the team's batch autogenerate
  jobs
- **THEN** the admin gets `200` and the member gets `403`
