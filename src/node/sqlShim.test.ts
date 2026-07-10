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
