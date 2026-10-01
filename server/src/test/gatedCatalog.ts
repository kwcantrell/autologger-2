// A `CatalogDb` that can hold one statement until the test releases it (catalog-concurrency-hazards
// D1), so a test can stop request A at a chosen statement, let request B commit, then let A go.
// Pass it to one request with `envWith({}, { catalog: gated })`; KV and the mirror hold their own
// adapter, so a test that races them builds those on the gated catalog too.
//
// A hold is one-shot: the first statement matching its pattern waits; after `release()` every
// later match passes, so a transaction body re-run after a serialization failure can't deadlock.

import type { CatalogDb } from '@autologger/ports';

export interface Hold {
  /** Resolves when a matching statement has arrived and is waiting. */
  reached: Promise<void>;
  release(): void;
}

interface Pending {
  pattern: RegExp;
  after: boolean;
  armed: boolean;
  arrive: () => void;
  gate: Promise<void>;
}

class Gates {
  private holds: Pending[] = [];

  hold(pattern: RegExp, after = false): Hold {
    let arrive!: () => void;
    let open!: () => void;
    const reached = new Promise<void>((r) => {
      arrive = r;
    });
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const p: Pending = { pattern, after, armed: true, arrive, gate };
    this.holds.push(p);
    return { reached, release: open };
  }

  async pass(sql: string, after = false): Promise<void> {
    const p = this.holds.find((h) => h.armed && h.after === after && h.pattern.test(sql));
    if (!p) return;
    p.armed = false;
    p.arrive();
    await p.gate;
  }
}

class GatedHandle implements CatalogDb {
  constructor(
    protected readonly inner: CatalogDb,
    protected readonly gates: Gates,
  ) {}

  async all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
    await this.gates.pass(sql);
    const r = await this.inner.all<T>(sql, ...binds);
    await this.gates.pass(sql, true);
    return r;
  }

  async first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
    await this.gates.pass(sql);
    const r = await this.inner.first<T>(sql, ...binds);
    await this.gates.pass(sql, true);
    return r;
  }

  async run(sql: string, ...binds: unknown[]): Promise<{ changes: number }> {
    await this.gates.pass(sql);
    const r = await this.inner.run(sql, ...binds);
    await this.gates.pass(sql, true);
    return r;
  }

  tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    return this.inner.tx((t) => fn(new GatedHandle(t, this.gates)));
  }
}

export class GatedCatalog extends GatedHandle {
  constructor(inner: CatalogDb) {
    super(inner, new Gates());
  }

  /** Hold the first statement whose SQL matches `pattern`, before it is sent, until `release()`. */
  hold(pattern: RegExp): Hold {
    return this.gates.hold(pattern);
  }

  /** Hold the first statement whose SQL matches `pattern` after it has run, before its result
   * returns to the caller, until `release()`. */
  holdAfter(pattern: RegExp): Hold {
    return this.gates.hold(pattern, true);
  }
}
