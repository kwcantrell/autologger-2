// The lease-hold helper (session-run-leases D3): claims a silent run lease through a caller-bound
// hub thunk and renews it on a timer until the run releases it. The thunk is re-resolved on every
// tick, so no hub reference is held idle and an evicted hub is harmless (async-session-hub D6).
// Renewal is a re-claim by the same holder (D2), so a row that lapsed during an outage and that
// nobody took is re-taken.

import { randomUUID } from 'node:crypto';
import { RUN_LEASE_RENEW_MS, type RunLeaseKind } from './leaseStore';
import type { SessionHubFacade } from './SessionHub';

/** This process's boot id: the middle part of every run holder id (owner decision 4). */
export const SERVER_BOOT_ID: string = randomUUID();

/** A run holder id, `srv:<boot id>:<uuid>`, unique per run (owner decision 4). */
export function newRunHolderId(): string {
  return `srv:${SERVER_BOOT_ID}:${randomUUID()}`;
}

/** A held run lease. `release` is memoized (every call returns the same promise) and never
 * rejects, because it runs in `finally` blocks whose original outcome must win (D3). */
export interface RunLeaseHold {
  release(): Promise<void>;
}

/** Claims `kind` once through `getHub()`: null when refused (no timer starts); a throw propagates,
 * so the caller frees its process slot (D4). On a win, renews every `renewMs` on an unref'd timer:
 * a tick is skipped while the previous one is pending, a refused renewal (another holder has a
 * live lease) logs once and stops the timer while the run continues (owner decision 2), and an
 * error is logged and retried on the next tick. `sessionId` only labels the log lines. */
export async function holdRunLease(opts: {
  getHub: () => Promise<SessionHubFacade>;
  kind: RunLeaseKind;
  renewMs?: number;
  log?: (msg: string, err?: unknown) => void;
  sessionId?: string;
}): Promise<RunLeaseHold | null> {
  const { getHub, kind } = opts;
  const log = opts.log ?? ((msg: string, err?: unknown) => console.error(msg, err ?? ''));
  const label = `${kind} ${opts.sessionId ?? ''}`.trimEnd();
  const holderId = newRunHolderId();
  if (!(await (await getHub()).claimRunLease(kind, holderId))) return null;

  let timer: ReturnType<typeof setInterval> | null = null;
  // The current renewal (`renew` never rejects) and whether it is still running; booleans, not
  // promise checks, decide (promiseHygiene.repo.test.ts).
  let pending: Promise<void> = Promise.resolve();
  let busy = false;
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const renew = async () => {
    try {
      const ok = await (await getHub()).claimRunLease(kind, holderId);
      if (!ok && timer !== null) {
        stop();
        log(`run lease lost: ${label}`);
      }
    } catch (err) {
      log(`run lease renewal failed: ${label}`, err);
    }
  };
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    pending = renew().finally(() => {
      busy = false;
    });
  }, opts.renewMs ?? RUN_LEASE_RENEW_MS);
  timer.unref?.();

  const doRelease = async () => {
    stop();
    await pending;
    try {
      await (await getHub()).releaseRunLease(kind, holderId);
    } catch (err) {
      log(`run lease release failed: ${label}`, err);
    }
  };
  let releasing = false;
  let released: Promise<void> = Promise.resolve();
  return {
    release() {
      if (!releasing) {
        releasing = true;
        released = doRelease();
      }
      return released;
    },
  };
}
