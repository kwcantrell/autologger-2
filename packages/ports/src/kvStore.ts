// KvStore port (spec: core-ports-architecture): the value-based KV over the
// catalog `kv` table today (`server/src/node/kvStore.ts`'s `KvStore` class) —
// login sessions, OAuth CSRF, Companion last_command.

export interface KvStore {
  get(key: string): string | null;
  put(key: string, value: string, opts?: { expirationTtl?: number }): void;
  delete(key: string): void;
  purgeExpired(): void;
}
