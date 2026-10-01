// KvStore port (spec: core-ports-architecture): the value-based KV over the
// catalog `kv` table today (`server/src/node/kvStore.ts`'s `KvStore` class) —
// login sessions, OAuth CSRF, Companion last_command. Async so a networked backend can replace
// SQLite without changing call sites (ADR 0021 slice 3, async-session-callers D2).

export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** Removes and returns a live entry in one atomic step; `null` if missing or expired
   * (async-catalog-stores D4: one-shot credentials such as the OAuth CSRF state). */
  take(key: string): Promise<string | null>;
  purgeExpired(): Promise<void>;
}
