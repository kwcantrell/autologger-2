import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type postgres from 'postgres';

// session-frame-bus D7/D8 (ADR 0021 slice 9a): the connection-limit migration and a deterministic
// read of the app role it sets. Roles are cluster-wide and `pg` files run in parallel, so no file
// may commit a change to the app role's connection limit: the catalog schema migration sets it to
// 20, and while a replay of it is committed every other file's `autologger_app` connections are
// refused past 20 ("too many connections for role"). Replays go through `replayMigration`, which
// puts the limit back in the migration's own transaction, and reads of what a migration sets go
// through `readInRolledBackTransaction`: the read sees that transaction's own update, and the role
// is left as the template run set it. Unlocked concurrent `ALTER ROLE`s on one role can fail with
// "tuple concurrently updated", so both retry once on that error.

export const CONNECTION_LIMIT_MIGRATION = resolve(
  import.meta.dirname,
  '../../../../supabase/migrations/20261013000000_app_role_connection_limit.sql',
);

class RolledBack<T> {
  constructor(readonly value: T) {}
}

function concurrentlyUpdated(err: unknown): boolean {
  return /tuple concurrently updated/.test(String(err));
}

/** Runs `body` in one transaction on `sql`, rolls it back, and returns what `body` returned. */
export async function readInRolledBackTransaction<T>(
  sql: postgres.Sql,
  body: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql.begin(async (tx) => {
        throw new RolledBack(await body(tx));
      });
    } catch (err) {
      if (err instanceof RolledBack) return err.value as T;
      if (attempt < 2 && concurrentlyUpdated(err)) continue;
      throw err;
    }
    throw new Error('unreachable: the transaction always rolls back');
  }
}

/** Runs the connection-limit migration and `read` in one rolled-back transaction on `sql`. */
export async function readAppRoleWithLimitMigration<T>(
  sql: postgres.Sql,
  read: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const text = readFileSync(CONNECTION_LIMIT_MIGRATION, 'utf8');
  return readInRolledBackTransaction(sql, async (tx) => {
    await tx.unsafe(text);
    return read(tx);
  });
}

async function appRoleLimit(tx: postgres.TransactionSql): Promise<number | undefined> {
  const [r] = await tx`select rolconnlimit from pg_roles where rolname = 'autologger_app'`;
  return r ? Number(r.rolconnlimit) : undefined;
}

/** Runs one migration file's text in one committed transaction on `sql`, as migrate.sh does, but
 * puts the app role's connection limit back as it was before committing, so the cluster-wide
 * limit other files connect under never changes. */
export async function replayMigration(sql: postgres.Sql, text: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql.begin(async (tx) => {
        const before = await appRoleLimit(tx);
        await tx.unsafe(text);
        const after = await appRoleLimit(tx);
        if (before !== undefined && after !== before) {
          await tx.unsafe(`alter role autologger_app connection limit ${before}`);
        }
      });
      return;
    } catch (err) {
      if (attempt < 2 && concurrentlyUpdated(err)) continue;
      throw err;
    }
  }
}
