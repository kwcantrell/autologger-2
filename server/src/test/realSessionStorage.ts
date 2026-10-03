// Session storage for the opt-in real AI tests (`*.real.test.ts`; session-tables D12): the session
// tables on the database the process's PG* settings name (the dev stack's shell has them), with
// the test session's catalog row created first. Test infrastructure.

import { PostgresCatalogDb, PostgresSessionDb } from '@autologger/storage';
import { TestRegistry } from './session/testHub';

export async function realSessionRegistry(
  sessionId: string,
): Promise<{ registry: TestRegistry; close(): Promise<void> }> {
  const env = process.env;
  const catalogDb = new PostgresCatalogDb({
    host: env.PGHOST ?? '',
    port: Number(env.PGPORT ?? 5432),
    user: env.PGUSER ?? '',
    password: env.PGPASSWORD ?? '',
    database: env.PGDATABASE ?? '',
  });
  await catalogDb
    .bindSystem('test-seed')
    .run('INSERT INTO sessions (id) VALUES (?) ON CONFLICT DO NOTHING', sessionId);
  const sessions = new PostgresSessionDb(catalogDb);
  // Storage members run as the harness caller (`TestRegistry`, session-content-policies D12).
  const registry = new TestRegistry({ storage: (id) => sessions.forSession(id) });
  return {
    registry,
    async close() {
      await registry.closeAll();
      await catalogDb.close();
    },
  };
}
