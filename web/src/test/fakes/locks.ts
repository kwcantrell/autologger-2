/**
 * Fake Web Locks (media-worker A.2): one registry is the origin, `tab()` hands out a
 * `LockManager`-shaped object per tab. Exclusive locks only (all the recorder uses); a request
 * with `ifAvailable` gets `null` while any tab (the same one included: locks are not re-entrant)
 * holds the name, as spike 0.3 observed across tabs in Chromium, Firefox and WebKit.
 */

type Callback = (lock: { name: string } | null) => unknown;

export interface FakeLockManager {
  request(name: string, options: { ifAvailable?: boolean }, callback: Callback): Promise<unknown>;
}

export class FakeLockRegistry {
  private readonly held = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  isHeld(name: string): boolean {
    return this.held.has(name);
  }

  heldNames(): string[] {
    return Array.from(this.held).sort();
  }

  tab(): FakeLockManager {
    return {
      request: (name, options, callback) => this.request(name, options, callback),
    };
  }

  private async request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: Callback,
  ): Promise<unknown> {
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(name) ?? [];
        list.push(resolve);
        this.waiters.set(name, list);
      });
    }
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
      const next = this.waiters.get(name)?.shift();
      if (next) next();
    }
  }
}
