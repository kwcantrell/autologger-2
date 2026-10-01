// Per-test databases for this package's `pg` project (postgres-catalog-adapter design D8): the
// package's own copy of test/pg/testDb.ts's helper, because a package may not import outside its
// src/ (the packages/* boundary test). The repo-level test/pg/globalSetup.ts starts the container
// and provides `pg`; each call clones `autologger_template` into a fresh database.

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { inject } from 'vitest';

interface TestPg {
  host: string;
  port: number;
  superPassword: string;
  appPassword: string;
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

export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = inject('pg');
  const name = `t_${randomBytes(8).toString('hex')}`;
  const conn = (user: string, password: string, database: string): ConnOptions => ({
    host: pg.host,
    port: pg.port,
    user,
    password,
    database,
  });
  const admin = postgres({ ...conn('postgres', pg.superPassword, 'postgres'), max: 1 });
  try {
    await admin.unsafe(`create database ${name} template autologger_template`);
  } finally {
    await admin.end();
  }
  return {
    name,
    app: conn('autologger_app', pg.appPassword, name),
    admin: conn('postgres', pg.superPassword, name),
  };
}
