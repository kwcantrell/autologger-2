// The `pg` and `integration` projects' file concurrency is an explicit bound, not one worker per
// core: the `pg` container keeps the app role's production connection limit of 45 (see
// PG_MAX_WORKERS in vitest.config.ts), and the `integration` container's 280 and max_connections
// fit only so many files at their worst (integrationConnectionBudget.ts).
import { describe, expect, it } from 'vitest';
import config, { INTEGRATION_MAX_WORKERS, PG_MAX_WORKERS } from '../../vitest.config';
import {
  FILE_APP_CONNECTIONS,
  FILE_CLIENT_CONNECTIONS,
  NON_SUPERUSER_CONNECTIONS,
  OTHER_CLIENT_CONNECTIONS,
  safeIntegrationMaxWorkers,
} from './integrationConnectionBudget';
import { INTEGRATION_APP_ROLE_LIMIT } from './pgIntegrationSetup';

type Project = { test?: Record<string, unknown> };
const projects = (config.test?.projects ?? []) as Project[];
const project = (name: string) => projects.find((p) => p.test?.name === name)?.test;

describe('the pg vitest project', () => {
  it('runs at most PG_MAX_WORKERS files at once, in its own group, whatever the core count', () => {
    expect(PG_MAX_WORKERS).toBe(2);
    if (process.env.SKIP_DB_TESTS === '1') return;
    const pg = project('pg');
    expect(pg?.maxWorkers).toBe(PG_MAX_WORKERS);
    expect(pg?.sequence).toEqual({ groupOrder: 2 });
  });
});

describe('the integration vitest project', () => {
  it('fits the files at their worst under both connection limits: at most 7 at once', () => {
    expect(INTEGRATION_APP_ROLE_LIMIT).toBe(280);
    expect(NON_SUPERUSER_CONNECTIONS).toBe(297);
    // 7 × 40 = 280 ≤ 280 and 7 × 42 + 3 = 297 ≤ 297; one more file passes both.
    const n = safeIntegrationMaxWorkers();
    expect({
      n,
      app: n * FILE_APP_CONNECTIONS,
      clients: n * FILE_CLIENT_CONNECTIONS + OTHER_CLIENT_CONNECTIONS,
    }).toEqual({ n: 7, app: 280, clients: 297 });
  });

  it('runs at most INTEGRATION_MAX_WORKERS files at once, within that budget, whatever the core count', () => {
    expect(Number.isInteger(INTEGRATION_MAX_WORKERS)).toBe(true);
    expect(INTEGRATION_MAX_WORKERS).toBeGreaterThanOrEqual(1);
    expect(INTEGRATION_MAX_WORKERS).toBeLessThanOrEqual(safeIntegrationMaxWorkers());
    if (process.env.SKIP_DB_TESTS === '1') return;
    const integration = project('integration');
    expect(integration?.maxWorkers).toBe(INTEGRATION_MAX_WORKERS);
    // vitest runs a project with its own maxWorkers in its own group (between unit and pg).
    expect(integration?.sequence).toEqual({ groupOrder: 1 });
    // The unit project sets no bound of its own and connects to no test container.
    expect(project('unit')?.maxWorkers).toBeUndefined();
  });
});
