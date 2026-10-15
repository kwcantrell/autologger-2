## MODIFIED Requirements

### Requirement: Email invites
Team admins and the owner SHALL invite people by email. Emails SHALL be normalized as
lowercase-trimmed exact strings — normalization performed in application code
(JS `toLowerCase().trim()`) identically at invite time and sign-in time, never via
SQL `lower()` (ASCII-only folding) — with no Gmail-style alias canonicalization.
Invite input SHALL be validated (plausible email shape, ≤254 chars). If the
normalized email matches the email of record of one or more existing user rows
(**including disabled accounts** — membership is inert while disabled and this
avoids unmaterializable pendings), `member` membership SHALL be granted immediately
to every matching user; a matching user who already holds membership is left
untouched (existing role preserved — an invite never changes a role, the owner's
included). If no user matches, a pending invite SHALL be
recorded (one per team+email; re-inviting is idempotent). **Pending-invite cap (DoS
control, gate ruling 2026-07-14):** a team SHALL hold at most 200 pending invites;
further invites are rejected `400`. Admins and the owner SHALL be able to list and revoke their
team's pending invites; revocation is idempotent (`200` whether or not the invite
existed); a revoked invite never materializes. A pending invite does not let a new email create
an account while sign-ups are closed.

At first Google sign-in that creates an account (while sign-ups are closed, only for an approved
email or the bootstrap owner's; api-contract-freeze "Closed sign-up redirect"), the OAuth
callback's new-user branch SHALL materialize
pending invites matching the new user's normalized email into `member` memberships
— **only when the presented id_token carries `email_verified: true`** (the email
claim is an authorization join key here; unverified emails SHALL NOT match
invites) — atomically with user creation, deleting the consumed invite rows.
Existing sign-ins SHALL NOT re-scan invites. Accepted residual: an invite addressed
to a person whose existing account carries a different email of record never
converts or materializes; it remains visible in the pending list, revocable, and
the admin's remedy is to re-invite the address the account actually uses.

#### Scenario: Invite an existing user
- **WHEN** an admin invites an email that (after normalization) belongs to an
  existing user
- **THEN** that user immediately has `member` membership, no pending invite is
  stored, and the user sees the team on their next profile fetch

#### Scenario: Inviting an existing member is a no-op
- **WHEN** an admin invites the email of a user who is already a member — including
  the team's owner
- **THEN** the request succeeds with no change to the existing membership or role
  (the owner is not demoted)

#### Scenario: Invite before first sign-in
- **WHEN** an admin invites `New.Person@Example.com`, and later a Google account
  whose verified email normalizes to `new.person@example.com` signs in for the
  first time
- **THEN** the created user starts with `member` membership of the inviting team,
  and the pending invite row is consumed

#### Scenario: Unverified email never materializes
- **WHEN** a first-time sign-in presents an id_token whose `email_verified` claim
  is absent or false, and pending invites exist for that email
- **THEN** the user is created without those memberships and the pending invites
  remain (available to materialize on a later verified sign-in of that address, or
  to be revoked)

#### Scenario: Revoked invite never lands
- **WHEN** an admin revokes a pending invite before the invitee's first sign-in,
  and the invitee then signs in
- **THEN** the new user has no membership of that team

#### Scenario: An invite does not open closed sign-ups
- **WHEN** sign-ups are closed, an admin invites `new.person@example.com`, and a Google account
  with that verified email but no approval signs in for the first time
- **THEN** the callback responds `302` to `/?login_error=signup_closed`, no account is created,
  and the pending invite remains
