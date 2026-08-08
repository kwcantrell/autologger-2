// ai-runtime-package (task 2.1) — characterization of the shared kill
// ladder's two most load-bearing properties, PINNED at the level the ladder
// itself lives at (`processGroupKill.ts`), ahead of task 2.2's Clock
// threading:
//
//   1. `killProcessGroup` is documented "Never throws" and is awaited inside
//      two `finally` blocks (`aiTurn.ts`, `aiTurnOrchestrator.ts`) whose
//      REMAINING statements release a concurrency slot, abandon pending
//      questions, dispose an MCP turn token, and delete the copied-
//      credentials directory — a throw here is a real lifecycle regression,
//      not a test nicety.
//   2. The SIGTERM→SIGKILL escalation happens ONLY after the grace deadline
//      elapses — never early.
//
// Existing coverage before this file (`aiChatRunner.test.ts`'s
// "killAiChatProcessGroup — SIGTERM→SIGKILL ladder, no orphans" block) drives
// the ladder ONLY through `killAiChatProcessGroup` against REAL, live OS
// process groups (a compliant child, a SIGTERM-ignoring child escalated to
// SIGKILL, an already-exited child, a `pid: undefined` no-op, and a
// leader-exits/member-survives group-liveness case) — genuinely thorough for
// what it covers, but: (a) it never calls `processGroupKill.ts`'s own
// exports directly, only through the `aiChatRunner.ts` wrapper; (b) it never
// exercises `createDesignTurnSpawner(...).terminate` (`aiV2SdkSpawn.ts`), the
// AI-v2 path's consumer of the SAME ladder (see that file's own
// characterization addition); (c) it never tests a `pid: null` input
// (`undefined` only); (d) it cannot construct "an already-dead group" or "a
// group that never dies" as ISOLATED cases — a live child either was never
// alive or was actually killed, so these two inputs from the task brief have
// no prior coverage anywhere; (e) it never asserts the escalation timing
// property directly (SIGKILL not sent before the deadline) — the SIGKILL
// tests only prove escalation eventually happens, not that it didn't happen
// early.
//
// This file closes (c)-(e) with `process.kill` mocked (never a real spawn),
// using `vi.useFakeTimers()` — safe here because BOTH `Date.now()` (the
// deadline read) and the poll's `setTimeout(50)` are faked together by the
// SAME mechanism.
//
// ai-runtime-package (task 2.2) — `killProcessGroup` now takes a required,
// leading `clock: Clock`. The blocks below pass a plain real-time clock
// literal (reads `Date.now()`), which vitest's fake timers already intercept
// globally alongside `setTimeout` — so the "safe here" reasoning above still
// holds unchanged for them: that clock is not FROZEN independently of the
// timer queue.
//
// ai-runtime-package (task 2.4) — the hazard D3 names is a genuinely frozen
// INJECTED clock left beside the poll's real `setTimeout(50)`, which spins
// forever (a hung suite, not a failing test). The last block below closes it
// with the seam `killProcessGroup` now accepts: a fake `sleep` that advances
// the very fake clock the ladder's deadline reads. Both time dependencies
// then move under ONE test-controlled mechanism — with NO `vi.useFakeTimers()`
// anywhere, which is what keeps this remedy from stalling helpers awaited
// before the code under test (the `waitForPidFile` collision in
// `aiChatRunner.test.ts`).
//
// Both clocks are defined locally rather than importing
// `server/src/node/systemClock` or `server/src/test/fakeClock` (the former is
// composition-root-only by name; either would add an edge out of the AI
// runtime that it cannot keep once it moves to `packages/`).

import type { Clock } from '@autologger/ports';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killProcessGroup } from './processGroupKill';

const systemClock: Clock = { now: () => Date.now() };

/**
 * An injected clock whose ONLY time source is the ladder's own poll sleep:
 * `sleep(ms)` advances `now` by `ms` and resolves immediately. No real time
 * passes and no timer queue is involved, so the escalation instant is a pure
 * function of the injected clock — exactly the delta's "both the injected
 * clock and the poll's sleep under test control".
 */
function makeSleepDrivenClock(
  startMs = 1_700_000_000_000,
  maxPolls = 200,
): {
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  elapsed: () => number;
} {
  let now = startMs;
  let polls = 0;
  return {
    clock: { now: () => now },
    sleep: async (ms: number) => {
      // A ladder whose deadline stopped working would otherwise poll until
      // vitest's 5s per-test timeout — a slow, uninformative failure. This
      // makes "the loop never terminates" fail immediately and say so, which
      // is the whole point of bringing the sleep under test control.
      if (++polls > maxPolls) {
        throw new Error(`kill ladder polled ${polls} times without terminating`);
      }
      now += ms;
    },
    elapsed: () => now - startMs,
  };
}

function esrch(): NodeJS.ErrnoException {
  const err = new Error('No such process') as NodeJS.ErrnoException;
  err.code = 'ESRCH';
  return err;
}

describe('killProcessGroup — never throws, pinned against inputs that could plausibly break it (task 2.1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is a no-op and sends no signal for a null pid', async () => {
    const killSpy = vi.spyOn(process, 'kill');
    await expect(killProcessGroup(systemClock, null, 1000)).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('is a no-op and sends no signal for an undefined pid', async () => {
    const killSpy = vi.spyOn(process, 'kill');
    await expect(killProcessGroup(systemClock, undefined, 1000)).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('is a no-op for an already-dead group (the liveness probe throws ESRCH) — no SIGTERM sent', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch();
    });
    await expect(killProcessGroup(systemClock, 999999, 1000)).resolves.toBeUndefined();
    // Exactly the liveness probe (signal 0) — the ESRCH short-circuits
    // before any SIGTERM/SIGKILL would be sent.
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-999999, 0);
  });

  it('resolves without throwing for a group that never dies, even after the SIGKILL rung', async () => {
    vi.useFakeTimers();
    // Every probe/signal succeeds (no throw) and the group is reported
    // alive forever — the synthetic case a real, killable OS process cannot
    // model (a genuinely SIGKILL-proof group), which is exactly why the
    // pre-existing live-process suite has no equivalent case.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as unknown as never);
    const graceMs = 100;
    const promise = killProcessGroup(systemClock, 424242, graceMs);
    // Grace window, then the bounded 2000ms final wait after SIGKILL.
    await vi.advanceTimersByTimeAsync(graceMs + 2100);
    await expect(promise).resolves.toBeUndefined();
    const signals = killSpy.mock.calls.map((call) => call[1]);
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
  });

  it('never throws when the SIGKILL signal itself throws (raced-gone between the liveness check and the signal)', async () => {
    vi.useFakeTimers();
    let killCalls = 0;
    vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: string | number) => {
      killCalls += 1;
      if (signal === 'SIGKILL') throw esrch();
      return true;
      // biome-ignore lint/suspicious/noExplicitAny: matching Node's process.kill overload surface for the mock
    }) as any);
    const promise = killProcessGroup(systemClock, 777777, 50);
    await vi.advanceTimersByTimeAsync(50 + 2100);
    await expect(promise).resolves.toBeUndefined();
    expect(killCalls).toBeGreaterThan(0);
  });
});

describe('killProcessGroup — the SIGTERM→SIGKILL escalation happens only after the grace deadline elapses (task 2.1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not send SIGKILL before the grace window elapses while the group stays alive', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as unknown as never);
    const graceMs = 500;
    const promise = killProcessGroup(systemClock, 555555, graceMs);

    // Just short of the deadline: SIGTERM has been sent, but SIGKILL must
    // not have been yet.
    await vi.advanceTimersByTimeAsync(graceMs - 100);
    expect(killSpy.mock.calls.some((call) => call[1] === 'SIGTERM')).toBe(true);
    expect(killSpy.mock.calls.some((call) => call[1] === 'SIGKILL')).toBe(false);

    // Cross the deadline: escalation fires.
    await vi.advanceTimersByTimeAsync(200);
    expect(killSpy.mock.calls.some((call) => call[1] === 'SIGKILL')).toBe(true);

    // Drain the bounded final wait so the promise settles before the test ends.
    await vi.advanceTimersByTimeAsync(2100);
    await promise;
  });

  it('never escalates to SIGKILL when the group dies within the grace window', async () => {
    vi.useFakeTimers();
    let alive = true;
    vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 0) {
        if (!alive) throw esrch();
        return true;
      }
      if (signal === 'SIGTERM') {
        // The group dies shortly after SIGTERM — before the grace deadline.
        setTimeout(() => {
          alive = false;
        }, 20);
        return true;
      }
      return true;
      // biome-ignore lint/suspicious/noExplicitAny: matching Node's process.kill overload surface for the mock
    }) as any);
    const promise = killProcessGroup(systemClock, 333333, 1000);
    await vi.advanceTimersByTimeAsync(1100);
    await expect(promise).resolves.toBeUndefined();
  });
});

// ai-runtime-package (task 2.4) — the ladder driven with BOTH time
// dependencies under one test-controlled mechanism: the injected `Clock` and
// the poll's sleep, wired to each other (see `makeSleepDrivenClock`). No
// `vi.useFakeTimers()`, no real timer, no real elapsed time — so the
// escalation instant is a deterministic function of the injected clock, and
// the two mutations this block exists to catch (escalate immediately; never
// escalate) both fail it.
describe('killProcessGroup — deterministic under an injected clock whose only time source is the poll sleep (task 2.4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('escalates to SIGKILL exactly when the injected clock passes the grace deadline, with no real time elapsed', async () => {
    const { clock, sleep, elapsed } = makeSleepDrivenClock();
    // A group that never dies: every probe reports alive, every signal
    // succeeds. Real OS processes cannot model this; a real timer would make
    // it a 3-second test, and a frozen clock beside a real timer would make
    // it a HANG. Here it costs one event-loop turn per poll.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as unknown as never);
    let sigkillAtMs: number | null = null;
    killSpy.mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 'SIGKILL' && sigkillAtMs === null) sigkillAtMs = elapsed();
      return true;
      // biome-ignore lint/suspicious/noExplicitAny: matching Node's process.kill overload surface for the mock
    }) as any);

    const realStart = Date.now();
    await expect(killProcessGroup(clock, 424242, 1000, sleep)).resolves.toBeUndefined();
    const realElapsed = Date.now() - realStart;

    const signals = killSpy.mock.calls.map((call) => call[1]);
    expect(signals).toContain('SIGTERM');
    // Exactly at the deadline — one poll earlier (950) would mean escalating
    // early, and any later value would mean the deadline is not the trigger.
    expect(sigkillAtMs).toBe(1000);
    // …and the bounded post-SIGKILL wait is 2000ms of INJECTED time on top.
    expect(elapsed()).toBe(3000);
    // 3000ms of ladder time, none of it real: the seam's whole point.
    expect(realElapsed).toBeLessThan(500);
  });

  it('never escalates when the group dies before the deadline — the loop exits on the liveness probe, not the clock', async () => {
    const { clock, sleep, elapsed } = makeSleepDrivenClock();
    // Alive for the entry probe and the first two loop probes, then gone —
    // well inside the 1000ms grace window.
    let aliveProbes = 3;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: string | number,
    ) => {
      if (signal === 0) {
        if (aliveProbes-- <= 0) throw esrch();
        return true;
      }
      return true;
      // biome-ignore lint/suspicious/noExplicitAny: matching Node's process.kill overload surface for the mock
    }) as any);

    const realStart = Date.now();
    await expect(killProcessGroup(clock, 121212, 1000, sleep)).resolves.toBeUndefined();

    const signals = killSpy.mock.calls.map((call) => call[1]);
    expect(signals).toContain('SIGTERM');
    expect(signals).not.toContain('SIGKILL');
    // Two polls' worth of injected time — the loop stopped because the group
    // was gone, not because the deadline arrived.
    expect(elapsed()).toBe(100);
    expect(Date.now() - realStart).toBeLessThan(500);
  });
});
