# Node Server Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every Cloudflare dependency (D1, KV, Durable Objects, R2, Workers Assets, wrangler, Miniflare) with portable Node equivalents so the same Hono app runs on any Node ≥ 22 host, per the approved spec `docs/superpowers/specs/2026-07-09-node-port-and-frontend-adoption-design.md`.

**Architecture:** Additive first (Phases A: new Node modules + a structural seam refactor, all unit-tested while the existing Miniflare test tier stays green), then one cutover task (Phase B: bindings/type flip, app/main split, router edits), then the integration suites are re-pointed at a Node test harness (Phase C), then Cloudflare tooling is deleted (Phase D). Routers keep calling `stub.method(...)`; the six DO store modules and the D1 store modules are not edited except for **type-name-only** changes (constructor param types; `SqlStorageValue` → `SqlValue` where named).

**Tech Stack:** Hono (kept), `@hono/node-server` **^1.19** (pinned to `@hono/node-ws`'s peer range — v2 conflicts and npm 9 hard-fails ERESOLVE), `@hono/node-ws` ^1, `better-sqlite3` ^12 (+ `@types/better-sqlite3`), `tsx` (dev runner), `undici` (dev, fetch mocking), vitest 2 (kept), zod + jose (kept).

## Global Constraints

- **Python parity:** JSON shapes and status codes must not change. Do not invent new API surface.
- **Node ≥ 22** (machine has v22.22.1; `--env-file` and global `WebSocket` are available).
- **Conventional commits:** `type(scope): summary`.
- **Never commit secrets.** `.env` joins `.gitignore` in Task 16; only `.env.example` is committed.
- **`file:line` anchors go stale** — locate quoted code by content before editing.
- **Every task ends green:** `npm run typecheck` and `npm test` must pass before its commit (Phase A keeps the Miniflare tier running; if wrangler hits `EACCES … /.config/.wrangler`, prefix commands with `XDG_CONFIG_HOME=/tmp/wr-config`).
- **Synchronous-RPC invariant (spec):** `SessionHub` RPC bodies contain zero `await`s. Anything async lives in the router.
- **Gate decision E1:** `REQUIRE_LOGIN` defaults **on** when unset (flip happens in Task 10).
- Do NOT run `wrangler deploy` or any remote provisioning.

---

## Phase A — additive Node modules (Miniflare tier stays green)

### Task 1: Node toolchain dependencies

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: installed packages `better-sqlite3`, `@hono/node-server`, `@hono/node-ws`, `tsx`, `undici`, `@types/better-sqlite3`; tsconfig with `"node"` in the `types` array (verified compatible with the Workers types under `skipLibCheck`).

- [ ] **Step 1: Add dependencies**

```bash
npm install better-sqlite3 '@hono/node-server@^1.19.11' @hono/node-ws
npm install -D @types/better-sqlite3 tsx undici
```

(`@hono/node-ws@1.x` peer-depends on `@hono/node-server@^1.19.11`; do NOT install node-server v2 — npm 9 hard-fails the peer conflict.)

- [ ] **Step 2: Enable @types/node for typecheck**

In `tsconfig.json`, change the `types` line to:

```json
"types": ["./worker-configuration.d.ts", "@cloudflare/vitest-pool-workers", "node"],
```

- [ ] **Step 3: Verify everything still passes**

Run: `npm run typecheck && npm test`
Expected: both green (no behavior changed).

- [ ] **Step 4: Sanity-check better-sqlite3 loads**

Run: `node -e "const db=require('better-sqlite3')(':memory:');db.exec('CREATE TABLE t(x)');console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "build(deps): add node runtime deps (better-sqlite3, hono node adapters, tsx)"
```

---

### Task 2: SqlShim — SqlStorage-shaped wrapper over better-sqlite3

**Files:**
- Create: `src/node/sqlShim.ts`
- Test: `src/node/sqlShim.test.ts`

**Interfaces:**
- Consumes: `better-sqlite3` `Database`.
- Produces:
  ```ts
  export type SqlValue = string | number | null | Buffer;
  export interface SqlCursor<T> { toArray(): T[]; rowsWritten: number }
  export class SqlShim {
    constructor(db: Database);
    exec<T = Record<string, SqlValue>>(sql: string, ...binds: SqlValue[]): SqlCursor<T>;
  }
  ```
  Semantics mirror the DO's `SqlStorage.exec`: SELECT-ish statements → rows via `toArray()`, write statements → `rowsWritten` (better-sqlite3 `changes`), multi-statement SQL allowed **only** with zero binds (used by `initSchema`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/node/sqlShim.test.ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SqlShim } from './sqlShim';

function shim(): SqlShim {
  return new SqlShim(new Database(':memory:'));
}

describe('SqlShim', () => {
  it('runs multi-statement SQL with no binds (initSchema shape)', () => {
    const s = shim();
    s.exec(`
      CREATE TABLE a (x INTEGER);
      CREATE TABLE b (y TEXT);
      INSERT INTO a (x) VALUES (1);
    `);
    expect(s.exec('SELECT x FROM a').toArray()).toEqual([{ x: 1 }]);
  });

  it('returns rows via toArray() for bound SELECTs', () => {
    const s = shim();
    s.exec('CREATE TABLE t (k TEXT, v INTEGER)');
    s.exec('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
    s.exec('INSERT INTO t (k, v) VALUES (?, ?)', 'b', 2);
    expect(s.exec('SELECT * FROM t WHERE v > ? ORDER BY v', 0).toArray()).toEqual([
      { k: 'a', v: 1 },
      { k: 'b', v: 2 },
    ]);
  });

  it('reports rowsWritten for writes (UPDATE hit and miss)', () => {
    const s = shim();
    s.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
    s.exec('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
    expect(s.exec("UPDATE t SET v = 2 WHERE k = 'a'").rowsWritten).toBe(1);
    expect(s.exec("UPDATE t SET v = 2 WHERE k = 'zzz'").rowsWritten).toBe(0);
  });

  it('binds null and numeric values', () => {
    const s = shim();
    s.exec('CREATE TABLE t (a, b)');
    s.exec('INSERT INTO t (a, b) VALUES (?, ?)', null, 3.5);
    expect(s.exec('SELECT * FROM t').toArray()).toEqual([{ a: null, b: 3.5 }]);
  });

  it('throws on multi-statement SQL with binds', () => {
    const s = shim();
    expect(() => s.exec('SELECT 1; SELECT 2', 5)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/node/sqlShim.test.ts`
Expected: FAIL — cannot resolve `./sqlShim`.

- [ ] **Step 3: Implement**

```ts
// src/node/sqlShim.ts
// SqlStorage-shaped shim over better-sqlite3 — the seam SessionCore's stores
// already program against (exec(sql, ...binds) → { toArray(), rowsWritten }).
// Multi-statement SQL is supported only with zero binds (initSchema).

import type { Database } from 'better-sqlite3';

export type SqlValue = string | number | null | Buffer;

export interface SqlCursor<T> {
  toArray(): T[];
  rowsWritten: number;
}

export class SqlShim {
  constructor(private db: Database) {}

  exec<T = Record<string, SqlValue>>(sql: string, ...binds: SqlValue[]): SqlCursor<T> {
    const stmt = this.db.prepare(sql); // throws on multi-statement; caught below
    if (stmt.reader) {
      const rows = stmt.all(...binds) as T[];
      return { toArray: () => rows, rowsWritten: 0 };
    }
    const info = stmt.run(...binds);
    return { toArray: () => [], rowsWritten: info.changes };
  }
}
```

Note: `db.prepare` throws `RangeError`/`SqliteError` when `sql` contains more than one statement. Wrap accordingly:

```ts
  exec<T = Record<string, SqlValue>>(sql: string, ...binds: SqlValue[]): SqlCursor<T> {
    let stmt;
    try {
      stmt = this.db.prepare(sql);
    } catch (e) {
      // Multi-statement input (initSchema). Only legal with zero binds.
      if (binds.length === 0 && /;/.test(sql)) {
        this.db.exec(sql);
        return { toArray: () => [], rowsWritten: 0 };
      }
      throw e;
    }
    if (stmt.reader) {
      const rows = stmt.all(...binds) as T[];
      return { toArray: () => rows, rowsWritten: 0 };
    }
    const info = stmt.run(...binds);
    return { toArray: () => [], rowsWritten: info.changes };
  }
```

Use this second form (the first snippet is shown only to explain the shape — implement the try/catch version).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/node/sqlShim.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full suite + typecheck, then commit**

```bash
npm run typecheck && npm test
git add src/node/sqlShim.ts src/node/sqlShim.test.ts
git commit -m "feat(node): SqlStorage-shaped SqlShim over better-sqlite3"
```

---

### Task 3: SessionCtx seam — SessionCore stops importing DO types

**Files:**
- Modify: `src/durable/sessionCore.ts`
- Modify: `src/durable/SessionDO.ts`
- Modify (type name only): `src/durable/topicStore.ts`, `src/durable/transcriptStore.ts`

**Interfaces:**
- Produces (in `sessionCore.ts`):
  ```ts
  export interface AttachedSocket { send(data: string): void; role: 'browser' | 'companion' }
  export interface SessionCtx {
    readonly sql: { exec<T = Row>(sql: string, ...binds: SqlValue[]): { toArray(): T[]; rowsWritten: number } };
    sockets(): Iterable<AttachedSocket>;
    setAlarm(atMs: number): void;
  }
  export type SqlValue = string | number | null; // superset added by SqlShim's Buffer is not needed here
  ```
  `SessionCore`'s constructor takes `SessionCtx` instead of `DurableObjectState`. The DO's `SqlStorage.exec` cursor already has `toArray()` and `rowsWritten`, so both backends satisfy the same structural type. This task is a **pure refactor** — the existing Miniflare integration tests are the safety net.

- [ ] **Step 1: Rewrite the ctx seam in `sessionCore.ts`**

Replace the top of the file (the `Row` type and the class head through `setAlarm`) as follows. Keep `initSchema`, all SQL helper bodies, `transportRow`, `bumpRevision`, `revision`, `projection`, `metaGet/Set/Delete` **byte-identical** except as shown:

```ts
// Replace:  export type Row = Record<string, SqlStorageValue>;
export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface AttachedSocket {
  send(data: string): void;
  role: 'browser' | 'companion';
}

/** Runtime substrate SessionCore runs on. On Workers this wrapped
 * DurableObjectState; on Node it wraps better-sqlite3 + the hub's socket set. */
export interface SessionCtx {
  readonly sql: {
    exec<T = Row>(sql: string, ...binds: SqlValue[]): { toArray(): T[]; rowsWritten: number };
  };
  sockets(): Iterable<AttachedSocket>;
  setAlarm(atMs: number): void;
}
```

```ts
// Replace the class head + db getter:
export class SessionCore {
  constructor(private ctx: SessionCtx) {}

  get db(): SessionCtx['sql'] {
    return this.ctx.sql;
  }
```

```ts
// Replace broadcast/presence (they used ctx.getWebSockets + deserializeAttachment):
  /** Send a JSON message to every attached socket (browser tabs + Companion). */
  broadcast(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.sockets()) {
      try {
        ws.send(data);
      } catch {
        // socket is going away; owner cleanup drops it.
      }
    }
  }

  /** Snapshot of attached sockets by role (presence; no TTL bookkeeping). */
  presence(): { browsers: number; companions: number } {
    let browsers = 0;
    let companions = 0;
    for (const ws of this.ctx.sockets()) {
      if (ws.role === 'companion') companions += 1;
      else browsers += 1;
    }
    return { browsers, companions };
  }
```

```ts
// Replace setAlarm:
  /** Single alarm slot — setAlarm REPLACES any pending alarm. The recording
   * lease is the sole consumer today. */
  setAlarm(atMs: number): void {
    this.ctx.setAlarm(atMs);
  }
```

Type check note: `all()`/`first()` signatures change `SqlStorageValue` → `SqlValue`; update those two signatures in place.

- [ ] **Step 2: Adapt `SessionDO.ts` to build a `SessionCtx`**

In the constructor, replace `this.core = new SessionCore(ctx);` with:

```ts
    this.core = new SessionCore({
      sql: ctx.storage.sql as unknown as SessionCtx['sql'],
      sockets: () =>
        ctx.getWebSockets().map((ws) => ({
          send: (data: string) => ws.send(data),
          role:
            ((ws.deserializeAttachment() as { role?: string } | null)?.role ?? 'browser') ===
            'companion'
              ? ('companion' as const)
              : ('browser' as const),
        })),
      setAlarm: (atMs: number) => void ctx.storage.setAlarm(atMs),
    });
```

Add `import type { SessionCtx } from './sessionCore';` to the imports.

- [ ] **Step 3: Type-name fix in the two stores that name `SqlStorageValue`**

`src/durable/topicStore.ts` and `src/durable/transcriptStore.ts` each build a binds array typed `SqlStorageValue[]` (locate by content: `const vals: SqlStorageValue[] = []`, and topicStore's `patch[key] as SqlStorageValue`). Change those annotations to `SqlValue` and add `import type { SqlValue } from './sessionCore';` to each file. No logic changes — the values are strings/numbers/null.

- [ ] **Step 4: Verify the DO stores still bind (binds are `SqlValue`)**

The stores pass strings/numbers/null only. Run the full suite:

Run: `npm run typecheck && npm test`
Expected: green — unit tier and Miniflare tier both pass unchanged (this is the proof the refactor is behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add src/durable/sessionCore.ts src/durable/SessionDO.ts src/durable/topicStore.ts src/durable/transcriptStore.ts
git commit -m "refactor(durable): SessionCore depends on a structural SessionCtx, not DurableObjectState"
```

---

### Task 4: Catalog D1 adapter

**Files:**
- Create: `src/node/d1Adapter.ts`
- Test: `src/node/d1Adapter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class CatalogDb {
    constructor(db: Database);
    prepare(sql: string): CatalogStmt;
    batch(stmts: CatalogStmt[]): Array<{ meta: { changes: number } }>; // atomic
  }
  interface CatalogStmt {
    bind(...values: unknown[]): CatalogStmt;
    all<T>(): { results: T[] };
    first<T>(): T | null;
    run(): { meta: { changes: number } };
  }
  ```
  Exactly the D1 surface `src/db/*.ts` uses (39 `prepare` sites; 2 `batch`; 3 `meta.changes` reads). Methods are synchronous — callers `await` them, which is valid on non-promises. `batch` runs inside one transaction (D1's `batch` is atomic; `authStore.authAddMemberships` relies on it).

- [ ] **Step 1: Write the failing tests**

```ts
// src/node/d1Adapter.test.ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CatalogDb } from './d1Adapter';

function db(): CatalogDb {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
  return new CatalogDb(raw);
}

describe('CatalogDb', () => {
  it('prepare().bind().run() reports meta.changes', () => {
    const d = db();
    const r = d.prepare('INSERT INTO t (k, v) VALUES (?, ?)').bind('a', 1).run();
    expect(r.meta.changes).toBe(1);
    expect(d.prepare('UPDATE t SET v = 9 WHERE k = ?').bind('missing').run().meta.changes).toBe(0);
  });

  it('all() returns { results } and first() returns row or null', () => {
    const d = db();
    d.prepare('INSERT INTO t (k, v) VALUES (?, ?)').bind('a', 1).run();
    d.prepare('INSERT INTO t (k, v) VALUES (?, ?)').bind('b', 2).run();
    expect(d.prepare('SELECT * FROM t ORDER BY k').all().results).toEqual([
      { k: 'a', v: 1 },
      { k: 'b', v: 2 },
    ]);
    expect(d.prepare('SELECT * FROM t WHERE k = ?').bind('b').first()).toEqual({ k: 'b', v: 2 });
    expect(d.prepare('SELECT * FROM t WHERE k = ?').bind('nope').first()).toBeNull();
  });

  it('batch() is atomic — a failing statement rolls back the earlier ones', () => {
    const d = db();
    const ok = d.prepare('INSERT INTO t (k, v) VALUES (?, ?)').bind('a', 1);
    const dup = d.prepare('INSERT INTO t (k, v) VALUES (?, ?)').bind('a', 2); // PK violation
    expect(() => d.batch([ok, dup])).toThrow();
    expect(d.prepare('SELECT COUNT(*) AS n FROM t').first<{ n: number }>()?.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/node/d1Adapter.test.ts`
Expected: FAIL — cannot resolve `./d1Adapter`.

- [ ] **Step 3: Implement**

```ts
// src/node/d1Adapter.ts
// Thin D1-shaped adapter over better-sqlite3 for the catalog stores. Only the
// surface src/db/ actually calls: prepare().bind().all()/first()/run() with
// run().meta.changes, plus atomic batch(). Methods are synchronous; the store
// code `await`s them, which is a no-op on plain values.

import type { Database } from 'better-sqlite3';

export interface CatalogStmt {
  bind(...values: unknown[]): CatalogStmt;
  all<T = Record<string, unknown>>(): { results: T[] };
  first<T = Record<string, unknown>>(): T | null;
  run(): { meta: { changes: number } };
}

class Stmt implements CatalogStmt {
  constructor(
    private db: Database,
    private sql: string,
    private values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): CatalogStmt {
    return new Stmt(this.db, this.sql, values);
  }

  all<T = Record<string, unknown>>(): { results: T[] } {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }

  first<T = Record<string, unknown>>(): T | null {
    return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  run(): { meta: { changes: number } } {
    const info = this.db.prepare(this.sql).run(...this.values);
    return { meta: { changes: info.changes } };
  }
}

export class CatalogDb {
  constructor(private db: Database) {}

  prepare(sql: string): CatalogStmt {
    return new Stmt(this.db, sql);
  }

  /** D1's batch() is an implicit transaction; mirror that atomicity. */
  batch(stmts: CatalogStmt[]): Array<{ meta: { changes: number } }> {
    return this.db.transaction(() => stmts.map((s) => s.run()))();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/node/d1Adapter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite + commit**

```bash
npm run typecheck && npm test
git add src/node/d1Adapter.ts src/node/d1Adapter.test.ts
git commit -m "feat(node): D1-shaped catalog adapter over better-sqlite3 (atomic batch)"
```

---

### Task 5: Migrator + kv-table migration

**Files:**
- Create: `src/node/migrate.ts`
- Create: `src/db/migrations/0003_kv.sql`
- Test: `src/node/migrate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function applyMigrations(db: Database, dir: string): string[]; // applied filenames, in order
  export function openCatalogDb(path: string): Database;               // opens + pragmas (WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000)
  ```
  Tracking table `_migrations(name TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)`, filename-ordered, each migration applied inside a transaction (mirrors wrangler on fresh DBs; no existing Miniflare data is migrated).

- [ ] **Step 1: Write the kv migration**

```sql
-- src/db/migrations/0003_kv.sql
-- Value-based KV replacement (login sessions, OAuth CSRF, companion last_command).
-- Companion presence is NOT here — it lives in the in-memory PresenceRegistry.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/node/migrate.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, openCatalogDb } from './migrate';

const MIGRATIONS_DIR = join(process.cwd(), 'src/db/migrations');
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function freshDb() {
  dir = mkdtempSync(join(tmpdir(), 'autologger-mig-'));
  return openCatalogDb(join(dir, 'catalog.db'));
}

describe('migrator', () => {
  it('applies all migrations in filename order and records them', () => {
    const db = freshDb();
    const applied = applyMigrations(db, MIGRATIONS_DIR);
    expect(applied).toEqual(['0001_init.sql', '0002_sessions_live_split.sql', '0003_kv.sql']);
    const names = db.prepare('SELECT name FROM _migrations ORDER BY name').all();
    expect(names).toHaveLength(3);
    // Schema landed: catalog tables + kv exist.
    expect(() => db.prepare('SELECT * FROM users LIMIT 1').all()).not.toThrow();
    expect(() => db.prepare('SELECT * FROM kv LIMIT 1').all()).not.toThrow();
  });

  it('is idempotent — second run applies nothing', () => {
    const db = freshDb();
    applyMigrations(db, MIGRATIONS_DIR);
    expect(applyMigrations(db, MIGRATIONS_DIR)).toEqual([]);
  });

  it('openCatalogDb enforces the pragmas', () => {
    const db = freshDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/node/migrate.test.ts`
Expected: FAIL — cannot resolve `./migrate`.

- [ ] **Step 4: Implement**

```ts
// src/node/migrate.ts
// Startup migrator for the catalog DB — filename-ordered .sql files, tracked in
// _migrations, each applied in a transaction. Mirrors wrangler's behavior on a
// fresh database (no Miniflare data is carried over).

import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function openCatalogDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function applyMigrations(db: Database.Database, dir: string): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)',
  );
  const done = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), 'utf-8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at_utc) VALUES (?, ?)').run(
        name,
        new Date().toISOString(),
      );
    })();
    applied.push(name);
  }
  return applied;
}
```

- [ ] **Step 5: Run tests, full suite, commit**

Run: `npx vitest run src/node/migrate.test.ts` → PASS, then `npm run typecheck && npm test` → green.
Note: the Miniflare tier also picks up `0003_kv.sql` via `readD1Migrations` — harmless (`CREATE TABLE IF NOT EXISTS`), and it keeps both tiers on the same schema until cutover.

```bash
git add src/node/migrate.ts src/node/migrate.test.ts src/db/migrations/0003_kv.sql
git commit -m "feat(node): catalog DB migrator + kv table migration"
```

---

### Task 6: KvStore (TTL table)

**Files:**
- Create: `src/node/kvStore.ts`
- Test: `src/node/kvStore.test.ts`

**Interfaces:**
- Consumes: `Database` with the `kv` table (Task 5).
- Produces:
  ```ts
  export class KvStore {
    constructor(db: Database);
    get(key: string): string | null;                                    // lazy expiry
    put(key: string, value: string, opts?: { expirationTtl?: number }): void; // ttl in seconds
    delete(key: string): void;
    purgeExpired(): void;                                               // startup hygiene (spec: no sweep timer)
  }
  ```
  Drop-in for the `AUTH.get/put/delete` calls in `src/auth/identity.ts` and the `last_command` calls in `src/routers/companion.ts` (callers `await` — fine on sync values).

- [ ] **Step 1: Write the failing tests**

```ts
// src/node/kvStore.test.ts
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KvStore } from './kvStore';

function store(): KvStore {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)');
  return new KvStore(db);
}

describe('KvStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('round-trips a value without TTL', () => {
    const s = store();
    s.put('a', 'hello');
    expect(s.get('a')).toBe('hello');
    s.delete('a');
    expect(s.get('a')).toBeNull();
  });

  it('expires lazily on get after expirationTtl seconds', () => {
    const s = store();
    s.put('sess', 'tok', { expirationTtl: 60 });
    expect(s.get('sess')).toBe('tok');
    vi.advanceTimersByTime(61_000);
    expect(s.get('sess')).toBeNull();
  });

  it('put overwrites value and TTL', () => {
    const s = store();
    s.put('k', 'v1', { expirationTtl: 10 });
    s.put('k', 'v2'); // no TTL now
    vi.advanceTimersByTime(60_000);
    expect(s.get('k')).toBe('v2');
  });

  it('purgeExpired deletes dead rows and keeps live ones', () => {
    const s = store();
    s.put('dead', 'x', { expirationTtl: 1 });
    s.put('live', 'y', { expirationTtl: 9999 });
    s.put('forever', 'z');
    vi.advanceTimersByTime(5_000);
    s.purgeExpired();
    expect(s.get('live')).toBe('y');
    expect(s.get('forever')).toBe('z');
    expect(s.get('dead')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/node/kvStore.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/node/kvStore.ts
// Value-based KV over the catalog kv table (login sessions, OAuth CSRF,
// companion last_command). Lazy expiry on get; purgeExpired() runs once at
// startup — no background sweep (spec: scope #3).

import type { Database } from 'better-sqlite3';

export class KvStore {
  constructor(private db: Database) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value, expires_at FROM kv WHERE key = ?').get(key) as
      | { value: string; expires_at: number | null }
      | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.delete(key);
      return null;
    }
    return row.value;
  }

  put(key: string, value: string, opts: { expirationTtl?: number } = {}): void {
    const expiresAt = opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
    this.db
      .prepare(
        'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      )
      .run(key, value, expiresAt);
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  purgeExpired(): void {
    this.db.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?').run(
      Date.now(),
    );
  }
}
```

- [ ] **Step 4: Run tests, full suite, commit**

Run: `npx vitest run src/node/kvStore.test.ts` → PASS; `npm run typecheck && npm test` → green.

```bash
git add src/node/kvStore.ts src/node/kvStore.test.ts
git commit -m "feat(node): TTL-aware KvStore over the catalog kv table"
```

---

### Task 7: BlobStore (filesystem, replaces R2)

**Files:**
- Create: `src/node/blobStore.ts`
- Test: `src/node/blobStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class InvalidRangeError extends Error {}
  export type BlobRange = { offset: number; length?: number } | { suffix: number };
  export class BlobStore {
    constructor(root: string, tmpDir: string); // tmpDir must be OUTSIDE root (atomic put, spec)
    put(key: string, bytes: ArrayBuffer | Uint8Array, opts?: { contentType?: string }): Promise<void>;
    get(key: string, opts?: { range?: BlobRange }): Promise<BlobObject | null>; // throws InvalidRangeError on bad ranges
    delete(key: string): Promise<void>;
    list(opts: { prefix: string; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated: false; cursor?: undefined }>;
  }
  interface BlobObject { size: number; range?: { offset: number; length: number }; body: ReadableStream }
  ```
  Range semantics normalize to `{offset, length}` (a `suffix` request comes back as its equivalent offset/length, so the audio route's `'offset' in r` branch handles both). Out-of-bounds → `InvalidRangeError` (→ 416 in Task 10). `contentType` is accepted and ignored (mime lives in the DO metadata row). Keys resolve under `root` or throw (belt-and-braces traversal guard).

- [ ] **Step 1: Write the failing tests**

```ts
// src/node/blobStore.test.ts
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BlobStore, InvalidRangeError } from './blobStore';

let base: string;
afterEach(() => rmSync(base, { recursive: true, force: true }));

function store(): BlobStore {
  base = mkdtempSync(join(tmpdir(), 'autologger-blob-'));
  return new BlobStore(join(base, 'audio'), join(base, 'tmp'));
}

async function drain(body: ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const c of body as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  return Buffer.concat(chunks);
}

const BYTES = new TextEncoder().encode('0123456789'); // 10 bytes

describe('BlobStore', () => {
  it('put/get round-trip with nested keys, and size is reported', async () => {
    const s = store();
    await s.put('audio/sess1/0001_x.webm', BYTES);
    const obj = await s.get('audio/sess1/0001_x.webm');
    expect(obj).not.toBeNull();
    expect(obj!.size).toBe(10);
    expect((await drain(obj!.body)).toString()).toBe('0123456789');
  });

  it('get returns null for a missing key', async () => {
    const s = store();
    expect(await s.get('audio/nope')).toBeNull();
  });

  it('serves offset/length and suffix ranges, normalized to offset/length', async () => {
    const s = store();
    await s.put('k', BYTES);
    const mid = await s.get('k', { range: { offset: 2, length: 3 } });
    expect(mid!.range).toEqual({ offset: 2, length: 3 });
    expect((await drain(mid!.body)).toString()).toBe('234');
    const tail = await s.get('k', { range: { suffix: 4 } });
    expect(tail!.range).toEqual({ offset: 6, length: 4 });
    expect((await drain(tail!.body)).toString()).toBe('6789');
    const openEnd = await s.get('k', { range: { offset: 7 } });
    expect(openEnd!.range).toEqual({ offset: 7, length: 3 });
  });

  it('throws InvalidRangeError on out-of-bounds or non-positive ranges', async () => {
    const s = store();
    await s.put('k', BYTES);
    await expect(s.get('k', { range: { offset: 10 } })).rejects.toBeInstanceOf(InvalidRangeError);
    await expect(s.get('k', { range: { offset: 5, length: -2 } })).rejects.toBeInstanceOf(
      InvalidRangeError,
    );
    // suffix larger than the file → whole file (HTTP semantics), not an error
    const whole = await s.get('k', { range: { suffix: 999 } });
    expect(whole!.range).toEqual({ offset: 0, length: 10 });
  });

  it('list returns keys under a prefix; partial temp files never appear', async () => {
    const s = store();
    await s.put('audio/a/0001_x.webm', BYTES);
    await s.put('audio/a/0002_y.webm', BYTES);
    await s.put('audio/b/0001_z.webm', BYTES);
    const res = await s.list({ prefix: 'audio/a/' });
    expect(res.objects.map((o) => o.key).sort()).toEqual([
      'audio/a/0001_x.webm',
      'audio/a/0002_y.webm',
    ]);
    expect(res.truncated).toBe(false);
    // temp dir is outside the listing root entirely
    expect(readdirSync(base)).toContain('tmp');
  });

  it('delete removes the file; deleting a missing key is a no-op', async () => {
    const s = store();
    await s.put('k', BYTES);
    await s.delete('k');
    expect(await s.get('k')).toBeNull();
    await expect(s.delete('k')).resolves.toBeUndefined();
  });

  it('rejects keys escaping the root', async () => {
    const s = store();
    await expect(s.put('../escape', BYTES)).rejects.toThrow();
    await expect(s.get('../../etc/passwd')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/node/blobStore.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/node/blobStore.ts
// Filesystem blob store replacing R2 (audio bytes). r2_key strings are relative
// paths under root. put() is atomic: write to tmpDir (outside root, so list()
// and reconciliation never see partials), fsync, rename. Range gets normalize
// to {offset,length}; unsatisfiable ranges throw InvalidRangeError (→ 416).

import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

export class InvalidRangeError extends Error {}

export type BlobRange = { offset: number; length?: number } | { suffix: number };

export interface BlobObject {
  size: number;
  range?: { offset: number; length: number };
  body: ReadableStream;
}

let tmpCounter = 0;

export class BlobStore {
  private rootAbs: string;

  constructor(
    root: string,
    private tmpDir: string,
  ) {
    this.rootAbs = resolve(root);
  }

  private pathFor(key: string): string {
    const p = resolve(join(this.rootAbs, key));
    if (p !== this.rootAbs && !p.startsWith(this.rootAbs + sep)) {
      throw new Error(`Blob key escapes the store root: ${key}`);
    }
    return p;
  }

  async put(
    key: string,
    bytes: ArrayBuffer | Uint8Array,
    _opts: { contentType?: string } = {},
  ): Promise<void> {
    const dest = this.pathFor(key);
    await mkdir(this.tmpDir, { recursive: true });
    await mkdir(dirname(dest), { recursive: true });
    const tmp = join(this.tmpDir, `put-${process.pid}-${(tmpCounter += 1)}`);
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, dest);
  }

  async get(key: string, opts: { range?: BlobRange } = {}): Promise<BlobObject | null> {
    const p = this.pathFor(key);
    let size: number;
    try {
      size = (await stat(p)).size;
    } catch {
      return null;
    }
    if (!opts.range) {
      return { size, body: Readable.toWeb(createReadStream(p)) as ReadableStream };
    }
    let offset: number;
    let length: number;
    if ('suffix' in opts.range) {
      if (opts.range.suffix <= 0) throw new InvalidRangeError('suffix must be positive');
      length = Math.min(opts.range.suffix, size);
      offset = size - length;
    } else {
      offset = opts.range.offset;
      length = opts.range.length ?? size - offset;
      if (offset < 0 || offset >= size || length <= 0) {
        throw new InvalidRangeError(`bytes ${offset}+${length} of ${size}`);
      }
      length = Math.min(length, size - offset);
    }
    const body = Readable.toWeb(
      createReadStream(p, { start: offset, end: offset + length - 1 }),
    ) as ReadableStream;
    return { size, range: { offset, length }, body };
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async list(opts: {
    prefix: string;
    cursor?: string;
  }): Promise<{ objects: Array<{ key: string }>; truncated: false; cursor?: undefined }> {
    // prefix is a directory-ish path; walk everything under it. Single-shot
    // (truncated always false) — callers' cursor loops terminate immediately.
    const startDir = this.pathFor(opts.prefix.endsWith('/') ? opts.prefix : dirname(opts.prefix));
    const objects: Array<{ key: string }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // missing directory ⇒ empty listing
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const key = full.slice(this.rootAbs.length + 1).split(sep).join('/');
          if (key.startsWith(opts.prefix)) objects.push({ key });
        }
      }
    };
    await walk(startDir);
    return { objects, truncated: false };
  }
}
```

- [ ] **Step 4: Run tests, full suite, commit**

Run: `npx vitest run src/node/blobStore.test.ts` → PASS; `npm run typecheck && npm test` → green.

```bash
git add src/node/blobStore.ts src/node/blobStore.test.ts
git commit -m "feat(node): filesystem BlobStore with atomic put + normalized ranges"
```

---

### Task 8: PresenceRegistry (in-memory, replaces KV-metadata presence)

**Files:**
- Create: `src/node/presence.ts`
- Test: `src/node/presence.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PresenceMeta { session_id: string; visible: boolean; is_playing: boolean; updated: number }
  export class PresenceRegistry {
    upsert(clientId: string, meta: PresenceMeta): void;
    remove(clientId: string): void;
    list(): PresenceMeta[]; // only entries fresh within 15s (PRESENCE_FRESH_MS); prunes stale
  }
  export const PRESENCE_FRESH_MS = 15_000;
  ```
  Matches the Python `CompanionHub` shape (spec: presence is ephemeral; the freshness window is 15s, same as today's `PRESENCE_FRESH_MS` in `companion.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/node/presence.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresenceRegistry } from './presence';

describe('PresenceRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const meta = (sid: string, over: Partial<{ visible: boolean; is_playing: boolean }> = {}) => ({
    session_id: sid,
    visible: over.visible ?? true,
    is_playing: over.is_playing ?? false,
    updated: Date.now(),
  });

  it('lists fresh entries and drops stale ones after 15s', () => {
    const r = new PresenceRegistry();
    r.upsert('c1', meta('s1'));
    expect(r.list()).toHaveLength(1);
    vi.advanceTimersByTime(16_000);
    expect(r.list()).toHaveLength(0);
  });

  it('upsert refreshes an existing client; remove deletes it', () => {
    const r = new PresenceRegistry();
    r.upsert('c1', meta('s1'));
    vi.advanceTimersByTime(10_000);
    r.upsert('c1', meta('s2'));
    vi.advanceTimersByTime(10_000);
    expect(r.list()).toEqual([expect.objectContaining({ session_id: 's2' })]);
    r.remove('c1');
    expect(r.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/node/presence.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/node/presence.ts
// In-memory companion presence — the Python CompanionHub shape (nothing
// persisted; rebuilt by browser heartbeats after a restart). Replaces the
// KV-metadata presence keys of the Worker port (spec panel: all reviewers).

export const PRESENCE_FRESH_MS = 15_000;

export interface PresenceMeta {
  session_id: string;
  visible: boolean;
  is_playing: boolean;
  updated: number;
}

export class PresenceRegistry {
  private map = new Map<string, PresenceMeta>();

  upsert(clientId: string, meta: PresenceMeta): void {
    this.map.set(clientId, meta);
  }

  remove(clientId: string): void {
    this.map.delete(clientId);
  }

  /** Fresh entries only (≤15s old); stale ones are pruned as a side effect. */
  list(): PresenceMeta[] {
    const now = Date.now();
    const out: PresenceMeta[] = [];
    for (const [cid, meta] of this.map) {
      if (now - meta.updated <= PRESENCE_FRESH_MS) out.push(meta);
      else this.map.delete(cid);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run tests, full suite, commit**

```bash
npx vitest run src/node/presence.test.ts && npm run typecheck && npm test
git add src/node/presence.ts src/node/presence.test.ts
git commit -m "feat(node): in-memory PresenceRegistry (CompanionHub parity)"
```

---

### Task 9: SessionHub + registry

**Files:**
- Create: `src/durable/SessionHub.ts`
- Test: `src/durable/SessionHub.test.ts`

**Interfaces:**
- Consumes: `SqlShim` (Task 2), `SessionCtx`/`SessionCore` + the six stores (Task 3), `openCatalogDb` pragma conventions (Task 5 — session DBs get the same pragmas).
- Produces:
  ```ts
  export class SessionHub {
    constructor(dbPath: string);
    // Full SessionDO RPC surface, same names/params/returns, all synchronous:
    // ensure, addEvent, listEvents, getEvent, exportEvents, updateEvent, deleteEvent,
    // maybeRelinkOrphans, transportSnapshot, startTake, stopTake, stopTakeWithDuration,
    // statusLive, claimLease, heartbeatLease, releaseLease, leaseStatus,
    // addAudioSegment, listAudioSegments, deleteAudioSegment, getAudioSegmentKey,
    // setAudioSegmentWaveform, syncAudioFromR2, listTranscriptWords, insertTranscriptWord,
    // updateTranscriptWord, deleteTranscriptWord, listTopics, insertTopic, updateTopic,
    // deleteTopic, presence, broadcastCommand
    attachSocket(ws: { send(data: string): void }, role: 'browser' | 'companion'): void;
    detachSocket(ws: { send(data: string): void }): void;
    handleSocketMessage(raw: string): void;
    readonly socketCount: number;
    readonly hasArmedAlarm: boolean;
    close(): void; // clears timer, closes the DB handle
  }
  export class SessionHubRegistry {
    constructor(sessionsDir: string);
    get(sessionId: string): SessionHub;   // lazy instantiation; touches LRU clock
    evictIdle(idleMs?: number): void;      // closes hubs with no sockets, no alarm, idle > idleMs (default 10 min)
    startSweeper(): void;                  // 60s unref'd interval calling evictIdle (main.ts only)
    closeAll(): void;
  }
  ```
  Type re-exports preserved: `SessionProjection`, `TransportState`, `AudioSegmentMeta`, `TranscriptWord`, `Topic` (importers currently pull these from `./SessionDO`; they re-point in Task 10).

- [ ] **Step 1: Write the failing tests**

```ts
// src/durable/SessionHub.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHub, SessionHubRegistry } from './SessionHub';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autologger-hub-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CTX = { frameRate: 24, startOffsetFrames: 0 };

describe('SessionHub', () => {
  it('ensure() initializes the schema and returns an empty projection', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    expect(hub.ensure()).toMatchObject({ event_count: 0, is_rolling: false, current_take: 0 });
    hub.close();
  });

  it('addEvent persists atomically with its revision bump', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const { event, projection } = hub.addEvent({
      category: 'cam',
      message: 'hello',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
    });
    expect(event.message).toBe('hello');
    expect(projection.event_count).toBe(1);
    // Revision bumped in the same transaction as the insert.
    expect(hub.statusLive(CTX).events_stream_revision).toBe(1);
    hub.close();
  });

  it('state survives close + reopen (durable on disk)', () => {
    const p = join(dir, 's1.db');
    const hub = new SessionHub(p);
    hub.addEvent({ category: 'cam', message: 'x', metadataJson: '{}', markedAtUtc: null, ctx: CTX });
    hub.close();
    const hub2 = new SessionHub(p);
    expect(hub2.ensure().event_count).toBe(1);
    hub2.close();
  });

  it('broadcasts to attached sockets and counts presence by role', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const got: string[] = [];
    const ws = { send: (d: string) => void got.push(d) };
    hub.attachSocket(ws, 'browser');
    hub.attachSocket({ send: () => {} }, 'companion');
    expect(hub.presence()).toEqual({ browsers: 1, companions: 1 });
    hub.broadcastCommand('record-start');
    expect(JSON.parse(got[0])).toMatchObject({ type: 'command', command: 'record-start' });
    hub.detachSocket(ws);
    expect(hub.presence()).toEqual({ browsers: 0, companions: 1 });
    hub.close();
  });

  it('handleSocketMessage re-broadcasts client commands and ignores garbage', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const got: string[] = [];
    hub.attachSocket({ send: (d: string) => void got.push(d) }, 'browser');
    hub.handleSocketMessage('not json');
    hub.handleSocketMessage(JSON.stringify({ type: 'ping' }));
    hub.handleSocketMessage(JSON.stringify({ type: 'command', command: 'play-toggle' }));
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0])).toMatchObject({ type: 'command', command: 'play-toggle' });
    hub.close();
  });

  describe('lease timer (single-slot, fake time)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('expires a stale lease via the timer 40s after the last heartbeat', () => {
      const hub = new SessionHub(join(dir, 's1.db'));
      expect(hub.claimLease('client-a')).toBe(true);
      expect(hub.leaseStatus().lease_alive).toBe(true);
      vi.advanceTimersByTime(41_000);
      expect(hub.leaseStatus().lease_alive).toBe(false);
      expect(hub.leaseStatus().holder_client_id).toBeNull();
      hub.close();
    });

    it('heartbeats re-arm the single slot instead of stacking timers', () => {
      const hub = new SessionHub(join(dir, 's1.db'));
      hub.claimLease('client-a');
      vi.advanceTimersByTime(30_000);
      hub.heartbeatLease('client-a');
      vi.advanceTimersByTime(30_000); // 60s after claim, 30s after heartbeat
      expect(hub.leaseStatus().lease_alive).toBe(true); // old timer must not have fired a kill
      vi.advanceTimersByTime(11_000);
      expect(hub.leaseStatus().lease_alive).toBe(false);
      hub.close();
    });

    it('a lease already stale at instantiation is cleaned up (expireIfStale on open)', () => {
      const p = join(dir, 's1.db');
      const hub = new SessionHub(p);
      hub.claimLease('client-a');
      hub.close(); // process "dies" holding the lease
      vi.advanceTimersByTime(60_000);
      const hub2 = new SessionHub(p);
      expect(hub2.leaseStatus().holder_client_id).toBeNull(); // meta rows purged, not just lazily masked
      hub2.close();
    });
  });
});

describe('SessionHubRegistry', () => {
  it('returns the same hub per session id and isolates sessions', () => {
    const reg = new SessionHubRegistry(dir);
    const a = reg.get('sess-a');
    expect(reg.get('sess-a')).toBe(a);
    a.addEvent({ category: 'cam', message: 'x', metadataJson: '{}', markedAtUtc: null, ctx: CTX });
    expect(reg.get('sess-b').ensure().event_count).toBe(0);
    reg.closeAll();
  });

  it('rejects path-hostile session ids', () => {
    const reg = new SessionHubRegistry(dir);
    expect(() => reg.get('../escape')).toThrow();
    expect(() => reg.get('a/b')).toThrow();
    reg.closeAll();
  });

  it('evictIdle closes idle hubs (no sockets, no alarm) and they reopen lazily', () => {
    vi.useFakeTimers();
    const reg = new SessionHubRegistry(dir);
    const a = reg.get('sess-a');
    a.addEvent({ category: 'cam', message: 'x', metadataJson: '{}', markedAtUtc: null, ctx: CTX });
    vi.advanceTimersByTime(11 * 60_000);
    reg.evictIdle();
    const reopened = reg.get('sess-a');
    expect(reopened).not.toBe(a);
    expect(reopened.ensure().event_count).toBe(1);
    reg.closeAll();
    vi.useRealTimers();
  });

  it('does not evict a hub with a live socket or an armed lease', () => {
    vi.useFakeTimers();
    const reg = new SessionHubRegistry(dir);
    const withSocket = reg.get('sess-a');
    withSocket.attachSocket({ send: () => {} }, 'browser');
    const withLease = reg.get('sess-b');
    withLease.claimLease('c1');
    vi.advanceTimersByTime(11 * 60_000);
    reg.evictIdle();
    expect(reg.get('sess-a')).toBe(withSocket);
    // sess-b's lease expired at 40s (timer fired), so by 11min it MAY be evictable;
    // re-arm it and check within the armed window instead:
    const armed = reg.get('sess-c');
    armed.claimLease('c2');
    vi.advanceTimersByTime(20_000);
    reg.evictIdle(1); // idleMs=1 → everything idle is evictable, but armed alarm blocks
    expect(reg.get('sess-c')).toBe(armed);
    reg.closeAll();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/durable/SessionHub.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/durable/SessionHub.ts
// SessionHub — the Node replacement for SessionDO. One hub per session, lazily
// instantiated by SessionHubRegistry, backed by a per-session better-sqlite3
// file (same schema; SessionCore.initSchema is idempotent).
//
// INVARIANT (spec): RPC bodies are SYNCHRONOUS — zero awaits. better-sqlite3
// and WS sends are sync; this is what replaces the DO's input gates. Anything
// async belongs in the router. Every mutating RPC runs in a transaction (the
// DO's write-coalescing made multi-statement mutations atomic; autocommit
// per-statement would not).

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqlShim } from '../node/sqlShim';
import { AudioStore } from './audioStore';
import { EventStore } from './eventStore';
import { LeaseStore } from './leaseStore';
import { SessionCore } from './sessionCore';
import type { AttachedSocket, SessionProjection, TimecodeCtx } from './sessionCore';
import { TopicStore } from './topicStore';
import { TranscriptStore } from './transcriptStore';
import { TransportStore } from './transportStore';

export type { SessionProjection, TransportState } from './sessionCore';
export type { AudioSegmentMeta } from './audioStore';
export type { TranscriptWord } from './transcriptStore';
export type { Topic } from './topicStore';

interface HubSocket extends AttachedSocket {
  raw: { send(data: string): void };
}

export class SessionHub {
  private db: Database.Database;
  private core: SessionCore;
  private events: EventStore;
  private transport: TransportStore;
  private audio: AudioStore;
  private lease: LeaseStore;
  private transcript: TranscriptStore;
  private topics: TopicStore;
  private socketSet = new Set<HubSocket>();
  // ReturnType<> (not NodeJS.Timeout): the Workers ambient types are still loaded
  // in Phase A and their setTimeout returns number — this stays correct either way.
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  lastTouchedMs = Date.now();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON'); // spec: both catalog AND session DBs
    this.db.pragma('busy_timeout = 5000');
    const sql = new SqlShim(this.db);
    this.core = new SessionCore({
      sql,
      sockets: () => this.socketSet,
      setAlarm: (atMs) => this.armAlarm(atMs),
    });
    this.core.initSchema();
    this.events = new EventStore(this.core);
    this.transport = new TransportStore(this.core);
    this.audio = new AudioStore(this.core);
    this.lease = new LeaseStore(this.core);
    this.transcript = new TranscriptStore(this.core);
    this.topics = new TopicStore(this.core);
    // A lease that went stale while the process was down: clean it up now and
    // re-arm the timer if it is still live (spec: expireIfStale on open).
    this.inTxn(() => this.lease.expireIfStale());
  }

  private inTxn<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Single alarm slot: replaces any pending timer (DO setAlarm semantics). */
  private armAlarm(atMs: number): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = setTimeout(
      () => {
        this.alarmTimer = null;
        this.inTxn(() => this.lease.expireIfStale());
      },
      Math.max(0, atMs - Date.now()),
    );
    this.alarmTimer.unref?.();
  }

  get hasArmedAlarm(): boolean {
    return this.alarmTimer !== null;
  }

  get socketCount(): number {
    return this.socketSet.size;
  }

  close(): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
    this.db.close();
  }

  // -- WebSocket fan-out ---------------------------------------------------

  attachSocket(ws: { send(data: string): void }, role: 'browser' | 'companion'): void {
    this.socketSet.add({ raw: ws, send: (d) => ws.send(d), role });
  }

  detachSocket(ws: { send(data: string): void }): void {
    for (const s of this.socketSet) if (s.raw === ws) this.socketSet.delete(s);
  }

  handleSocketMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      if (p.type === 'command' && typeof p.command === 'string') {
        this.core.broadcastCommand(p.command);
      }
      // Bare `{type:'ping'}` keepalives are simply ignored.
    }
  }

  presence(): { browsers: number; companions: number } {
    return this.core.presence();
  }

  broadcastCommand(command: string): void {
    this.core.broadcastCommand(command);
  }

  // -- RPC: lifecycle --------------------------------------------------------

  ensure(): SessionProjection {
    return this.core.projection();
  }
}
```

Then copy the **entire delegate block** from `SessionDO.ts` (everything from `// --- event delegates ---` through `deleteTopic`, EXCLUDING `fetch`, `webSocketMessage/Close/Error`, and `alarm()`) into `SessionHub`, wrapping every **mutating** delegate in `this.inTxn(...)`. The exact mapping:

| Delegate | Wrap in `inTxn`? |
|---|---|
| `addEvent`, `updateEvent`, `deleteEvent`, `maybeRelinkOrphans` | yes |
| `startTake`, `stopTake`, `stopTakeWithDuration` | yes |
| `claimLease`, `heartbeatLease`, `releaseLease` | yes |
| `addAudioSegment`, `deleteAudioSegment`, `setAudioSegmentWaveform`, `syncAudioFromR2` | yes |
| `insertTranscriptWord`, `updateTranscriptWord`, `deleteTranscriptWord` | yes |
| `insertTopic`, `updateTopic`, `deleteTopic` | yes |
| `listEvents`, `getEvent`, `exportEvents`, `transportSnapshot`, `statusLive`, `leaseStatus`, `listAudioSegments`, `getAudioSegmentKey`, `listTranscriptWords`, `listTopics` | no (reads) |

Pattern (repeat for each mutating delegate):

```ts
  addEvent(input: Parameters<EventStore['addEvent']>[0]) {
    return this.inTxn(() => this.events.addEvent(input));
  }
```

Reads keep the plain delegate form:

```ts
  listEvents(input: Parameters<EventStore['listEvents']>[0]) {
    return this.events.listEvents(input);
  }
```

Append the registry at the bottom of the same file:

```ts
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_IDLE_MS = 10 * 60_000;

export class SessionHubRegistry {
  private hubs = new Map<string, SessionHub>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private sessionsDir: string) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  get(sessionId: string): SessionHub {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error(`Invalid session id for hub storage: ${sessionId}`);
    }
    let hub = this.hubs.get(sessionId);
    if (!hub) {
      hub = new SessionHub(join(this.sessionsDir, `${sessionId}.db`));
      this.hubs.set(sessionId, hub);
    }
    hub.lastTouchedMs = Date.now();
    return hub;
  }

  /** Close hubs holding nothing live — fd hygiene, everything is on disk. */
  evictIdle(idleMs: number = DEFAULT_IDLE_MS): void {
    const now = Date.now();
    for (const [id, hub] of this.hubs) {
      if (hub.socketCount === 0 && !hub.hasArmedAlarm && now - hub.lastTouchedMs > idleMs) {
        hub.close();
        this.hubs.delete(id);
      }
    }
  }

  startSweeper(): void {
    this.sweeper = setInterval(() => this.evictIdle(), 60_000);
    this.sweeper.unref?.();
  }

  closeAll(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const hub of this.hubs.values()) hub.close();
    this.hubs.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/durable/SessionHub.test.ts`
Expected: PASS. If the `addEvent` test fails on category enrichment, check `EventStore.addEvent`'s exact input shape in `src/durable/eventStore.ts` and adjust the test's input literal — do not modify the store.

- [ ] **Step 5: Full suite + commit**

```bash
npm run typecheck && npm test
git add src/durable/SessionHub.ts src/durable/SessionHub.test.ts
git commit -m "feat(node): SessionHub + registry replacing SessionDO (txn-per-RPC, timer alarm, idle eviction)"
```

---

## Phase B — the flip (one task; int tier goes offline until Phase C)

### Task 10: Bindings flip — types, env, config, app/main split, router edits

**Files:**
- Modify: `src/types.ts`
- Modify: `src/env.ts`, `src/env.test.ts`
- Create: `src/node/config.ts`
- Create: `src/app.ts` (replaces `src/index.ts`)
- Create: `src/main.ts`
- Create: `src/routers/sessionWs.ts`
- Modify: `src/auth/identity.ts`, `src/routers/auth.ts`, `src/middleware/auth.ts`, `src/middleware/ipAllowlist.ts` (+ its unit test), `src/routers/_helpers.ts`, `src/routers/companion.ts`, `src/routers/audio.ts`, `src/routers/events.ts`, `src/db/d1.ts` + the five `src/db/*Store*.ts`/`profileAssembler.ts` constructor types
- Delete: `src/index.ts`, `src/durable/SessionDO.ts`
- Modify: `tsconfig.json`, `vitest.workspace.ts`, `package.json` (scripts)

**Interfaces:**
- Consumes: everything from Tasks 2–9.
- Produces:
  ```ts
  // src/types.ts
  export interface Bindings {
    DB: CatalogDb; AUTH: KvStore; SESSION_DO: SessionHubRegistry; AUDIO: BlobStore; PRESENCE: PresenceRegistry;
    PUBLIC_BASE_URL: string; GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string;
    REQUIRE_LOGIN: string; SESSION_COOKIE: string; SESSION_DAYS: string; NEW_USER_ALL_TEAMS: string;
    COOKIE_SECURE: string; IP_ALLOWLIST: string; TRUST_PROXY: string; API_TOKEN: string; ADMIN_TOKEN: string;
    incoming?: import('node:http').IncomingMessage;
  }
  export type Env = Bindings; // keeps `env: Env` signatures across the codebase
  export type AppEnv = { Bindings: Bindings; Variables: Variables };
  // src/node/config.ts
  export function createBindings(procEnv: Record<string, string | undefined>): { bindings: Bindings; close(): void };
  // src/app.ts
  export function wireApp(app: Hono<AppEnv>, upgradeWebSocket: UpgradeWebSocket, opts?: { publicDir?: string; bindings?: Bindings }): Hono<AppEnv>;
  ```
  **Why `opts.bindings` (load-bearing):** `@hono/node-ws`'s `injectWebSocket` handles the HTTP `upgrade` event itself and calls `app.request(url, { headers }, { incoming, outgoing })` — it NEVER goes through any `serve({ fetch: wrapper })`, so bindings injected only in a fetch wrapper leave every WS connection with `c.env.DB === undefined` (authContext throws, upgrade dies). When `opts.bindings` is provided, `wireApp` registers a **first** middleware that merges them into `c.env` for both the HTTP and upgrade paths. Tests that pass env via `app.request(path, init, env)` simply omit `opts.bindings`.
  End state of this task: `npm run typecheck` green, **unit tier** green, integration tier temporarily offline (excluded), `npm run dev` boots a working server.

- [ ] **Step 0: Inventory gate — enumerate every CF reference before editing**

```bash
grep -rn "KVNamespace\|D1Database\|D1PreparedStatement\|DurableObject\|R2Range\|R2Bucket\|WebSocketPair\|SqlStorage\|cloudflare:\|env\.ASSETS\|: Env\b\|<Env>\|(env: Env" src/ --include='*.ts' | grep -v '.int.test.ts'
```

Every hit must map to a step below (or to Tasks 11/13 for the three test-infra files). Known inventory at plan time: `types.ts` (S2), `env.ts` (S3), `auth/identity.ts` + `middleware/auth.ts` (S4), `db/d1.ts` + four stores + `db/d1.test.ts` (S5), `middleware/ipAllowlist.ts` (S6), `routers/_helpers.ts` (S7), `routers/companion.ts` (S8), `routers/audio.ts` (S9), `routers/events.ts` (S10), `index.ts`/`SessionDO.ts` (S12), **`routers/profile.ts` — uses the previously-ambient `Env` type: add `import type { Env } from '../types';`** (do it in this step for profile.ts and any other non-test hit of the `Env`-usage patterns not already listed), `test/setup.int.ts`/`test/helpers.ts`/`test/oauth.ts` (excluded in S1, rewritten in Tasks 11/13). A hit outside this list means the plan missed a file — handle it the same way as its nearest sibling and note it in the commit message.

- [ ] **Step 1: Take the int tier offline (temporarily)**

`tsconfig.json`: drop the generated Workers types and exclude the int tests **plus the three CF-coupled test-infra files** (they still import `cloudflare:test` and are rewritten in Tasks 11/13):

```json
"types": ["node"],
...
"include": ["src/**/*.ts"],
"exclude": [
  "src/**/*.int.test.ts",
  "src/test/setup.int.ts",
  "src/test/helpers.ts",
  "src/test/oauth.ts"
]
```

`vitest.workspace.ts` — replace entirely with:

```ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['src/**/*.test.ts'],
      exclude: ['src/**/*.int.test.ts'],
      environment: 'node',
    },
  },
]);
```

- [ ] **Step 2: New `src/types.ts`**

```ts
// Shared Hono generics: Node bindings + per-request context Variables.

import type { AuthUser, Catalog } from './db/d1';
import type { SessionHubRegistry } from './durable/SessionHub';
import type { BlobStore } from './node/blobStore';
import type { CatalogDb } from './node/d1Adapter';
import type { KvStore } from './node/kvStore';
import type { PresenceRegistry } from './node/presence';

export interface Bindings {
  DB: CatalogDb;
  AUTH: KvStore;
  SESSION_DO: SessionHubRegistry;
  AUDIO: BlobStore;
  PRESENCE: PresenceRegistry;
  PUBLIC_BASE_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  REQUIRE_LOGIN: string;
  SESSION_COOKIE: string;
  SESSION_DAYS: string;
  NEW_USER_ALL_TEAMS: string;
  COOKIE_SECURE: string;
  IP_ALLOWLIST: string;
  TRUST_PROXY: string;
  API_TOKEN: string;
  ADMIN_TOKEN: string;
  /** Injected per-request by @hono/node-server; absent in app.request() tests. */
  incoming?: import('node:http').IncomingMessage;
}

/** Alias so existing `env: Env` signatures keep compiling after the CF types go. */
export type Env = Bindings;

export interface Variables {
  catalog: Catalog;
  user: AuthUser | null;
  apiTokenAuth: boolean;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
```

- [ ] **Step 3: `src/env.ts` — import the Env type, flip the login default (gate E1), add TRUST_PROXY, proxy-aware cookie detection**

Add at top: `import type { Env } from './types';`

Replace `requireLoginEnabled`:

```ts
/** Gate decision E1: login is REQUIRED unless explicitly disabled. */
export function requireLoginEnabled(env: Env): boolean {
  const v = (env.REQUIRE_LOGIN || '').trim().toLowerCase();
  if (!v) return true;
  return !['0', 'false', 'no'].includes(v);
}
```

Add:

```ts
export function trustProxyEnabled(env: Env): boolean {
  return ['1', 'true', 'yes'].includes((env.TRUST_PROXY || '').trim().toLowerCase());
}
```

Replace `cookieSecureForRequest` (new signature — takes the Request so it can read `X-Forwarded-Proto` under TRUST_PROXY):

```ts
export function cookieSecureForRequest(env: Env, req: Request): boolean {
  const raw = (env.COOKIE_SECURE || '').trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  if (trustProxyEnabled(env) && req.headers.get('x-forwarded-proto') === 'https') return true;
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}
```

Update the call site in `src/routers/auth.ts` (locate by content — `cookieSecureForRequest(c.env, c.req.url)`; grep to confirm the count): → `cookieSecureForRequest(c.env, c.req.raw)`.

Update `src/env.test.ts`: the `requireLoginEnabled` cases flip (`''`/undefined → `true`; `'0'`/`'false'`/`'no'` → `false`; `'1'` → `true`), and `cookieSecureForRequest` tests construct `new Request(url)` instead of passing a string (add a case: TRUST_PROXY='1' + `x-forwarded-proto: https` on an `http://` URL → `true`; same header with TRUST_PROXY unset → `false`).

- [ ] **Step 4: `src/auth/identity.ts` — KvStore type swap**

Replace every `kv: KVNamespace` parameter type with `kv: KvStore` and add `import type { KvStore } from '../node/kvStore';`. No logic changes — `get/put/delete` with `{ expirationTtl }` match. Also fix `src/middleware/auth.ts` if it names `KVNamespace` (locate by content; the `resolveSessionUser(c.env.AUTH, …)` call itself is unchanged).

- [ ] **Step 5: Catalog stores — `D1Database` → `CatalogDb`**

In `src/db/d1.ts` and each store it constructs (`studioRegistry.ts`, `showsStore.ts`, `authStore.ts`, `sessionIndexStore.ts`), replace the constructor parameter type `D1Database` with `CatalogDb` (+ `import type { CatalogDb } from '../node/d1Adapter';`). Grep first: `grep -rn 'D1Database\|D1PreparedStatement' src/db/` and convert every hit. No call-site logic changes.

- [ ] **Step 6: `src/middleware/ipAllowlist.ts` — socket-address derivation (spec: security-critical)**

Replace `effectiveClientIp` and its call site:

```ts
import type { Context } from 'hono';
import { trustProxyEnabled } from '../env';

/** Client IP on Node: the socket address, unless TRUST_PROXY explicitly
 * delegates to the first X-Forwarded-For hop. CF header trust is gone. */
function effectiveClientIp(c: Context<AppEnv>): string {
  if (trustProxyEnabled(c.env)) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
  }
  return c.env.incoming?.socket?.remoteAddress ?? '';
}
```

In the middleware body change `const addr = effectiveClientIp(c.req.raw);` → `const addr = effectiveClientIp(c);`. Also update the 403 message line `'…then redeploy.'` → `'…then restart the server.'` (Workers wording). Update the pure-parse unit tests in `ipAllowlist.test.ts` only if they reference `effectiveClientIp` (the CIDR-parse tests are untouched).

- [ ] **Step 7: `src/routers/_helpers.ts` — hub lookup**

```ts
import type { SessionHub } from '../durable/SessionHub';

/** Resolve the in-process per-session hub (addressed by session id). */
export function getSessionDO(c: Context<AppEnv>, sessionId: string): SessionHub {
  return c.env.SESSION_DO.get(sessionId);
}
```

(Function name stays `getSessionDO` to avoid touching every router; routers `await` its sync methods harmlessly.)

- [ ] **Step 8: `src/routers/companion.ts` — presence via the registry**

Delete `PRESENCE_PREFIX`, `PRESENCE_KV_TTL_SEC`, `PRESENCE_FRESH_MS`, the local `PresenceMeta` interface, and the `listPresence`/`primarySession` KV implementations. Replace with:

```ts
import type { PresenceRegistry } from '../node/presence';

/** Freshest live presence with a session open, preferring visible tabs (hub.primary). */
function primarySession(presence: PresenceRegistry): string | null {
  const live = presence.list().filter((p) => p.session_id);
  if (!live.length) return null;
  live.sort((a, b) => {
    const v = (b.visible ? 1 : 0) - (a.visible ? 1 : 0);
    return v !== 0 ? v : b.updated - a.updated;
  });
  return live[0].session_id;
}
```

Call-site edits (locate each by content):
- `requireActiveSession`: `const sid = await primarySession(c.env.AUTH);` → `const sid = primarySession(c.env.PRESENCE);`
- `POST /api/companion/presence`: the `closing` branch → `c.env.PRESENCE.remove(cid);`; the put → `c.env.PRESENCE.upsert(cid, meta);` (build `meta` exactly as today; type comes from `../node/presence`).
- `GET /api/companion/state`: `const presences = await listPresence(c.env.AUTH);` → `const presences = c.env.PRESENCE.list();` and `await primarySession(c.env.AUTH)` → `primarySession(c.env.PRESENCE)`.
- `LAST_COMMAND_KEY` reads/writes stay on `c.env.AUTH` unchanged.

- [ ] **Step 9: `src/routers/audio.ts` — BlobStore + 416**

- `import { InvalidRangeError } from '../node/blobStore';` and change `parseRange`'s return type annotation `R2Range` → `import type { BlobRange } from '../node/blobStore'`.
- Upload: `c.env.AUDIO.put(seg.r2_key, payload, { httpMetadata: { contentType: seg.mime_type } })` → `c.env.AUDIO.put(seg.r2_key, payload, { contentType: seg.mime_type })`.
- Ranged download: wrap the ranged `get` in a try/catch:

```ts
    let obj;
    try {
      obj = await c.env.AUDIO.get(got.r2_key, parsed ? { range: parsed } : undefined);
    } catch (e) {
      if (e instanceof InvalidRangeError) {
        throw new ApiError(416, 'Requested range not satisfiable.');
      }
      throw e;
    }
```

The `obj.range` normalization branch works unchanged (BlobStore always returns `{offset, length}`; the `'suffix' in r` branch simply never fires — leave it, it's dead-but-harmless parity code, or delete it; prefer deleting it and the `else if` with it).

- [ ] **Step 10: WS route out of `events.ts`, into a factory**

Delete the `GET /api/sessions/:sessionId/ws` handler from `events.ts`. Create:

```ts
// src/routers/sessionWs.ts
// Session WebSocket — browser tabs + Companion attach for live pushes. The
// login gate + requireSession run BEFORE the upgrade (parity with the DO path).

import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { AppEnv } from '../types';
import { requireSession } from './_helpers';

export function mountSessionWs(app: Hono<AppEnv>, upgradeWebSocket: UpgradeWebSocket): void {
  app.get(
    '/api/sessions/:sessionId/ws',
    async (c, next) => {
      await requireSession(c, c.req.param('sessionId'), { includeHidden: true });
      await next();
    },
    upgradeWebSocket((c) => {
      const sessionId = c.req.param('sessionId');
      const role =
        new URL(c.req.url).searchParams.get('role') === 'companion' ? 'companion' : 'browser';
      const hub = c.env.SESSION_DO.get(sessionId);
      return {
        onOpen(_evt, ws) {
          hub.attachSocket(ws, role);
        },
        onMessage(evt, _ws) {
          if (typeof evt.data === 'string') hub.handleSocketMessage(evt.data);
        },
        onClose(evt, ws) {
          hub.detachSocket(ws);
          try {
            ws.close(evt.code < 1000 || evt.code > 4999 ? 1000 : evt.code);
          } catch {
            // already closed
          }
        },
        onError(_evt, ws) {
          hub.detachSocket(ws);
        },
      };
    }),
  );
}
```

- [ ] **Step 11: `src/app.ts` (from `index.ts`) and `src/main.ts`**

```ts
// src/app.ts — Hono app wiring: middleware chain + router mounts + static
// serving. Mirrors src/autologger/web/app.py. The caller supplies
// upgradeWebSocket (from @hono/node-ws in main.ts; a 426 stub in HTTP tests).

import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { authContext } from './middleware/auth';
import { ipAllowlistMiddleware } from './middleware/ipAllowlist';
import { InvalidRangeError } from './node/blobStore';
import { ApiError } from './routers/_helpers';
import { adminRouter } from './routers/admin';
import { audioRouter } from './routers/audio';
import { authRouter } from './routers/auth';
import { companionRouter } from './routers/companion';
import { eventsRouter } from './routers/events';
import { exportsRouter } from './routers/exports';
import { profileRouter } from './routers/profile';
import { mountSessionWs } from './routers/sessionWs';
import { sessionsRouter } from './routers/sessions';
import { showsRouter } from './routers/shows';
import { transcribeRouter } from './routers/transcribe';
import { ValidationError } from './studio';
import type { AppEnv, Bindings } from './types';

export function wireApp(
  app: Hono<AppEnv>,
  upgradeWebSocket: UpgradeWebSocket,
  opts: { publicDir?: string; bindings?: Bindings } = {},
): Hono<AppEnv> {
  const publicDir = opts.publicDir ?? './public';

  // Bindings injection must happen HERE, not in a serve() fetch wrapper:
  // @hono/node-ws routes WebSocket upgrades through app.request() directly,
  // bypassing any wrapper. Spread keeps the adapter-provided incoming/outgoing.
  if (opts.bindings) {
    const b = opts.bindings;
    app.use('*', async (c, next) => {
      c.env = { ...b, ...c.env };
      await next();
    });
  }

  // Starlette applies middleware in reverse registration order; Hono runs them
  // in registration order. So register ipAllowlist first to keep it outermost.
  app.use('*', ipAllowlistMiddleware);
  app.use('*', authContext);

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ detail: err.detail }, err.status as 400);
    if (err instanceof ValidationError) return c.json({ detail: err.message }, 400);
    if (err instanceof ZodError) return c.json({ detail: err.issues }, 422);
    if (err instanceof InvalidRangeError) {
      return c.json({ detail: 'Requested range not satisfiable.' }, 416);
    }
    if (err instanceof SyntaxError) return c.json({ detail: 'Invalid JSON body.' }, 400);
    console.error('unhandled error', err);
    return c.json({ detail: 'Internal Server Error' }, 500);
  });

  mountSessionWs(app, upgradeWebSocket);
  app.route('/', authRouter);
  app.route('/', profileRouter);
  app.route('/', showsRouter);
  app.route('/', sessionsRouter);
  app.route('/', eventsRouter);
  app.route('/', audioRouter);
  app.route('/', companionRouter);
  app.route('/', transcribeRouter);
  app.route('/', exportsRouter);
  app.route('/', adminRouter);

  // Static hosting. __API_ROOT__ substitution is PHASE-1 TRANSITIONAL (spec:
  // scope #6) — sub-project 2 replaces it with a Vite build-time define.
  async function serveHtml(c: Context<AppEnv>, assetPath: string) {
    let html: string;
    try {
      html = await readFile(join(publicDir, assetPath), 'utf-8');
    } catch {
      return c.notFound();
    }
    return c.html(html.replaceAll('__API_ROOT__', '/api'));
  }

  app.get('/', (c) => serveHtml(c, 'src/pages/index/index.html'));
  app.get('/admin/users', (c) => serveHtml(c, 'src/pages/admin-users/index.html'));
  app.get('*', serveStatic({ root: publicDir }));

  return app;
}
```

```ts
// src/main.ts — Node entry: env config → bindings → app → listen.

import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { wireApp } from './app';
import { requireLoginEnabled } from './env';
import { createBindings } from './node/config';
import type { AppEnv } from './types';

const { bindings, close } = createBindings(process.env);
const port = Number(process.env.PORT || '8787');
const hostname = process.env.HOST || '0.0.0.0';

// Gate decision E1: login defaults ON. If the operator explicitly opened the
// API (REQUIRE_LOGIN=0) on a non-loopback bind with no allowlist, say so loudly.
const loopback = hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
if (!loopback && !requireLoginEnabled(bindings) && !(bindings.IP_ALLOWLIST || '').trim()) {
  console.warn(
    '\n' +
      '!!! WARNING: AutoLogger is binding to a NON-LOOPBACK interface with\n' +
      '!!! REQUIRE_LOGIN=0 and no IP_ALLOWLIST. Every /api route is open to\n' +
      '!!! the network. Set REQUIRE_LOGIN=1, an IP_ALLOWLIST, or HOST=127.0.0.1.\n',
  );
}

const app = new Hono<AppEnv>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
// Bindings ride in via wireApp's injection middleware — NOT a fetch wrapper —
// because @hono/node-ws upgrades bypass serve()'s fetch entirely.
wireApp(app, upgradeWebSocket, { bindings });
bindings.SESSION_DO.startSweeper();

const server = serve(
  { fetch: app.fetch, port, hostname },
  (info) => console.log(`AutoLogger (Node) listening on http://${hostname}:${info.port}`),
);
injectWebSocket(server);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      close();
      process.exit(0);
    });
  });
}
```

```ts
// src/node/config.ts — bindings construction from process env.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SessionHubRegistry } from '../durable/SessionHub';
import type { Bindings } from '../types';
import { BlobStore } from './blobStore';
import { CatalogDb } from './d1Adapter';
import { KvStore } from './kvStore';
import { applyMigrations, openCatalogDb } from './migrate';
import { PresenceRegistry } from './presence';

const MIGRATIONS_DIR = join(process.cwd(), 'src/db/migrations');

export function createBindings(procEnv: Record<string, string | undefined>): {
  bindings: Bindings;
  close(): void;
} {
  const dataDir = procEnv.DATA_DIR || './data';
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  // r2 keys already start with "audio/", so the blob root is a sibling dir:
  // bytes land at DATA_DIR/blobs/audio/<sid>/…  tmp stays OUTSIDE the root
  // so listings/reconciliation never see partial writes.
  mkdirSync(join(dataDir, 'blobs'), { recursive: true });
  mkdirSync(join(dataDir, 'tmp'), { recursive: true });

  const catalog = openCatalogDb(join(dataDir, 'catalog.db'));
  applyMigrations(catalog, MIGRATIONS_DIR);
  const auth = new KvStore(catalog);
  auth.purgeExpired(); // startup hygiene — no sweep timer (spec)
  const registry = new SessionHubRegistry(join(dataDir, 'sessions'));

  const bindings: Bindings = {
    DB: new CatalogDb(catalog),
    AUTH: auth,
    SESSION_DO: registry,
    AUDIO: new BlobStore(join(dataDir, 'blobs'), join(dataDir, 'tmp')),
    PRESENCE: new PresenceRegistry(),
    PUBLIC_BASE_URL: procEnv.PUBLIC_BASE_URL || '',
    GOOGLE_CLIENT_ID: procEnv.GOOGLE_CLIENT_ID || '',
    GOOGLE_CLIENT_SECRET: procEnv.GOOGLE_CLIENT_SECRET || '',
    REQUIRE_LOGIN: procEnv.REQUIRE_LOGIN || '',
    SESSION_COOKIE: procEnv.SESSION_COOKIE || '',
    SESSION_DAYS: procEnv.SESSION_DAYS || '14',
    NEW_USER_ALL_TEAMS: procEnv.NEW_USER_ALL_TEAMS || '0',
    COOKIE_SECURE: procEnv.COOKIE_SECURE || '',
    IP_ALLOWLIST: procEnv.IP_ALLOWLIST || '',
    TRUST_PROXY: procEnv.TRUST_PROXY || '',
    API_TOKEN: procEnv.API_TOKEN || '',
    ADMIN_TOKEN: procEnv.ADMIN_TOKEN || '',
  };
  return {
    bindings,
    close: () => {
      registry.closeAll();
      catalog.close();
    },
  };
}
```


- [ ] **Step 12: Delete `src/index.ts` and `src/durable/SessionDO.ts`; fix imports**

`grep -rn "from '../durable/SessionDO'\|from './SessionDO'\|from '../index'\|from './index'" src/` → re-point every type import to `../durable/SessionHub` (the re-exports match). Delete both files.

- [ ] **Step 13: package.json scripts**

Replace the entire `scripts` block with exactly these four (this removes `cf-typegen`, `deploy`, and `migrate:local` now — migrations run at startup; Task 16 only removes the CF *packages*):

```json
"scripts": {
  "dev": "tsx watch --env-file-if-exists=.env src/main.ts",
  "start": "tsx --env-file-if-exists=.env src/main.ts",
  "typecheck": "tsc --noEmit",
  "test": "vitest run"
}
```

- [ ] **Step 14: Verify**

Run: `npm run typecheck` → green.
Run: `npm test` → unit tier green (integration excluded).
Run: `DATA_DIR=/tmp/claude-autolog-smoke REQUIRE_LOGIN=0 npx tsx src/main.ts &` then `sleep 2 && curl -s http://127.0.0.1:8787/api/profile | head -c 200; kill %1`
Expected: JSON profile payload (anonymous profile). Also verify the flipped default: `DATA_DIR=/tmp/claude-autolog-smoke2 npx tsx src/main.ts &` + `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/sessions` → `401`; kill it.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat(node)!: cut the app over to Node bindings (better-sqlite3/fs/in-process hubs); int tier offline pending harness"
```

---

## Phase C — integration suites on the Node harness

### Task 11: Node test harness + mechanical suite port

**Files:**
- Create: `src/test/harness.ts`
- Rewrite: `src/test/setup.int.ts`, `src/test/helpers.ts`
- Modify (imports + envWith base only): `src/db/d1.int.test.ts`, `src/routers/gate.int.test.ts`, `src/routers/flows.int.test.ts`, `src/routers/sessions.int.test.ts`, `src/routers/shows-profile.int.test.ts`, `src/routers/admin.int.test.ts`, `src/routers/companion.int.test.ts`, `src/routers/transcribe.int.test.ts`, `src/test/smoke.int.test.ts`, `src/durable/SessionDO.int.test.ts` → handled in Task 13 (leave excluded), `src/middleware/ipAllowlist.int.test.ts` → Task 12 (leave excluded)
- Modify: `vitest.workspace.ts`, `tsconfig.json`

**Interfaces:**
- Produces:
  ```ts
  // src/test/harness.ts
  export const env: Bindings;            // Proxy over the current per-test bindings (spread-safe)
  export const app: Hono<AppEnv>;        // wired once with a 426-stub upgradeWebSocket
  export function resetTestEnv(): void;  // fresh temp DATA_DIR + bindings (beforeEach)
  export function teardownTestEnv(): void;
  ```
  Per-test isolation (Miniflare's `isolatedStorage` equivalent): `setup.int.ts` rebuilds bindings in `beforeEach`, so the global `companion:last_command` assertions stay order-independent.

- [ ] **Step 1: Write the harness**

```ts
// src/test/harness.ts
// Per-test Node bindings over a temp DATA_DIR — the isolatedStorage equivalent.
// `env` is a Proxy so existing `{...env, ...overrides}` spreads keep working.

import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpgradeWebSocket } from 'hono/ws';
import { wireApp } from '../app';
import { createBindings } from '../node/config';
import type { AppEnv, Bindings } from '../types';

let current: { bindings: Bindings; close(): void; dir: string } | null = null;

export function resetTestEnv(): void {
  teardownTestEnv();
  const dir = mkdtempSync(join(tmpdir(), 'autologger-int-'));
  const made = createBindings({
    DATA_DIR: dir,
    PUBLIC_BASE_URL: 'https://example.com',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    REQUIRE_LOGIN: '0', // mirrors the old wrangler.jsonc test default; gate tests override per-request
    SESSION_COOKIE: 'autologger_sid',
    SESSION_DAYS: '14',
    NEW_USER_ALL_TEAMS: '0',
    COOKIE_SECURE: '',
    IP_ALLOWLIST: '',
    TRUST_PROXY: '',
    API_TOKEN: 'test-api-token',
    ADMIN_TOKEN: 'test-admin-token',
  });
  current = { ...made, dir };
}

export function teardownTestEnv(): void {
  if (!current) return;
  current.close();
  rmSync(current.dir, { recursive: true, force: true });
  current = null;
}

function must(): Bindings {
  if (!current) throw new Error('test env not initialized — is setup.int.ts registered?');
  return current.bindings;
}

export const env: Bindings = new Proxy({} as Bindings, {
  get: (_t, p) => (must() as unknown as Record<string | symbol, unknown>)[p],
  has: (_t, p) => p in must(),
  ownKeys: () => Reflect.ownKeys(must()),
  getOwnPropertyDescriptor: (_t, p) => ({
    enumerable: true,
    configurable: true,
    value: (must() as unknown as Record<string | symbol, unknown>)[p],
  }),
});

const upgradeStub = ((() => async (c: { text(b: string, s: number): Response }) =>
  c.text('WebSocket unavailable in HTTP tests', 426)) as unknown) as UpgradeWebSocket;

export const app = wireApp(new Hono<AppEnv>(), upgradeStub);
```

```ts
// src/test/setup.int.ts
import { afterEach, beforeEach } from 'vitest';
import { resetTestEnv, teardownTestEnv } from './harness';

beforeEach(() => resetTestEnv());
afterEach(() => teardownTestEnv());
```

- [ ] **Step 2: Rewrite `src/test/helpers.ts` headers**

Change only the import and the two KV-touching helpers; every seed function body stays identical:

```ts
// old: import { env } from 'cloudflare:test';
import { env } from './harness';
```

`loginCookie` is unchanged (`createLoginSession(env.AUTH, …)` now hits KvStore). Replace `setCompanionPresence`:

```ts
/** Register companion presence so primarySession() resolves to sessionId. */
export function setCompanionPresence(
  clientId: string,
  sessionId: string,
  opts: { visible?: boolean; is_playing?: boolean } = {},
): void {
  env.PRESENCE.upsert(clientId, {
    session_id: sessionId,
    visible: opts.visible ?? true,
    is_playing: opts.is_playing ?? false,
    updated: Date.now(),
  });
}
```

(Callers `await` it today — an awaited `void` is fine; keep their call sites untouched.)

- [ ] **Step 3: Re-enable the integration project**

`vitest.workspace.ts` — add the second project:

```ts
  {
    test: {
      name: 'integration',
      include: ['src/**/*.int.test.ts'],
      exclude: [
        'src/routers/auth.int.test.ts',
        'src/durable/SessionDO.int.test.ts',
        'src/routers/companion-ws.int.test.ts',
        'src/middleware/ipAllowlist.int.test.ts',
      ],
      environment: 'node',
      setupFiles: ['./src/test/setup.int.ts'],
    },
  },
```

`tsconfig.json` — narrow the exclude: `setup.int.ts` and `helpers.ts` are rewritten in this task so they come OUT of the exclude; `oauth.ts` stays excluded until Task 13:

```json
"exclude": [
  "src/routers/auth.int.test.ts",
  "src/durable/SessionDO.int.test.ts",
  "src/routers/companion-ws.int.test.ts",
  "src/middleware/ipAllowlist.int.test.ts",
  "src/test/oauth.ts"
]
```

- [ ] **Step 4: Mechanical import swap in the nine portable suites**

In each of `d1.int.test.ts`, `gate.int.test.ts`, `flows.int.test.ts`, `sessions.int.test.ts`, `shows-profile.int.test.ts`, `admin.int.test.ts`, `companion.int.test.ts`, `transcribe.int.test.ts`, `smoke.int.test.ts`:

- `import { env } from 'cloudflare:test';` → `import { env } from '../test/harness';` (path-adjust for `src/db/` and `src/test/`).
- `import app from '../index';` → `import { app } from '../test/harness';`
- Nothing else changes — `app.request(path, init, envWith({...}))` and all helper calls stay as written.

Suites whose assertions depend on the old default (`REQUIRE_LOGIN=0` came from wrangler vars) already get it from the harness base env. If any test constructs `envWith({})` expecting `ADMIN_TOKEN` present, the harness supplies `test-admin-token` (mirrors `.dev.vars`).

- [ ] **Step 5: Run and fix expectation drift**

Run: `npm run typecheck && npm test`
Expected: unit + integration green. Two drift classes are pre-authorized fixes (anything else: STOP and investigate, don't paper over):
1. A test asserting KV-presence internals (e.g. reading `env.AUTH` for a presence key) — rewrite the assertion against `env.PRESENCE.list()`.
2. Timing: `Date.now()`-based freshness in the same tick — unchanged semantics, should not drift; do not add sleeps.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(node): per-test Node harness + port nine integration suites off Miniflare"
```

---

### Task 12: ipAllowlist integration suite (socket-address + TRUST_PROXY)

**Files:**
- Rewrite: `src/middleware/ipAllowlist.int.test.ts`
- Modify: `vitest.workspace.ts`, `tsconfig.json` (remove this file from both excludes)

**Interfaces:**
- Consumes: harness `app`/`env`; `Bindings.incoming` (fake socket injection).

- [ ] **Step 1: Rewrite the suite**

Read the old file first for its scenario list (allow, deny, disabled, bad-config → 500), then rewrite each scenario using injected socket addresses. New content:

```ts
// src/middleware/ipAllowlist.int.test.ts
import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import type { Bindings } from '../types';

/** Simulate the @hono/node-server env: bindings + a fake socket peer. */
const envFrom = (remoteAddress: string, overrides: Record<string, string> = {}): Bindings =>
  ({
    ...env,
    ...overrides,
    incoming: { socket: { remoteAddress } },
  }) as unknown as Bindings;

describe('ip allowlist on Node', () => {
  it('is disabled when IP_ALLOWLIST is empty', async () => {
    const res = await app.request('/api/profile', {}, envFrom('203.0.113.7'));
    expect(res.status).toBe(200);
  });

  it('allows a socket address inside the CIDR and blocks one outside', async () => {
    const allow = { IP_ALLOWLIST: '203.0.113.0/24' };
    expect((await app.request('/api/profile', {}, envFrom('203.0.113.7', allow))).status).toBe(200);
    expect((await app.request('/api/profile', {}, envFrom('198.51.100.1', allow))).status).toBe(403);
  });

  it('matches the v6-mapped loopback the Node socket reports', async () => {
    const allow = { IP_ALLOWLIST: '127.0.0.1' };
    expect((await app.request('/api/profile', {}, envFrom('::ffff:127.0.0.1', allow))).status).toBe(
      200,
    );
  });

  it('ignores X-Forwarded-For unless TRUST_PROXY is on (anti-spoof)', async () => {
    const allow = { IP_ALLOWLIST: '203.0.113.0/24' };
    const spoof = await app.request(
      '/api/profile',
      { headers: { 'x-forwarded-for': '203.0.113.7' } },
      envFrom('198.51.100.1', allow),
    );
    expect(spoof.status).toBe(403);
    const trusted = await app.request(
      '/api/profile',
      { headers: { 'x-forwarded-for': '203.0.113.7' } },
      envFrom('198.51.100.1', { ...allow, TRUST_PROXY: '1' }),
    );
    expect(trusted.status).toBe(200);
  });

  it('blocks when no address is derivable (no socket, no trusted header)', async () => {
    const res = await app.request(
      '/api/profile',
      {},
      { ...env, IP_ALLOWLIST: '203.0.113.0/24' } as unknown as Bindings,
    );
    expect(res.status).toBe(403);
  });

  it('bad allowlist config → 500 via onError', async () => {
    const res = await app.request('/api/profile', {}, envFrom('1.2.3.4', { IP_ALLOWLIST: 'garbage!!' }));
    expect(res.status).toBe(500);
  });
});
```

Note the module-level parse cache in `ipAllowlist.ts` keys on the raw string, so per-test different `IP_ALLOWLIST` values re-parse correctly.

- [ ] **Step 2: Remove the file from both exclude lists, run, commit**

```bash
npm run typecheck && npm test
git add -A
git commit -m "test(node): ipAllowlist integration suite — socket-address trust + TRUST_PROXY"
```

---

### Task 13: OAuth suite on a Node fetch mock

**Files:**
- Rewrite: `src/test/oauth.ts` (keep `makeKeypair`/`mintIdToken` verbatim; replace the two mock functions)
- Modify: `src/routers/auth.int.test.ts` (imports only)
- Modify: `vitest.workspace.ts`, `tsconfig.json` (remove from excludes)

- [ ] **Step 1: Replace the fetchMock helpers in `src/test/oauth.ts`**

Try undici's MockAgent first (it shares Node's global-dispatcher symbol via `Symbol.for`, so it intercepts built-in `fetch` on Node 22):

```ts
// replace: import { fetchMock } from 'cloudflare:test';
import { MockAgent, setGlobalDispatcher } from 'undici';

let agent: MockAgent | null = null;

function mockAgent(): MockAgent {
  if (!agent) {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  }
  return agent;
}

export function mockGoogleToken(body: unknown, status = 200): void {
  mockAgent()
    .get('https://oauth2.googleapis.com')
    .intercept({ path: '/token', method: 'POST' })
    .reply(status, JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
}

export function mockGoogleJwks(publicJwk: JsonWebKey): void {
  mockAgent()
    .get('https://www.googleapis.com')
    .intercept({ path: '/oauth2/v3/certs', method: 'GET' })
    .reply(200, JSON.stringify({ keys: [publicJwk] }), {
      headers: { 'content-type': 'application/json' },
    });
}
```

**Fallback (only if a test proves the dispatcher isn't shared — symptom: real network attempt / ENOTFOUND):** replace with a `vi.stubGlobal('fetch', …)` router keyed on `(method, origin+path)` that returns queued `Response` objects; keep the same two exported function signatures.

- [ ] **Step 2: Re-point `auth.int.test.ts` imports** (`cloudflare:test` env → harness env, `../index` app → harness app, same as Task 11 pattern), then remove BOTH `src/routers/auth.int.test.ts` and `src/test/oauth.ts` from the tsconfig exclude and the file from the vitest exclude.

- [ ] **Step 3: Run, fix, commit**

Run: `npx vitest run src/routers/auth.int.test.ts` → PASS; then full `npm run typecheck && npm test`.

```bash
git add -A
git commit -m "test(node): oauth e2e suite via undici MockAgent"
```

---

### Task 14: SessionHub integration tests (replaces SessionDO.int.test.ts)

**Files:**
- Delete: `src/durable/SessionDO.int.test.ts`
- Create: `src/durable/SessionHub.int.test.ts`
- Modify: `vitest.workspace.ts`, `tsconfig.json` (drop from excludes)

The old suite exercised DO internals via `runInDurableObject` + `storage.getAlarm()`; the hub equivalents are direct method calls (Task 9's unit tests already cover timers). This suite covers the **router↔hub↔catalog projection** path that `runInDurableObject` used to reach.

- [ ] **Step 1: Write the suite**

```ts
// src/durable/SessionHub.int.test.ts
import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import { seedSession, seedShow, seedStudio, SEED_CATEGORY_ID } from '../test/helpers';

async function seeded(): Promise<string> {
  const show = await seedShow({ studioId: await seedStudio() });
  return seedSession({ showId: show });
}

describe('hub ↔ catalog projection', () => {
  it('logging an event bumps the projected event_count on the catalog row', async () => {
    const s = await seeded();
    const res = await app.request(
      `/api/sessions/${s}/log`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: SEED_CATEGORY_ID, message: 'hello' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT event_count FROM sessions WHERE id = ?')
      .bind(s)
      .first<{ event_count: number }>();
    expect(row?.event_count).toBe(1);
  });

  it('start/stop take round-trips is_rolling through hub and projection', async () => {
    const s = await seeded();
    const start = await app.request(`/api/sessions/${s}/transport/start`, { method: 'POST' }, env);
    expect(start.status).toBe(200);
    const status = await app.request(`/api/sessions/${s}/status`, {}, env);
    expect(((await status.json()) as { is_rolling: boolean }).is_rolling).toBe(true);
    const stop = await app.request(`/api/sessions/${s}/transport/stop`, { method: 'POST' }, env);
    expect(stop.status).toBe(200);
  });

  it('hub state persists across registry eviction (reopen from disk)', async () => {
    const s = await seeded();
    await app.request(
      `/api/sessions/${s}/log`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: SEED_CATEGORY_ID, message: 'persisted' }),
      },
      env,
    );
    env.SESSION_DO.evictIdle(0); // force-close every idle hub
    const events = await app.request(`/api/sessions/${s}/events`, {}, env);
    const body = (await events.json()) as { events: Array<{ message: string }> };
    expect(body.events.some((e) => e.message === 'persisted')).toBe(true);
  });

  it('recording lease claim/conflict/release over HTTP', async () => {
    const s = await seeded();
    const claim = (cid: string) =>
      app.request(
        `/api/sessions/${s}/audio-recording-lease`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: cid }),
        },
        env,
      );
    expect((await claim('tab-a')).status).toBe(200);
    expect((await claim('tab-b')).status).toBe(409);
    const release = await app.request(
      `/api/sessions/${s}/audio-recording-lease/release`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: 'tab-a' }),
      },
      env,
    );
    expect(release.status).toBe(200);
    expect((await claim('tab-b')).status).toBe(200);
  });
});
```

Before finalizing, open the OLD `SessionDO.int.test.ts` (git: `git show HEAD~1:src/durable/SessionDO.int.test.ts` if already deleted in your working state — otherwise just read it) and carry over any scenario not covered above or by Task 9's unit tests (e.g. specific status payload fields). Route paths above are the parity surface — verify each against the routers (`events.ts`, `sessions.ts`) by content and adjust paths/response keys to what the routers actually serve (e.g. the log endpoint may be `/api/sessions/:id/events` POST — check `logBodySchema` usage).

- [ ] **Step 2: Remove from excludes, run, fix path/shape drift against the real routers, commit**

```bash
npm run typecheck && npm test
git add -A
git commit -m "test(node): hub↔catalog integration suite replacing runInDurableObject tests"
```

---

### Task 15: Companion WebSocket suite on a real server

**Files:**
- Rewrite: `src/routers/companion-ws.int.test.ts`
- Modify: `vitest.workspace.ts`, `tsconfig.json` (drop the last excludes; integration `exclude` list should now be empty — remove the key)

- [ ] **Step 1: Rewrite using a listening server + global WebSocket**

Keep the old file's scenario list (delivery of a posted command; re-broadcast of a client-sent command; any close-code assertions). New harness portion:

```ts
// src/routers/companion-ws.int.test.ts
import { serve, type ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireApp } from '../app';
import { env } from '../test/harness';
import { seedSession, seedShow, seedStudio, setCompanionPresence } from '../test/helpers';
import type { AppEnv } from '../types';

let server: ServerType;
let port: number;

beforeAll(async () => {
  const app = new Hono<AppEnv>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  // env is a Proxy resolving per-test; wireApp's injection middleware spreads it
  // at request time, so both HTTP and WS-upgrade paths see the current bindings.
  wireApp(app, upgradeWebSocket, { bindings: env });
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  injectWebSocket(server);
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

async function seededSession(): Promise<string> {
  const show = await seedShow({ studioId: await seedStudio() });
  return seedSession({ showId: show });
}

function connect(sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(e));
  });
}

function nextMessage(ws: WebSocket, ms = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws message timeout')), ms);
    ws.addEventListener('message', (e) => {
      clearTimeout(t);
      resolve(typeof e.data === 'string' ? e.data : '');
    });
  });
}

describe('companion WebSocket relay (Node)', () => {
  it('delivers a posted command over the session WebSocket', async () => {
    const s = await seededSession();
    const ws = await connect(s);
    const got = nextMessage(ws);
    setCompanionPresence('c1', s);
    const cmd = await fetch(`http://127.0.0.1:${port}/api/companion/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'record-start' }),
    });
    expect(cmd.status).toBe(200);
    expect(JSON.parse(await got)).toMatchObject({ type: 'command', command: 'record-start' });
    ws.close();
  });

  it('re-broadcasts a command sent BY a connected client', async () => {
    const s = await seededSession();
    const sender = await connect(s);
    const receiver = await connect(s);
    const got = nextMessage(receiver);
    sender.send(JSON.stringify({ type: 'command', command: 'play-toggle' }));
    expect(JSON.parse(await got)).toMatchObject({ type: 'command', command: 'play-toggle' });
    sender.close();
    receiver.close();
  });

  it('rejects the upgrade for an unknown session (404 before upgrade)', async () => {
    await expect(connect('does-not-exist')).rejects.toBeTruthy();
  });
});
```

Carry over any remaining scenarios from the old file (read it first) — e.g. an ack/last_command flow — using `fetch(...)` against the live port so presence/kv state and the WS share the same per-test env.

**One caveat to verify while running:** the per-test `resetTestEnv()` rebuilds bindings, and the `beforeAll` server closure spreads `{ ...env }` per request — that resolves the Proxy at request time, so each test hits its own fresh bindings. WebSocket connections opened in one test must be closed in that test.

- [ ] **Step 2: Run, fix, remove the exclude machinery, commit**

```bash
npm run typecheck && npm test
git add -A
git commit -m "test(node): companion WS relay suite on a real @hono/node-ws server"
```

---

## Phase D — remove Cloudflare

### Task 16: Delete CF tooling, docs rewrite, version bump

**Files:**
- Delete: `wrangler.jsonc`, `worker-configuration.d.ts`, `src/test/setup.int.ts`'s old CF remnants if any survive, `public/` note stays (still the served artifact)
- Modify: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `README.md`, `CLAUDE.md`
- Create: `.env.example`

- [ ] **Step 1: Drop CF packages and scripts**

```bash
npm uninstall wrangler @cloudflare/vitest-pool-workers
```

`package.json`: remove the `cf-typegen`, `deploy`, `migrate:local` scripts (if any linger); set `"version": "0.4.0"`; add `"engines": { "node": ">=22" }`.

- [ ] **Step 2: Delete config artifacts**

```bash
git rm wrangler.jsonc worker-configuration.d.ts
```

`tsconfig.json`: confirm `types: ["node"]`, `include: ["src/**/*.ts"]`, no stale excludes. Search for stragglers: `grep -rn "cloudflare\|wrangler\|WebSocketPair\|DurableObject\|KVNamespace\|R2Bucket\|R2Range\|D1Database\|SqlStorage" src/ package.json tsconfig.json vitest.workspace.ts` — every hit must be a comment describing history or must be removed (update comments that describe CF behavior as current).

- [ ] **Step 3: `.env.example` + `.gitignore`**

```bash
# .env.example — copy to .env (gitignored). Node reads it via --env-file-if-exists.
# Where SQLite DBs + audio bytes live:
DATA_DIR=./data
HOST=0.0.0.0
PORT=8787

# Auth (gate decision E1: login is REQUIRED unless you explicitly set 0).
# For an open LAN-studio box: REQUIRE_LOGIN=0 (the server warns loudly on
# non-loopback binds with no IP_ALLOWLIST).
REQUIRE_LOGIN=1
PUBLIC_BASE_URL=http://127.0.0.1:8787
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Optional hardening / proxy:
IP_ALLOWLIST=
TRUST_PROXY=0
COOKIE_SECURE=
SESSION_COOKIE=autologger_sid
SESSION_DAYS=14
NEW_USER_ALL_TEAMS=0

# Machine tokens:
API_TOKEN=
ADMIN_TOKEN=
```

Add `.env` to `.gitignore` (keep `.dev.vars` entry harmlessly or remove it; `git rm .dev.vars.example` and delete the file).

- [ ] **Step 4: README + CLAUDE.md rewrite**

Rewrite the architecture sections to describe the Node stack. Required content (author the prose; keep both docs' existing structure):
- Stack line: Hono + better-sqlite3 + filesystem blobs + in-process SessionHub per session + `@hono/node-ws`, served by `@hono/node-server`.
- Storage map: `DATA_DIR/catalog.db` (catalog + kv), `DATA_DIR/sessions/<id>.db` (per-session), `DATA_DIR/blobs/audio/…` (bytes), `DATA_DIR/tmp` (atomic-put staging).
- Commands: `npm install`, `cp .env.example .env`, `npm run dev`, `npm test`, `npm run typecheck`.
- **Invariants (spec):** single Node process; SessionHub RPC bodies are synchronous (zero awaits) — async work lives in routers; hub mutations are transactional; idle hubs close their DB handles and reopen lazily.
- Security: client IP = socket address, `TRUST_PROXY=1` delegates to `X-Forwarded-For`/`X-Forwarded-Proto`; `REQUIRE_LOGIN` defaults ON (gate E1); startup warning on open non-loopback binds.
- Remove: all wrangler/Miniflare/cutover/provisioning sections, the `.dev.vars` references, the "Local-only through phase 7" framing (replaced by "runs anywhere Node 22 runs").
- Keep: transcription/YouTube import remain `503`; `restart_supported` stays `false` (gate E2); Python-parity contract statement; `public/` is still a reproducible build artifact until sub-project 2.
- **Known parity windows** (spec — acknowledge so nobody "fixes" them with a cross-DB transaction): catalog projection can be momentarily stale after a crash; ghost metadata rows (segment row whose bytes never landed) have no reaper; uploads buffer up to 50 MB per request in one heap (operational limit — no request-body streaming, no connection cap).

- [ ] **Step 5: Final verification**

```bash
npm run typecheck && npm test
DATA_DIR=/tmp/claude-autolog-final npx tsx src/main.ts &
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/sessions   # expect 401 (login default ON)
curl -s http://127.0.0.1:8787/api/profile | head -c 120                        # expect anonymous profile JSON
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore!: remove Cloudflare tooling — AutoLogger is a portable Node server (v0.4.0)"
```

---

## Plan self-review (performed at authoring time)

- **Spec coverage:** runtime/entry (T10), config surface incl. `TRUST_PROXY`+E1 (T10, T16), client-IP derivation (T10 S6, T12), D1 adapter decision (T4), migrator + fresh-start rule (T5), pragmas incl. FK (T5, T9), kv without sweep timer (T6, config purge in T10), presence registry (T8, T10 S8), SessionHub full contract — txn-per-RPC, sync invariant, single-slot timer, `expireIfStale` on open, socket roles, idle eviction for fds (T9), blob store — ranges, 416, atomic put, list shape, traversal guard (T7, T10 S9), WS route with pre-upgrade gate (T10 S10, T15), static + transitional `__API_ROOT__` (T10 S11), tests — per-test isolation, undici mock with fallback, hub-direct tests, real WS server (T11–T15), removal list + docs + E2 (T16). Out-of-scope items (transcribe 503, no clustering, no restart) require no task — they're already the code's behavior.
- **Type consistency:** `SessionCtx`/`AttachedSocket` defined in T3, consumed in T9; `CatalogDb`/`CatalogStmt` defined T4, consumed T10 S5; `Bindings.PRESENCE` defined T10 S2, consumed T10 S8 + T11; `BlobRange`/`InvalidRangeError` defined T7, consumed T10 S9 + app.onError. `getSessionDO` keeps its name/shape.
- **Placeholders:** none — every code step carries the code; the two "author the prose" steps (T16 S4) and "carry over scenarios from the old file" steps (T14/T15) name the exact required content/source.
- **Known judgment calls encoded:** blob root is `DATA_DIR/blobs` (keys already start with `audio/`); the E1 default flip lives in `env.ts` with the harness pinning `REQUIRE_LOGIN=0` to preserve existing suite semantics; `HOST` env var added (analogous to `PORT`; spec's config table silence noted); vitest lands on TWO node projects (unit + integration) rather than the spec's "single project (or deleted)" — the integration tier needs `setupFiles` the unit tier must not run.

## Plan review log

### 2026-07-09 — Single plan reviewer (spec coverage / buildability / decomposition), fixes applied

- **B1 fixed:** `@hono/node-server` pinned to `^1.19.11` (`@hono/node-ws@1.x` peer range; npm 9 ERESOLVE hard-fails v2).
- **B2 fixed:** bindings injection moved from a `serve()` fetch wrapper into a `wireApp({ bindings })` first-middleware — `@hono/node-ws` upgrades call `app.request()` directly and bypass any wrapper (WS would have had `c.env.DB === undefined`). `main.ts` and Task 15 updated.
- **B3 fixed:** Task 3 now includes the `SqlStorageValue` → `SqlValue` type-name edits in `topicStore.ts`/`transcriptStore.ts` (they'd have failed Task 3's green gate).
- **B4 fixed:** Task 10 gained a Step-0 inventory grep; tsconfig excludes extended to `setup.int.ts`/`helpers.ts`/`oauth.ts` until their rewrite tasks; `profile.ts` gets its `Env` import.
- **Major fixed:** timer fields typed `ReturnType<typeof setTimeout/setInterval>` (Workers ambient `setTimeout` returns `number` and coexists through Phase A).
- **Minors fixed:** session DBs get `foreign_keys=ON`; Task 10 S13 scripts block made exact; blob-root correction folded into the code; auth.ts call-site count corrected; unused smoke-env file dropped; Task 16 grep pattern gained `SqlStorage`/`R2Range`; parity-windows README note added; vitest two-project deviation recorded above.
- **Verified clean by the reviewer:** `SqlStorage` cursor satisfies the Task 3 seam (`toArray()`/`rowsWritten` present in the generated types); better-sqlite3 import/type idioms compile under this tsconfig; `serve()` passes `{incoming}` env on the HTTP path; only `companion-ws.int.test.ts` uses `SELF`; Task 9's test literals match `EventStore.addEvent`; the harness `env` Proxy supports the suites' spreads; migration list matches disk; undici MockAgent risk properly hedged with a fallback.
