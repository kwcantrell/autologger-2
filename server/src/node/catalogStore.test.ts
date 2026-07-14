import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CatalogDb } from './catalogStore';

function db(): CatalogDb {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
  return new CatalogDb(raw);
}

describe('CatalogDb', () => {
  it('run() reports the affected-row count', () => {
    const d = db();
    expect(d.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1).changes).toBe(1);
    expect(d.run('UPDATE t SET v = 9 WHERE k = ?', 'missing').changes).toBe(0);
  });

  it('all() returns rows and first() returns row or null', () => {
    const d = db();
    d.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
    d.run('INSERT INTO t (k, v) VALUES (?, ?)', 'b', 2);
    expect(d.all('SELECT * FROM t ORDER BY k')).toEqual([
      { k: 'a', v: 1 },
      { k: 'b', v: 2 },
    ]);
    expect(d.first('SELECT * FROM t WHERE k = ?', 'b')).toEqual({ k: 'b', v: 2 });
    expect(d.first('SELECT * FROM t WHERE k = ?', 'nope')).toBeNull();
  });

  it('tx() rolls back all writes when a constraint violation hits mid-transaction', () => {
    const d = db();
    expect(() =>
      d.tx(() => {
        d.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
        d.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 2); // PK violation
      }),
    ).toThrow();
    expect(d.first<{ n: number }>('SELECT COUNT(*) AS n FROM t')?.n).toBe(0);
  });

  it('tx() is reentrant (db.transaction, not raw BEGIN/COMMIT)', () => {
    const d = db();
    d.tx(() => {
      d.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
      d.tx(() => {
        d.run('INSERT INTO t (k, v) VALUES (?, ?)', 'b', 2);
      });
    });
    expect(d.first<{ n: number }>('SELECT COUNT(*) AS n FROM t')?.n).toBe(2);
  });
});
