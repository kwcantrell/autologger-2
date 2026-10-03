// A test-only `CatalogRoot` wrapper that rewrites the outcome of one user-bound statement
// (catalog-policies design D10), so a route's answer to a policy outcome is pinned before any
// policy can produce it: an UPDATE/DELETE that changes no row, a read that finds no row, or a
// thrown error such as `CatalogForbiddenError`. The rewritten statement is not sent. Statements on
// system handles pass through. Pass it to one request with `envWith({}, { catalog: rewriting })`.
//
// A rewrite is one-shot: the first user-bound statement matching its pattern (root or inside a
// transaction) gets the outcome; later matches run normally.

import type { CatalogDb, CatalogRoot } from '@autologger/ports';

export type Outcome = { changes: 0 } | { noRow: true } | { throws: () => Error };

interface Rule {
  pattern: RegExp;
  outcome: Outcome;
  used: boolean;
}

class RewritingHandle implements CatalogDb {
  constructor(
    private readonly inner: CatalogDb,
    private readonly rules: Rule[],
  ) {}

  private match(sql: string): Outcome | null {
    const r = this.rules.find((x) => !x.used && x.pattern.test(sql));
    if (!r) return null;
    r.used = true;
    if ('throws' in r.outcome) throw r.outcome.throws();
    return r.outcome;
  }

  async all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
    if (this.match(sql)) return [];
    return this.inner.all<T>(sql, ...binds);
  }

  async first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
    if (this.match(sql)) return null;
    return this.inner.first<T>(sql, ...binds);
  }

  async run(sql: string, ...binds: unknown[]): Promise<{ changes: number }> {
    if (this.match(sql)) return { changes: 0 };
    return this.inner.run(sql, ...binds);
  }

  tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    return this.inner.tx((t) => fn(new RewritingHandle(t, this.rules)));
  }
}

export class RewritingCatalog implements CatalogRoot {
  private readonly rules: Rule[] = [];

  constructor(private readonly root: CatalogRoot) {}

  /** Give the first user-bound statement matching `pattern` this outcome. */
  rewrite(pattern: RegExp, outcome: Outcome): void {
    this.rules.push({ pattern, outcome, used: false });
  }

  /** Whether the rewrite for `pattern` has been applied. */
  applied(pattern: RegExp): boolean {
    return this.rules.some((r) => r.used && r.pattern.source === pattern.source);
  }

  bindUser(userId: string): CatalogDb {
    return new RewritingHandle(this.root.bindUser(userId), this.rules);
  }

  bindSystem(reason: string): CatalogDb {
    return this.root.bindSystem(reason);
  }

  close(): Promise<void> {
    return this.root.close();
  }
}
