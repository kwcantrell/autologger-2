## MODIFIED Requirements

### Requirement: Show grants
A show grant SHALL be a `(user, show)` pair that gives a `member` full session access in that
show: open, record, edit, create sessions and imports. Each grant SHALL record `can_write`, which
is always true in this version, who granted it and when. Owners and admins of the show's team
SHALL grant and revoke grants, and see each member's granted shows in the team detail; a member
SHALL get `403`.

- **Grant.** The target SHALL be a current member of the show's team (`404 Member not found`
  otherwise). Granting to the owner or an admin SHALL succeed and store nothing, because their
  role already gives access. Granting a grant that exists SHALL succeed and change nothing. A
  member whose account is disabled SHALL be grantable (the membership is inert while disabled).
- **Revoke.** Revoking SHALL succeed whether or not the grant existed.
- **Scope.** The show SHALL belong to the team named in the request (`404 Show not found.`
  otherwise, after the caller's role check).
- **Revocation with the membership.** When a member leaves a team, is removed from it, or loses
  the membership through the support plane, their grants for that team's shows SHALL be deleted
  in the same transaction as the membership. Deleting a show or a user SHALL delete its grants.
- **Role changes keep grants.** Promoting a member to admin, demoting an admin to member, and
  transferring ownership SHALL leave stored grants unchanged; a grant held by an owner or admin
  has no effect until they are a `member` again.
- **Concurrency.** The caller's role and the target's membership SHALL be re-checked inside the
  transaction that writes the grant. A grant racing the target's leave or removal SHALL end as
  some serial order of the two: either the leave commits first and the grant gets `404 Member not
  found`, or the grant commits first and the leave deletes it. In both cases no grant outlives
  the membership.
- **Open sockets close.** After a revoke commits, the server SHALL close every session WebSocket
  that user holds on the show's sessions in any server process sharing the database (ADR 0021
  slice 9a); the client's reconnect then gets the
  masked `404`. Sockets on shows the user still reaches stay open (team-management "Owner-anchored
  team lifecycle and access revocation").

#### Scenario: An admin grants a member a show
- **WHEN** an admin grants member M show S of their team, and M then opens a session of S
- **THEN** the grant responds `200`, the team detail lists S in M's `show_ids`, and M gets the
  session

#### Scenario: A member cannot manage grants
- **WHEN** a plain `member` grants or revokes a grant in their team
- **THEN** each request responds `403` and nothing changes

#### Scenario: Granting to a non-member, an owner or an admin
- **WHEN** an admin grants show S to a user who is not a member of the team, then to the owner,
  then to another admin
- **THEN** the first responds `404 Member not found`, and the other two respond `200` and store no
  grant

#### Scenario: Grant and revoke are idempotent
- **WHEN** an admin grants member M show S twice, then revokes it twice
- **THEN** every request responds `200`, and M ends with no grant for S

#### Scenario: A show from another team
- **WHEN** an admin of team T grants a show that belongs to team U, or a show id that does not
  exist
- **THEN** both respond `404 Show not found.` and nothing is stored

#### Scenario: Leaving or removal revokes the grants
- **WHEN** member M holds grants for two shows of team T and one show of team U, and M leaves T
  (or an admin removes M from T, or support deletes M's membership of T)
- **THEN** M has no grant for T's shows and keeps the grant for U's show, and re-inviting M to T
  restores no access

#### Scenario: A promoted and demoted member keeps their grants
- **WHEN** the owner promotes member M, who holds a grant for show S, to admin and later demotes
  M back to member
- **THEN** M reaches every show while admin, and after the demotion reaches S and no other show

#### Scenario: A revoke closes the member's open sockets
- **WHEN** member M has session WebSockets open on a session of show S and on a session of show T,
  both granted, and an admin revokes M's grant for S
- **THEN** M's socket on the S session is closed and its reconnect gets the masked `404`, and M's
  socket on the T session stays open

#### Scenario: An unrelated revoke leaves a granted socket open
- **WHEN** member M holds a grant for show S and has a session WebSocket open on it, and an admin
  revokes another member's grant for S, or M's grant for another show
- **THEN** M's socket stays open

#### Scenario: A grant racing the target's leave
- **WHEN** an admin grants member M a show while M leaves the team
- **THEN** either the grant gets `404 Member not found`, or the grant succeeds and the leave
  deletes it; in both cases M ends with no membership and no grant

### Requirement: Owner-anchored team lifecycle and access revocation
The owner and admins SHALL be able to rename their team and remove a `member`. Only the owner
SHALL be able to promote a `member` to `admin`, demote an `admin` to `member`, remove an
`admin`, transfer ownership, and delete the team. Any member other than the owner SHALL be able
to leave. Deleting a team SHALL keep the existing rule: it is rejected while the team still has
shows. Deleting SHALL remove the team's memberships, pending invites, definition row, and
settings blob — through the same store method the admin plane uses, so both planes cascade
identically.

**The owner anchors the team.** The owner SHALL NOT leave, be removed or have their role changed
through this surface; each such request SHALL be rejected with `409` (`Transfer ownership
first.`) and change nothing. Last-admin protection SHALL NOT exist: an owner may demote or
remove every admin, and a team whose only admin-capable member is the owner is valid.

**Transfer.** `POST /api/teams/:id/owner {user_id}` SHALL make `user_id` the owner and the
previous owner an `admin`, in one catalog transaction. The target SHALL be a current member of
the team (`404 Member not found` otherwise) whose account is enabled (`400` otherwise). A
transfer to the caller themselves SHALL succeed and change nothing.

**Revocation.** Removal, leave, demotion, transfer, delete and a grant revoke take effect at the
next authorization check (HTTP request or WebSocket establishment). In addition, when a removal,
leave, demotion to `member` (team plane or support plane), support-plane membership delete or
grant revoke commits, the server SHALL close every session WebSocket the affected user holds, in
any server process sharing the database, on a session they can no longer access (owner decision E, 2026-10-02); the client's
reconnect gets the masked `404`. Sockets on sessions the user still reaches stay open, and
in-flight HTTP requests are not interrupted. The close is published inside the transaction that
removes the access (ADR 0021 slice 9a), so a removal whose close cannot be published fails and
changes nothing.

#### Scenario: Promote, demote, remove
- **WHEN** a team owner promotes member M to admin, then demotes them back, then removes them
- **THEN** each operation succeeds in turn and the members list reflects it

#### Scenario: An admin removes members but not admins
- **WHEN** admin A removes member M, and then attempts to remove admin B
- **THEN** M's removal succeeds, and the attempt on B responds `403` and B keeps their membership

#### Scenario: The owner cannot leave or be stripped
- **WHEN** the owner attempts to leave, and an admin or the owner attempts to remove the owner or
  change the owner's role
- **THEN** each request responds `409` with `Transfer ownership first.` and the owner's
  membership is unchanged

#### Scenario: Transfer ownership
- **WHEN** owner O transfers ownership of the team to member M
- **THEN** M is the owner, O is an `admin`, the team has exactly one owner, and O can now leave

#### Scenario: Transfer to a non-member or a disabled account
- **WHEN** the owner transfers ownership to a user who is not a member of the team, and then to a
  member whose account is disabled
- **THEN** the first responds `404 Member not found`, the second responds `400`, and the owner is
  unchanged

#### Scenario: Delete blocks on shows
- **WHEN** the owner attempts to delete a team that still has shows
- **THEN** the request is rejected (same behavior as the existing admin-plane delete) and the
  team survives

#### Scenario: A removed member's session socket is closed
- **WHEN** an admin removes member M while M has a session WebSocket open in that team
- **THEN** after the removal commits M's socket is closed, its reconnect gets the masked `404`,
  and M's next HTTP request in that team is denied

#### Scenario: Demotion to member closes sockets without a grant
- **WHEN** the owner demotes admin A to member while A has session WebSockets open on a show A
  holds a grant for and on a show A holds none for
- **THEN** the socket on the ungranted show is closed and the socket on the granted show stays
  open
