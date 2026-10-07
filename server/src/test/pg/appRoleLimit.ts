import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type postgres from 'postgres';

// session-frame-bus D7/D8 (ADR 0021 slice 9a): the connection-limit migration and a deterministic
// read of the app role it sets. Roles are cluster-wide, and `teamOwner.pg.test.ts` replays the
// catalog schema migration (`connection limit 20`) in a parallel file without any lock, so the
// migration is re-applied and the role read in one transaction: the read sees that transaction's
// own update. The transaction is rolled back, so the role is left as the template run set it.
// Unlocked concurrent `ALTER ROLE`s on one role can fail with "tuple concurrently updated", so the
// transaction is retried once on that error.

export const CONNECTION_LIMIT_MIGRATION = resolve(
  import.meta.dirname,
  '../../../../supabase/migrations/20261013000000_app_role_connection_limit.sql',
);

class RolledBack<T> {
  constructor(readonly value: T) {}
}

/** Runs the connection-limit migration and `read` in one rolled-back transaction on `sql`. */
export async function readAppRoleWithLimitMigration<T>(
  sql: postgres.Sql,
  read: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const text = readFileSync(CONNECTION_LIMIT_MIGRATION, 'utf8');
  for (let attempt = 1; ; attempt++) {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        throw new RolledBack(await read(tx));
      });
    } catch (err) {
      if (err instanceof RolledBack) return err.value as T;
      if (attempt < 2 && /tuple concurrently updated/.test(String(err))) continue;
      throw err;
    }
    throw new Error('unreachable: the transaction always rolls back');
  }
}
