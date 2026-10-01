// KvStore port (spec: core-ports-architecture): the value-based KV over the
// catalog `kv` table today (`server/src/node/kvStore.ts`'s `KvStore` class) —
// login sessions, OAuth CSRF, Companion last_command. Async so a networked backend can replace
// SQLite without changing call sites (ADR 0021 slice 3, async-session-callers D2).

export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  purgeExpired(): Promise<void>;
}
