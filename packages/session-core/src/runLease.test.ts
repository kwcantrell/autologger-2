import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunLeaseKind } from './leaseStore';
import { holdRunLease, newRunHolderId, SERVER_BOOT_ID } from './runLease';
import type { SessionHubFacade } from './SessionHub';

// The lease-hold helper (session-run-leases D3) over a stub hub: the claim, the renewal timer,
// its skip/stop/retry rules, and the memoized never-rejecting release. The database cases (a
// 180 s hold, a lapsed row re-taken, an evicted hub) run against Postgres in
// server/src/test/session/runLease.int.test.ts.

type Call = { op: 'claim' | 'release'; kind: RunLeaseKind; holderId: string };

/** A stub hub whose next claims answer from `answers` (a value, an Error to throw, or a promise
 * the test settles); once `answers` is empty a claim wins. */
function stubHub() {
  const calls: Call[] = [];
  const answers: (boolean | Error | Promise<boolean>)[] = [];
  let releaseAnswer: Error | null = null;
  const hub = {
    claimRunLease: async (kind: RunLeaseKind, holderId: string) => {
      calls.push({ op: 'claim', kind, holderId });
      const a = answers.length > 0 ? answers.shift() : true;
      if (a instanceof Error) throw a;
      return a as boolean | Promise<boolean>;
    },
    releaseRunLease: async (kind: RunLeaseKind, holderId: string) => {
      calls.push({ op: 'release', kind, holderId });
      if (releaseAnswer) throw releaseAnswer;
    },
  } as unknown as SessionHubFacade;
  return {
    hub,
    calls,
    answers,
    claims: () => calls.filter((c) => c.op === 'claim').length,
    releases: () => calls.filter((c) => c.op === 'release').length,
    failRelease: (e: Error) => {
      releaseAnswer = e;
    },
  };
}

/** A deferred boolean the test settles. */
function deferred() {
  let resolve!: (v: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('holdRunLease (session-run-leases D3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a won claim renews every renewMs as the same holder, until release', async () => {
    const s = stubHub();
    const log = vi.fn();
    const hold = await holdRunLease({ getHub: async () => s.hub, kind: 'ai-turn', log });
    expect(hold).not.toBeNull();
    expect(s.claims()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.claims()).toBe(4);
    const holders = new Set(s.calls.map((c) => c.holderId));
    expect(holders.size).toBe(1);
    expect([...holders][0]).toMatch(new RegExp(`^srv:${SERVER_BOOT_ID}:`));
    await hold?.release();
    expect(s.calls.at(-1)).toEqual({ op: 'release', kind: 'ai-turn', holderId: [...holders][0] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.claims()).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('a refused claim gives null and starts no timer', async () => {
    const s = stubHub();
    s.answers.push(false);
    const before = vi.getTimerCount();
    expect(
      await holdRunLease({ getHub: async () => s.hub, kind: 'youtube-import', renewMs: 1_000 }),
    ).toBeNull();
    expect(vi.getTimerCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.calls).toHaveLength(1);
  });

  it('a claim that throws propagates and starts no timer', async () => {
    const s = stubHub();
    s.answers.push(new Error('db down'));
    await expect(
      holdRunLease({ getHub: async () => s.hub, kind: 'ai-turn', renewMs: 1_000 }),
    ).rejects.toThrow('db down');
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      holdRunLease({
        getHub: () => Promise.reject(new Error('no hub')),
        kind: 'ai-turn',
        renewMs: 1_000,
      }),
    ).rejects.toThrow('no hub');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a refused renewal logs once and stops the timer; the hold still releases', async () => {
    const s = stubHub();
    const log = vi.fn();
    const hold = await holdRunLease({
      getHub: async () => s.hub,
      kind: 'transcript-generation',
      renewMs: 1_000,
      log,
    });
    s.answers.push(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.claims()).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/^run lease lost: transcript-generation/);
    expect(vi.getTimerCount()).toBe(0);
    await hold?.release();
    expect(s.releases()).toBe(1);
  });

  it('an error is logged and retried on the next tick', async () => {
    const s = stubHub();
    const log = vi.fn();
    let hubFails = false;
    const hold = await holdRunLease({
      getHub: async () => {
        if (hubFails) throw new Error('hub gone');
        return s.hub;
      },
      kind: 'ai-turn',
      renewMs: 1_000,
      log,
    });
    s.answers.push(new Error('deadlock'), new Error('timeout'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.claims()).toBe(3);
    hubFails = true;
    await vi.advanceTimersByTimeAsync(1_000);
    hubFails = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.claims()).toBe(5);
    expect(log).toHaveBeenCalledTimes(3);
    for (const [, err] of log.mock.calls) expect(err).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(1);
    await hold?.release();
  });

  it('ticks never overlap: a tick is skipped while the previous renewal is pending', async () => {
    const s = stubHub();
    const hold = await holdRunLease({ getHub: async () => s.hub, kind: 'ai-turn', renewMs: 1_000 });
    const slow = deferred();
    s.answers.push(slow.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.claims()).toBe(2); // the first renewal is still pending; four ticks skipped
    slow.resolve(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.claims()).toBe(3);
    await hold?.release();
  });

  it('release() is memoized, waits for a pending renewal, and never rejects', async () => {
    const s = stubHub();
    const log = vi.fn();
    const hold = await holdRunLease({
      getHub: async () => s.hub,
      kind: 'youtube-import',
      renewMs: 1_000,
      log,
    });
    const slow = deferred();
    s.answers.push(slow.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.claims()).toBe(2);
    s.failRelease(new Error('release failed'));
    const first = hold?.release();
    const second = hold?.release();
    expect(Object.is(second, first)).toBe(true); // the same promise, not a second release
    await vi.advanceTimersByTimeAsync(0);
    expect(s.releases()).toBe(0); // waits for the pending renewal
    slow.resolve(true);
    await expect(first).resolves.toBeUndefined();
    expect(s.releases()).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toEqual(new Error('release failed'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.claims()).toBe(2);
    // A hub that cannot be resolved at release time is logged too, not thrown.
    const t = stubHub();
    let gone = false;
    const other = await holdRunLease({
      getHub: async () => {
        if (gone) throw new Error('no hub');
        return t.hub;
      },
      kind: 'ai-turn',
      log,
    });
    gone = true;
    await expect(other?.release()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe('newRunHolderId (session-run-leases D3, owner decision 4)', () => {
  it('is srv:<boot id>:<uuid>, unique across 1000 calls', () => {
    expect(SERVER_BOOT_ID).toMatch(/^[0-9a-f-]{36}$/);
    const ids = Array.from({ length: 1000 }, () => newRunHolderId());
    for (const id of ids) {
      expect(id.startsWith(`srv:${SERVER_BOOT_ID}:`)).toBe(true);
      expect(id.slice(`srv:${SERVER_BOOT_ID}:`.length)).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(new Set(ids).size).toBe(1000);
  });
});
