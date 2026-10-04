import type postgres from 'postgres';

// The role guards in the catalog migrations (20261001000000, 20261006000000) check the members of
// `catalog_user` and `catalog_system`, and roles are cluster-wide. `catalogRoles.pg.test.ts` creates
// scratch roles that are members of both, so a migration replay in another file running in
// parallel (`catalogSchema.pg.test.ts`, the session tables migration) can trip the guard. Both
// hold this session-level advisory lock on the `postgres` database while their roles or replay
// exist; it is released when the holding connection ends.
const ROLE_GUARD_LOCK = 7_2026_1006;

/** Takes the lock on `sql`, a dedicated one-connection client to the `postgres` database. */
export async function holdRoleGuardLock(sql: postgres.Sql): Promise<void> {
  await sql`select pg_advisory_lock(${ROLE_GUARD_LOCK})`;
}
