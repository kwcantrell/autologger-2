// Test Postgres for the `integration` vitest project (catalog-on-postgres D6): the shared
// test/pg global setup, then two settings for THIS container only (the `pg` project's container
// keeps the defaults, which catalogSchema.pg.test.ts asserts):
// - A higher connection limit for the app role. Every integration test builds the server's own
//   catalog adapter (up to 12 connections: 3 root, 5 transaction and 4 session, session-tables D2;
//   14 with the Postgres frame bus's listener and publisher, session-frame-bus D7) and vitest runs
//   about 19 files at once, past the role's production limit of 45.
// - No disk flushes (fsync, synchronous_commit, full_page_writes off). Every test clones
//   autologger_template, about 10 MB of WAL each, and with ~19 files at once the clones queued on
//   WAL flushes (job 006: 18 ms of server time per clone at 16 at once, 6 ms without flushes).
//   Flushes only matter after a crash, and this container never outlives its run.
// Only a superuser may change these, so they run as supabase_admin on the container's local socket.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestProject } from 'vitest/node';
import sharedSetup from '../../../test/pg/globalSetup';

/** The app role's connection limit in this container (integrationConnectionBudget.ts). */
export const INTEGRATION_APP_ROLE_LIMIT = 280;

const SETTINGS = [
  `alter role autologger_app connection limit ${INTEGRATION_APP_ROLE_LIMIT}`,
  'alter system set fsync = off',
  'alter system set synchronous_commit = off',
  'alter system set full_page_writes = off',
  'select pg_reload_conf()',
];

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const teardown = await sharedSetup(project);
  try {
    const { container } = project.getProvidedContext().pg;
    const psql = `exec -u postgres ${container} psql -XqtA -v ON_ERROR_STOP=1 -U supabase_admin -d postgres`;
    const args = [...psql.split(' '), ...SETTINGS.flatMap((s) => ['-c', s])];
    await promisify(execFile)('docker', args);
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
