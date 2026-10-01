import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeClock } from '../test/fakeClock';
import { PRESENCE_FRESH_MS, PresenceRegistry } from './presence';

describe('PresenceRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const meta = (sid: string, over: Partial<{ visible: boolean; is_playing: boolean }> = {}) => ({
    session_id: sid,
    visible: over.visible ?? true,
    is_playing: over.is_playing ?? false,
    updated: Date.now(),
  });

  it('every operation returns a promise (async-session-callers D2)', async () => {
    const r = new PresenceRegistry();
    const ops = [r.upsert('c1', meta('s1')), r.list(), r.remove('c1')];
    for (const op of ops) expect(op).toBeInstanceOf(Promise);
    await Promise.all(ops);
  });

  it('lists fresh entries and drops stale ones after 15s', async () => {
    const r = new PresenceRegistry();
    await r.upsert('c1', meta('s1'));
    expect(await r.list()).toHaveLength(1);
    vi.advanceTimersByTime(16_000);
    expect(await r.list()).toHaveLength(0);
  });

  it('upsert refreshes an existing client; remove deletes it', async () => {
    const r = new PresenceRegistry();
    await r.upsert('c1', meta('s1'));
    vi.advanceTimersByTime(10_000);
    await r.upsert('c1', meta('s2'));
    vi.advanceTimersByTime(10_000);
    expect(await r.list()).toEqual([expect.objectContaining({ session_id: 's2' })]);
    await r.remove('c1');
    expect(await r.list()).toHaveLength(0);
  });
});

// Relocated from session/fakeClock.test.ts (code-health-tail task 5.2) — this
// suite tests PresenceRegistry, so it lives beside it. Fake-clock determinism
// (de-cloudflare-strong-core task 5.4): freshness reads share the injected
// time base, so staleness is provable with zero real elapsed time.
describe('presence freshness with a fake clock (task 5.4)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('an entry goes stale once the fake clock passes the freshness window', async () => {
    const { clock, tick } = makeFakeClock();
    const reg = new PresenceRegistry(clock);
    await reg.upsert('tab-1', {
      session_id: 's1',
      visible: true,
      is_playing: false,
      updated: clock.now(),
    });
    expect(await reg.list()).toHaveLength(1);
    tick(PRESENCE_FRESH_MS);
    expect(await reg.list()).toHaveLength(1); // exactly at the window edge is still fresh
    tick(1);
    expect(await reg.list()).toHaveLength(0); // pruned as stale
  });
});
