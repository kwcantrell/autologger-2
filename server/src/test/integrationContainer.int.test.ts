// The integration tier's own Postgres settings (pgIntegrationSetup.ts): the app role's raised
// connection limit, and no disk flushes, which keeps a per-test template clone cheap (job 006).
// The connection settings are the ones the tier's concurrency bound is budgeted against (job 004,
// integrationConnectionBudget.ts).

import { expect, it } from 'vitest';
import { MAX_CONNECTIONS } from '../../../test/pg/globalSetup';
import { testDb } from './helpers';
import {
  RESERVED_CONNECTIONS,
  SUPERUSER_RESERVED_CONNECTIONS,
} from './integrationConnectionBudget';
import { INTEGRATION_APP_ROLE_LIMIT } from './pgIntegrationSetup';

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
  expect(INTEGRATION_APP_ROLE_LIMIT).toBe(280);
});

it('has the connection slots the integration concurrency bound is budgeted against', async () => {
  const row = await testDb().first(
    `SELECT current_setting('max_connections')::int AS max_connections,
            current_setting('superuser_reserved_connections')::int AS superuser_reserved,
            current_setting('reserved_connections')::int AS reserved`,
  );
  expect(row).toEqual({
    max_connections: MAX_CONNECTIONS,
    superuser_reserved: SUPERUSER_RESERVED_CONNECTIONS,
    reserved: RESERVED_CONNECTIONS,
  });
});
