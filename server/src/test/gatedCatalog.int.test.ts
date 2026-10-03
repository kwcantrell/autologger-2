// Self-test of the gated catalog seam (catalog-concurrency-hazards D1).

import { describe, expect, it } from 'vitest';
import { GatedCatalog } from './gatedCatalog';
import { env } from './harness';
import { testDb } from './helpers';

const pendingAfter = async (p: Promise<unknown>, ms = 50) => {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
};

describe('GatedCatalog', () => {
  it('holds a matching statement until released while other work commits', async () => {
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.hold(/INSERT INTO app_settings/);
    const held = gated.tx(async (t) => {
      await t.run(
        "INSERT INTO app_settings (key, value) VALUES ('gate-a', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      );
      return t.first<{ value: string }>("SELECT value FROM app_settings WHERE key = 'gate-b'");
    });
    await h.reached;
    expect(await pendingAfter(held)).toBe(true);
    // Another writer commits meanwhile, through the ungated catalog.
    await testDb().run("INSERT INTO app_settings (key, value) VALUES ('gate-b', 'x')");
    h.release();
    // The transaction's snapshot is taken by its role preamble, right after BEGIN and before the
    // held statement (catalog-roles D4), so it does not see the row committed meanwhile; both
    // writes commit.
    expect(await held).toBeNull();
    expect(
      await testDb().all(
        "SELECT key FROM app_settings WHERE key IN ('gate-a', 'gate-b') ORDER BY key",
      ),
    ).toEqual([{ key: 'gate-a' }, { key: 'gate-b' }]);
  });

  it('is one-shot: a later matching statement, as in a re-run body, passes', async () => {
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.hold(/SELECT 1/);
    const first = gated.first('SELECT 1 AS n');
    await h.reached;
    h.release();
    await first;
    expect(await gated.first('SELECT 1 AS n')).toEqual({ n: 1 });
  });
});
