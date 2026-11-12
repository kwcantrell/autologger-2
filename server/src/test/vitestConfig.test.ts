// The `pg` project's file concurrency is an explicit bound, not one worker per core: its container
// keeps the app role's production connection limit of 45 (see PG_MAX_WORKERS in vitest.config.ts).
import { describe, expect, it } from 'vitest';
import config, { PG_MAX_WORKERS } from '../../vitest.config';

describe('the pg vitest project', () => {
  it('runs at most PG_MAX_WORKERS files at once, in its own group, whatever the core count', () => {
    expect(PG_MAX_WORKERS).toBe(2);
    if (process.env.SKIP_DB_TESTS === '1') return;
    const projects = (config.test?.projects ?? []) as { test?: Record<string, unknown> }[];
    const pg = projects.find((p) => p.test?.name === 'pg')?.test;
    expect(pg?.maxWorkers).toBe(PG_MAX_WORKERS);
    expect(pg?.sequence).toEqual({ groupOrder: 1 });
  });
});
