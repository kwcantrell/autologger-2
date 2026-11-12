// The integration tier's own Postgres settings (pgIntegrationSetup.ts): the app role's raised
// connection limit, and no disk flushes, which keeps a per-test template clone cheap (job 006).

import { expect, it } from 'vitest';
import { testDb } from './helpers';

it('runs on a container with the raised app-role limit and no disk flushes', async () => {
  const row = await testDb().first(
    `SELECT current_setting('fsync') AS fsync,
            current_setting('synchronous_commit') AS synchronous_commit,
            current_setting('full_page_writes') AS full_page_writes,
            (SELECT rolconnlimit FROM pg_roles WHERE rolname = 'autologger_app') AS limit`,
  );
  expect(row).toEqual({
    fsync: 'off',
    synchronous_commit: 'off',
    full_page_writes: 'off',
    limit: 280,
  });
});
