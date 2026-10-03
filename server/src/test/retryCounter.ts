// Test-only retry counter (catalog-policies design D11; no production surface). It wraps a
// `CatalogRoot` and counts how many times each `tx` call ran its body: the adapter re-runs a body
// on a `40001`/`40P01` (core-ports-architecture "The Postgres catalog adapter"), so `runs - 1` is
// the number of retries of one call. Each settled call appends one JSON line
// `{"runs":n,"codes":[...],"exhausted":bool}` to `logPath` (one small `appendFileSync`, atomic
// under O_APPEND, so safe across vitest workers) and to `calls`.
// - `codes` are the string `code`s of errors the body threw, in order (errors without one, such as
//   an `ApiError`, are not listed); a re-run with no code recorded was a commit-time failure.
// - `exhausted` is a call that rejected with `40001`/`40P01`: the adapter gave up retrying.
// - A `tx` nested on the body's handle joins the open transaction through the adapter's handle,
//   which the body receives unwrapped, so it is not counted again.
// Root statements (`all`/`first`/`run`) pass through unchanged: they never retry.

import { appendFileSync } from 'node:fs';
import type { CatalogDb, CatalogRoot } from '@autologger/ports';

export interface RetryRecord {
  runs: number;
  codes: string[];
  exhausted: boolean;
}

const RETRYABLE = new Set(['40001', '40P01']);

const codeOf = (e: unknown): string | undefined => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

export class RetryCountingRoot implements CatalogRoot {
  /** Every settled `tx` call, in settle order. */
  readonly calls: RetryRecord[] = [];

  constructor(
    private readonly inner: CatalogRoot,
    private readonly logPath?: string,
  ) {}

  bindUser(userId: string): CatalogDb {
    return this.wrap(this.inner.bindUser(userId));
  }

  bindSystem(reason: string): CatalogDb {
    return this.wrap(this.inner.bindSystem(reason));
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  private record(r: RetryRecord): void {
    this.calls.push(r);
    if (this.logPath) appendFileSync(this.logPath, `${JSON.stringify(r)}\n`);
  }

  private wrap(h: CatalogDb): CatalogDb {
    return {
      all: (sql, ...binds) => h.all(sql, ...binds),
      first: (sql, ...binds) => h.first(sql, ...binds),
      run: (sql, ...binds) => h.run(sql, ...binds),
      tx: async <T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> => {
        let runs = 0;
        const codes: string[] = [];
        try {
          const r = await h.tx(async (t) => {
            runs++;
            try {
              return await fn(t);
            } catch (e) {
              const code = codeOf(e);
              if (code !== undefined) codes.push(code);
              throw e;
            }
          });
          this.record({ runs, codes, exhausted: false });
          return r;
        } catch (e) {
          this.record({ runs, codes, exhausted: RETRYABLE.has(codeOf(e) as string) });
          throw e;
        }
      },
    };
  }
}
