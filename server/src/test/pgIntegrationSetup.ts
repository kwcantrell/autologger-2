// Test Postgres for the `integration` vitest project (catalog-on-postgres D6): the shared
// test/pg global setup, then a higher connection limit for the app role in THIS container only.
// Every integration test builds the server's own catalog adapter (up to 8 connections, the 4b
// defaults) and vitest runs about 19 files at once, past the role's production limit of 20. The
// `pg` project's container keeps 20, which catalogSchema.pg.test.ts asserts.

import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import sharedSetup from '../../../test/pg/globalSetup';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const teardown = await sharedSetup(project);
  try {
    const pg = project.getProvidedContext().pg;
    const admin = postgres({
      host: pg.host,
      port: pg.port,
      user: 'postgres',
      password: pg.superPassword,
      database: 'postgres',
      max: 1,
      onnotice: () => {},
    });
    try {
      await admin.unsafe('alter role autologger_app connection limit 200');
    } finally {
      await admin.end();
    }
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
