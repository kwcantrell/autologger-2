// The `integration` tier's connection budget: how many files may run at once against
// its container without passing the app role's limit or the server's max_connections, on any core
// count. vitest.config.ts sets INTEGRATION_MAX_WORKERS; vitestConfig.test.ts pins it at or under
// safeIntegrationMaxWorkers(), and integrationContainer.int.test.ts checks the container's
// settings against these numbers.

import { MAX_CONNECTIONS } from '../../../test/pg/globalSetup';
import { INTEGRATION_APP_ROLE_LIMIT } from './pgIntegrationSetup';

/** Connections only a superuser may take: Postgres's defaults, which the pinned image keeps
 * (`superuser_reserved_connections` 3, `reserved_connections` 0). */
export const SUPERUSER_RESERVED_CONNECTIONS = 3;
export const RESERVED_CONNECTIONS = 0;

/** The most app-role connections one integration file holds at once. A server's catalog adapter
 * opens up to 12 (PostgresCatalogDb's defaults: 3 root, 5 transaction, 4 session slots), 14 with
 * the Postgres frame bus's listener and publisher. The two heaviest files, frameBus.int.test.ts
 * and sessionWs.access.int.test.ts, each run the harness's adapter beside two server processes on
 * the bus: 12 + 2 × 14 = 40. The next heaviest hold two adapters and a raw client or one bus
 * (24 to 27). */
export const FILE_APP_CONNECTIONS = 40;

/** The most client connections of any role one file holds at once: its app-role connections, a
 * `postgres` admin client (frameBus.int.test.ts, auth.int.test.ts) and the `postgres` connection
 * the harness uses to clone the next test's database while this one runs (harness.ts). */
export const FILE_CLIENT_CONNECTIONS = FILE_APP_CONNECTIONS + 2;

/** Client connections that are not a test file's: a psql someone opens on the container to
 * watch it, the global setup's own psql (it finishes before any file starts). */
export const OTHER_CLIENT_CONNECTIONS = 3;

/** The client connections a non-superuser can get: the rest wait for a superuser. */
export const NON_SUPERUSER_CONNECTIONS =
  MAX_CONNECTIONS - SUPERUSER_RESERVED_CONNECTIONS - RESERVED_CONNECTIONS;

/** The most files that can run at once with every one of them at its worst. */
export function safeIntegrationMaxWorkers(): number {
  return Math.min(
    Math.floor(INTEGRATION_APP_ROLE_LIMIT / FILE_APP_CONNECTIONS),
    Math.floor((NON_SUPERUSER_CONNECTIONS - OTHER_CLIENT_CONNECTIONS) / FILE_CLIENT_CONNECTIONS),
  );
}
