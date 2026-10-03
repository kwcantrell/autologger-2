// A promise-chain FIFO mutex (async-session-hub design D3; the async-catalog-adapter lock of ADR
// 0021 slice 3c). Acquirers are served in call order, and the lock itself never rejects: a holder
// that throws still releases, and its error reaches only its own caller.

export class FifoLock {
  /** Settles when the last acquirer releases; never rejects. */
  private tail: Promise<void> = Promise.resolve();

  /** Resolves with this acquirer's release function once every earlier acquirer has released. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.tail;
    this.tail = prev.then(() => held);
    return prev.then(() => release);
  }

  /** Runs `fn` while holding the lock and releases it however `fn` settles. */
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
