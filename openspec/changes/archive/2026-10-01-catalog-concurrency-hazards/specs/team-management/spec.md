## ADDED Requirements

### Requirement: Concurrent team writes
Every team write SHALL decide its outcome from the state it commits against, so concurrent
requests end as if they had run one after the other.

- **Admin re-check.** A team admin write (rename, delete, invite, revoke, role change, remove)
  SHALL re-check the caller's admin role inside the catalog transaction that performs the write.
  A caller demoted or removed by a concurrently committed request SHALL receive the status that
  check gives when run alone (`403`, or the masked `404`), and SHALL change nothing. The early
  role check stays, so the order of statuses (`401`, `404`, `403`, then validation `400`) is
  unchanged.
- **Creation.** The cap count, the team definition and the creator's admin membership SHALL be
  written in one transaction. Concurrent creates SHALL NOT take a user past the creation cap.
  Id validation, including the built-in reservation, SHALL come first. Then, inside the
  transaction:
  - an id that still has shows SHALL be refused with `400`;
  - any membership rows, pending invite rows and settings left under the id SHALL be removed
    before the creator is added, so a reused id starts with only its creator and default
    settings.

  The admin plane's team creation SHALL apply the same refusal and removal.
- **Invites.** The user lookup, the pending-invite cap and the grant or pending row SHALL be
  written in one transaction. Concurrent invites SHALL NOT take a team past the cap.
- **Role change.** A role change SHALL update an existing membership only. When the target is not
  a member when the change commits, the request SHALL get `404 Member not found`, and no
  membership SHALL be created.
- **Removal.** Removing a member SHALL check the membership inside the transaction that removes
  it. A removal whose target is already gone SHALL get `404`.
- **Show creation.** Creating a show SHALL check, inside its transaction, that the team exists
  (a defined team or a built-in one) and that the caller may use it. A show SHALL NOT be created
  for a team deleted concurrently; that request gets `400 Unknown studio id.`.
- **Admin plane.** The admin-plane membership add SHALL re-check the team inside its
  transaction. The admin plane's membership removal, account disable and membership upsert
  SHALL NOT be subject to last-admin protection (api-contract-freeze, "Admin add-membership role
  field"). A race between one of them and any team-plane demote, remove or leave SHALL end as
  some serial order of the two requests.
- **Cross-team independence.** Team-scoped reads and writes SHALL NOT make writes in another team
  fail. Concurrent writes in two different teams SHALL both succeed.

#### Scenario: A demoted admin's in-flight delete changes nothing
- **WHEN** admin B's team delete has passed its early role check, and admin A's demotion of B commits before B's delete transaction
- **THEN** B's request gets `403` and the team still exists

#### Scenario: Concurrent creates respect the cap
- **WHEN** a user who admins 19 non-built-in teams sends two team creates at the same time
- **THEN** exactly one succeeds and the other gets the cap `400`

#### Scenario: A reused team id starts empty
- **WHEN** an invite for team `acme` races the deletion of `acme`, and later another user creates a team `acme`
- **THEN** the new team has only its creator as a member, no pending invites, and default settings

#### Scenario: A built-in id is never purged
- **WHEN** a user tries to create a team with the built-in id `test-studios`
- **THEN** the request gets the existing `400`, and every existing `test-studios` membership is unchanged

#### Scenario: Writes in different teams don't conflict
- **WHEN** two users create two different teams at the same time, and two admins of two different teams invite at the same time
- **THEN** all four requests succeed

#### Scenario: Concurrent invites respect the pending cap
- **WHEN** a team holds 199 pending invites and two invites for different new emails arrive at the same time
- **THEN** exactly one is recorded and the other gets the cap `400`

#### Scenario: A promotion racing a removal does not resurrect the member
- **WHEN** an admin promotes member M while another admin removes M, and the removal commits first
- **THEN** the promotion gets `404 Member not found` and M has no membership

#### Scenario: A raced double removal
- **WHEN** two admins remove the same member at the same time
- **THEN** one gets `200` and the other gets `404`

#### Scenario: No show for a deleted team
- **WHEN** a show create for team T has passed its checks, and the deletion of T commits before the show is inserted
- **THEN** the show create gets `400 Unknown studio id.`, and no show references T
