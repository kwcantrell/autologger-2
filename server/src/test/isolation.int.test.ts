// Per-test isolation of the integration harness (harness.ts): every test starts from a pristine
// catalog database, an empty DATA_DIR and BLOB_DIR, and fresh bindings (hub registry, KV, every
// other port), whatever an earlier test in the same worker left behind. Each test below first
// asserts that pristine state, then dirties a different part of it; the two describes run the
// writers in both orders, and the file runs with the rest of the tier at its real concurrency.
// With the per-test reset disabled (a file-level env instead of a per-test one), 3 of the 4 tests
// fail: every one after the first in the file.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { env, testDatabase, testDirs } from './harness';
import { seededSession, seedUser, testDb } from './helpers';

const PROBE_EMAIL = 'isolation-probe@example.com';
const PROBE_KV_KEY = 'isolation-probe';

/** Every bindings object and port an earlier test in this file was given. */
const seenObjects = new Set<unknown>();
const seenDatabases = new Set<string>();
const seenDirs = new Set<string>();

function files(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => !e.isDirectory())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .sort();
}

function liveHubs(): number {
  return (env.ports.sessions as unknown as { hubs: Map<string, unknown> }).hubs.size;
}

/** Fails if anything an earlier test wrote is visible, then records this test's objects. */
async function expectPristine(): Promise<void> {
  const db = testDb();
  expect(await db.first('SELECT id FROM users WHERE email = ?', PROBE_EMAIL)).toBeNull();
  expect(await db.first<{ n: number }>('SELECT count(*)::int AS n FROM users')).toEqual({ n: 0 });
  expect(await db.first<{ n: number }>('SELECT count(*)::int AS n FROM sessions')).toEqual({
    n: 0,
  });
  expect(await env.ports.kv.get(PROBE_KV_KEY)).toBeNull();

  const { dataDir, blobDir } = testDirs();
  expect(files(dataDir).filter((f) => f.includes('probe'))).toEqual([]);
  expect(files(blobDir)).toEqual([]);
  expect(seenDirs.has(dataDir) || seenDirs.has(blobDir)).toBe(false);
  seenDirs.add(dataDir).add(blobDir);

  const { database } = testDatabase();
  expect(seenDatabases.has(database)).toBe(false);
  seenDatabases.add(database);

  expect(liveHubs()).toBe(0);
  // Every stateful port is a new object; the clock is the stateless system clock.
  const { clock: _clock, ...stateful } = env.ports;
  const objects = [env.ports, ...Object.values(stateful)];
  for (const o of objects) expect(seenObjects.has(o)).toBe(false);
  for (const o of objects) seenObjects.add(o);
}

/** Writes catalog rows, a KV entry and files in DATA_DIR and BLOB_DIR. */
async function dirtyStorage(): Promise<void> {
  await seedUser({ email: PROBE_EMAIL });
  await seededSession();
  await env.ports.kv.put(PROBE_KV_KEY, 'left behind');
  const { dataDir, blobDir } = testDirs();
  writeFileSync(join(dataDir, 'tmp', 'probe.txt'), 'left behind');
  mkdirSync(join(blobDir, 'audio', 'probe'), { recursive: true });
  writeFileSync(join(blobDir, 'audio', 'probe', 'probe.flac'), 'left behind');
}

/** Opens a live session hub (in-process registry state) and writes a KV entry. */
async function dirtyBindings(): Promise<void> {
  const { sessionId } = await seededSession();
  await env.ports.sessions.get(sessionId);
  expect(liveHubs()).toBe(1);
  await env.ports.kv.put(PROBE_KV_KEY, 'left behind by the hub test');
}

for (const [name, first, second] of [
  ['storage, then bindings', dirtyStorage, dirtyBindings],
  ['bindings, then storage', dirtyBindings, dirtyStorage],
] as const) {
  describe(`harness isolation: ${name}`, () => {
    it('first test starts pristine, then leaves state behind', async () => {
      await expectPristine();
      await first();
    });

    it('second test sees none of it, then leaves its own', async () => {
      await expectPristine();
      await second();
    });
  });
}
