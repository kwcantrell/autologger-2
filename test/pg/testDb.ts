// Per-test databases for the `pg` vitest project (catalog-pg-schema design D6): each call clones
// `autologger_template` (the migrated catalog) into a fresh database. Clones are never dropped:
// dropping is slow and the container is discarded at the end of the run.

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { inject } from 'vitest';

export interface TestPg {
  host: string;
  port: number;
  superPassword: string;
  appPassword: string;
  /** The container's id, for `docker logs` checks. */
  container: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    pg: TestPg;
  }
}

export interface ConnOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface TestDatabase {
  name: string;
  /** As `autologger_app`, the catalog's least-privilege role. */
  app: ConnOptions;
  /** As `postgres`, the migrations user (not a superuser). */
  admin: ConnOptions;
}

export function testPg() {
  return inject('pg');
}

export function connOptions(user: 'postgres' | 'autologger_app', database: string): ConnOptions {
  const pg = testPg();
  const password = user === 'postgres' ? pg.superPassword : pg.appPassword;
  return { host: pg.host, port: pg.port, user, password, database };
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `t_${randomBytes(8).toString('hex')}`;
  const admin = postgres({ ...connOptions('postgres', 'postgres'), max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${name} template autologger_template`);
  } finally {
    await admin.end();
  }
  return {
    name,
    app: connOptions('autologger_app', name),
    admin: connOptions('postgres', name),
  };
}
