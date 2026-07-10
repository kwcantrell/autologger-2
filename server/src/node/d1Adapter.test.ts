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
