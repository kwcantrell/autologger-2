## MODIFIED Requirements

### Requirement: Session leases are stored in the catalog
Session leases SHALL be stored in `catalog.session_leases` (ADR 0021 slices 8a and 8b), with these
columns:
- `session_id`, non-null, referencing `catalog.sessions (id)` with no cascade;
- `kind`, non-null, checked by the named constraint `session_leases_kind_check` to one of
  `'recording'`, `'ai-turn'`, `'transcript-generation'` and `'youtube-import'` (slice 8b);
- `holder_client_id`, non-null, non-empty, at most 256 characters;
- `holder_user_id`, null only when a reviewed system task holds the lease;
- `heartbeat_at_ms` and `expires_at_ms`, non-null `bigint` epoch milliseconds read from the Clock
  port.

The primary key SHALL be `(session_id, kind)`, so a session has at most one lease of each kind.

Row-level security SHALL be enabled with these policies:
- `catalog_system` SHALL be allowed every command.
- `catalog_user` SHALL be allowed to select, insert, update and delete only rows of sessions in
  shows it can access.
- An inserted or updated row SHALL carry the user's own id as `holder_user_id`.
- `catalog_user` SHALL delete only rows it holds.
- The update policy's row filter SHALL be the access rule alone, without the holder. A refused or
  takeover claim written as `INSERT … ON CONFLICT DO UPDATE … WHERE` therefore skips or replaces
  the row instead of failing with `42501`.
- `anon`, `authenticated` and `public` SHALL have no privileges on the table.

Row-level security SHALL NOT be relied on to tie a live lease to its holder: the access rule cannot
judge expiry, so a user with access could rewrite a live lease to itself with a direct `UPDATE`. The
server's lease statements are the only writers, and they enforce the holder.

The migration that widens the kind check (slice 8b) SHALL change no row and no policy.

The migration that creates the table SHALL copy no lease. It SHALL leave the `lease_holder` and
`lease_seen_ms` meta rows unchanged.

#### Scenario: A user writes only leases held by itself
- **WHEN** a `catalog_user` binding for user U inserts a lease naming U, then one naming another
  user, then one in a session of a show U cannot access
- **THEN** the first succeeds, and the other two fail with `42501`

#### Scenario: A takeover claim needs no holder-scoped update
- **WHEN** user V runs the claim upsert against a lease held by user U, first while it is live and
  then after it expired
- **THEN** the first changes no row and raises no error, and the second replaces the row with V as
  holder

#### Scenario: A user cannot delete another user's lease
- **WHEN** a `catalog_user` binding for user V deletes a lease held by user U
- **THEN** no row is deleted

#### Scenario: RLS alone does not protect a live lease
- **WHEN** a `catalog_user` binding for user V runs a direct `UPDATE` setting itself as holder of a
  live lease held by user U, in a session V can access
- **THEN** the update succeeds; this is accepted, because only the server's statements write leases

#### Scenario: Only known kinds are stored
- **WHEN** `catalog_system` inserts a lease with kind `x`
- **THEN** the insert fails with `23514`

#### Scenario: The run kinds are stored
- **WHEN** a `catalog_user` binding for user U inserts leases of kinds `ai-turn`,
  `transcript-generation` and `youtube-import` naming U, in a session U can access
- **THEN** all three succeed, and their rows coexist with a `recording` lease of the same session
