/**
 * Minimal in-memory IndexedDB for tests (media-worker A.1): `open` with `onupgradeneeded`,
 * object stores with a string `keyPath`, `put`/`get`/`getAll(range)`/`delete(key | range)`,
 * transactions that complete after their requests and roll back on a failed request, and
 * `IDBKeyRange.bound`. Requests settle on a microtask, like the real thing (never synchronously).
 * Switches reproduce the failure modes spike 0.3 observed (ephemeral WebKit: a `Blob` put fails).
 */

type Key = string;

export class FakeKeyRange {
  private constructor(
    readonly lower: Key,
    readonly upper: Key,
    readonly lowerOpen: boolean,
    readonly upperOpen: boolean,
  ) {}

  static bound(lower: Key, upper: Key, lowerOpen = false, upperOpen = false): FakeKeyRange {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }

  static only(key: Key): FakeKeyRange {
    return new FakeKeyRange(key, key, false, false);
  }

  includes(key: Key): boolean {
    const aboveLower = this.lowerOpen ? key > this.lower : key >= this.lower;
    const belowUpper = this.upperOpen ? key < this.upper : key <= this.upper;
    return aboveLower && belowUpper;
  }
}

class FakeRequest<T = unknown> {
  result: T | undefined = undefined;
  error: Error | null = null;
  onsuccess: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onupgradeneeded: ((ev: unknown) => void) | null = null;
  onblocked: ((ev: unknown) => void) | null = null;
}

class FakeObjectStore {
  constructor(
    readonly name: string,
    readonly keyPath: string,
    readonly rows: Map<Key, unknown>,
    private readonly tx: FakeTransaction,
  ) {}

  private keyOf(value: unknown): Key {
    return String((value as Record<string, unknown>)[this.keyPath]);
  }

  put(value: unknown): FakeRequest<Key> {
    return this.tx.run(() => {
      if (this.tx.db.factory.failBlobPut && containsBlob(value)) {
        throw new Error(
          'UnknownError: Error preparing Blob/File data to be stored in object store',
        );
      }
      const key = this.keyOf(value);
      this.rows.set(key, value);
      return key;
    });
  }

  get(key: Key): FakeRequest<unknown> {
    return this.tx.run(() => this.rows.get(key));
  }

  getAll(range?: FakeKeyRange): FakeRequest<unknown[]> {
    return this.tx.run(() =>
      Array.from(this.rows.keys())
        .filter((k) => !range || range.includes(k))
        .sort()
        .map((k) => this.rows.get(k)),
    );
  }

  delete(keyOrRange: Key | FakeKeyRange): FakeRequest<undefined> {
    return this.tx.run(() => {
      for (const k of Array.from(this.rows.keys())) {
        if (keyOrRange instanceof FakeKeyRange ? keyOrRange.includes(k) : k === keyOrRange) {
          this.rows.delete(k);
        }
      }
      return undefined;
    });
  }
}

function containsBlob(value: unknown): boolean {
  if (value instanceof Blob) return true;
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => v instanceof Blob);
  }
  return false;
}

class FakeTransaction {
  oncomplete: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onabort: ((ev: unknown) => void) | null = null;
  error: Error | null = null;
  private pending = 0;
  private finished = false;
  private readonly snapshot = new Map<string, Map<Key, unknown>>();

  constructor(
    readonly db: FakeDatabase,
    readonly storeNames: string[],
  ) {
    for (const name of storeNames) {
      const store = db.stores.get(name);
      if (!store) throw new Error(`NotFoundError: no object store ${name}`);
      this.snapshot.set(name, new Map(store.rows));
    }
    // A transaction with no requests still completes.
    queueMicrotask(() => this.maybeComplete());
  }

  objectStore(name: string): FakeObjectStore {
    const store = this.db.stores.get(name);
    if (!store || !this.storeNames.includes(name)) {
      throw new Error(`NotFoundError: ${name} not in transaction`);
    }
    return new FakeObjectStore(name, store.keyPath, store.rows, this);
  }

  run<T>(fn: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pending += 1;
    queueMicrotask(() => {
      this.pending -= 1;
      if (this.finished) return;
      try {
        request.result = fn();
        request.onsuccess?.({ target: request });
      } catch (err) {
        request.error = err as Error;
        request.onerror?.({ target: request });
        this.abort(err as Error);
        return;
      }
      queueMicrotask(() => this.maybeComplete());
    });
    return request;
  }

  private abort(err: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.error = err;
    for (const [name, rows] of this.snapshot) {
      const store = this.db.stores.get(name);
      if (store) store.rows = new Map(rows);
    }
    this.onerror?.({ target: this });
    this.onabort?.({ target: this });
  }

  private maybeComplete(): void {
    if (this.finished || this.pending > 0) return;
    this.finished = true;
    this.oncomplete?.({ target: this });
  }
}

class FakeDatabase {
  readonly stores = new Map<string, { keyPath: string; rows: Map<Key, unknown> }>();
  constructor(
    readonly name: string,
    public version: number,
    readonly factory: FakeIdbFactory,
  ) {}

  get objectStoreNames() {
    const names = Array.from(this.stores.keys());
    return { contains: (n: string) => names.includes(n), length: names.length };
  }

  createObjectStore(name: string, opts: { keyPath: string }): void {
    this.stores.set(name, { keyPath: opts.keyPath, rows: new Map() });
  }

  transaction(names: string | string[], _mode?: 'readonly' | 'readwrite'): FakeTransaction {
    return new FakeTransaction(this, Array.isArray(names) ? names : [names]);
  }

  close(): void {}
}

/** Stand-in for `indexedDB`; pass `factory` and `FakeKeyRange` to the backend under test. */
export class FakeIdbFactory {
  /** `open()` fails (IndexedDB disabled). */
  failOpen = false;
  /** Any `put` of a value carrying a `Blob` fails (ephemeral WebKit, spike 0.3). */
  failBlobPut = false;
  readonly databases = new Map<string, FakeDatabase>();

  open(name: string, version = 1): FakeRequest<FakeDatabase> {
    const request = new FakeRequest<FakeDatabase>();
    queueMicrotask(() => {
      if (this.failOpen) {
        request.error = new Error('InvalidStateError: IndexedDB unavailable');
        request.onerror?.({ target: request });
        return;
      }
      let db = this.databases.get(name);
      const upgrading = !db || db.version < version;
      if (!db) {
        db = new FakeDatabase(name, version, this);
        this.databases.set(name, db);
      }
      request.result = db;
      if (upgrading) {
        db.version = version;
        request.onupgradeneeded?.({ target: request });
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  /** Test helper: every key of a store. */
  keys(dbName: string, store: string): string[] {
    return Array.from(this.databases.get(dbName)?.stores.get(store)?.rows.keys() ?? []).sort();
  }
}
