// The hub's FIFO lock (async-session-hub design D3): acquirers are served in call order, a holder
// that throws still releases, and the lock never rejects. An unhandled rejection fails the file;
// every "promptly" case races a 200 ms timer.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FifoLock } from './fifoLock';

const unhandled: unknown[] = [];
const trap = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeAll(() => {
  process.on('unhandledRejection', trap);
});
afterAll(() => {
  process.off('unhandledRejection', trap);
  expect(unhandled).toEqual([]);
});

/** Settles as `p` does, or rejects if `p` takes longer than 200 ms. */
function promptly<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('not settled within 200 ms')), 200);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

describe('FifoLock', () => {
  it('serves 500 mixed acquisitions one at a time in call order', async () => {
    const lock = new FifoLock();
    const order: number[] = [];
    let holders = 0;
    let maxHolders = 0;
    const enter = (i: number) => {
      holders++;
      maxHolders = Math.max(maxHolders, holders);
      order.push(i);
    };
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 500; i++) {
      switch (i % 5) {
        case 0: // synchronous body
          jobs.push(
            lock.run(() => {
              enter(i);
              holders--;
            }),
          );
          break;
        case 1: // body awaiting microtasks
          jobs.push(
            lock.run(async () => {
              enter(i);
              await Promise.resolve();
              await Promise.resolve();
              holders--;
            }),
          );
          break;
        case 2: // body awaiting a timer
          jobs.push(
            lock.run(async () => {
              enter(i);
              await new Promise((resolve) => setTimeout(resolve, 0));
              holders--;
            }),
          );
          break;
        case 3: // body that throws after an await
          jobs.push(
            lock
              .run(async () => {
                enter(i);
                await Promise.resolve();
                holders--;
                throw new Error(`job ${i}`);
              })
              .catch(() => {}),
          );
          break;
        default: // raw acquire/release
          jobs.push(
            lock.acquire().then((release) => {
              enter(i);
              holders--;
              release();
            }),
          );
      }
    }
    await Promise.all(jobs);
    expect(order).toEqual(Array.from({ length: 500 }, (_, i) => i));
    expect(maxHolders).toBe(1);
  });

  it("releases when the holder throws; the error reaches only the holder's caller", async () => {
    const lock = new FifoLock();
    const boom = new Error('boom');
    const failing = lock.run(() => {
      throw boom;
    });
    const next = lock.run(() => 'next');
    await expect(promptly(failing)).rejects.toBe(boom);
    await expect(promptly(next)).resolves.toBe('next');
  });

  it('never rejects an acquirer, even after holders failed', async () => {
    const lock = new FifoLock();
    const failures = Array.from({ length: 3 }, () =>
      lock
        .run(async () => {
          throw new Error('x');
        })
        .catch(() => {}),
    );
    const release = await promptly(lock.acquire());
    release();
    await Promise.all(failures);
    await expect(promptly(lock.run(() => 1))).resolves.toBe(1);
  });
});
