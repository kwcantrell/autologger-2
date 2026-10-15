/**
 * Fake `navigator.wakeLock` (media-worker A.4). `deny` reproduces the headless refusal spike 0.3
 * saw in Chromium and WebKit (`NotAllowedError`); `systemRelease()` is the browser dropping the
 * lock when the page is hidden.
 */

export class FakeWakeLockSentinel extends EventTarget {
  released = false;
  readonly type = 'screen';

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

export class FakeWakeLock {
  deny = false;
  requests = 0;
  readonly sentinels: FakeWakeLockSentinel[] = [];

  async request(type: 'screen'): Promise<FakeWakeLockSentinel> {
    this.requests += 1;
    if (type !== 'screen') throw new TypeError('bad type');
    if (this.deny) {
      const err = new Error('Wake Lock permission request denied');
      err.name = 'NotAllowedError';
      throw err;
    }
    const s = new FakeWakeLockSentinel();
    this.sentinels.push(s);
    return s;
  }

  /** Locks currently held. */
  held(): FakeWakeLockSentinel[] {
    return this.sentinels.filter((s) => !s.released);
  }

  /** The browser releases every lock (page hidden). */
  async systemRelease(): Promise<void> {
    for (const s of this.held()) await s.release();
  }
}

/** A document stand-in whose visibility the test flips. */
export class FakeVisibilityDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';

  setVisibility(state: 'visible' | 'hidden'): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}
