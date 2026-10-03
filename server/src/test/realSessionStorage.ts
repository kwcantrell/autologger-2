// Session storage for the opt-in real AI tests (`*.real.test.ts`; session-tables D12): the session
// tables on the database the process's PG* settings name (the dev stack's shell has them), with
// the test session's catalog row created first. Test infrastructure.

import { SessionHubRegistry } from '@autologger/session-core';
import { PostgresCatalogDb, PostgresSessionDb } from '@autologger/storage';

export async function realSessionRegistry(
  sessionId: string,
): Promise<{ registry: SessionHubRegistry; close(): Promise<void> }> {
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
  const sessions = new PostgresSessionDb(catalogDb.bindSystem('session-hub'));
  const registry = new SessionHubRegistry({ storage: (id) => sessions.forSession(id) });
  return {
    registry,
    async close() {
      await registry.closeAll();
      await catalogDb.close();
    },
  };
}
