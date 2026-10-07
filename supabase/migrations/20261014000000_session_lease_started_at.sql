-- Lease start times (ADR 0021 slice 9c, OpenSpec change `run-status-and-sweeper`, design D4).
--
-- - `catalog.session_leases` gains `started_at_ms`, the Clock-epoch time a run lease was claimed.
--   The run claim (`SessionCore.claimLeaseUncounted`) sets it, keeps it on a renewal by the same
--   holder, and resets it when another holder takes an expired row over. The transcript status
--   reads it to name the earliest live run (design D5).
-- - Nullable, no default, no backfill: pre-existing rows and recording rows keep null.
-- - No policy or grant changes: RLS is row-level, and the column follows the row's policies.
-- - Rollback (a documented step, not a migration file), after reverting the code:
--   `alter table catalog.session_leases drop column started_at_ms;`

alter table catalog.session_leases add column started_at_ms bigint;
