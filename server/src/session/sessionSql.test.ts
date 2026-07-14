// Unit coverage for the real SessionSql adapter (replaces the old SqlShim
// suite): all() rows, run() affected-row counts, and the distinct
// multi-statement exec() path initSchema depends on.

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { sqliteSessionSql } from './SessionHub';

function sql() {
  return sqliteSessionSql(new Database(':memory:'));
}

describe('sqliteSessionSql', () => {
  it('exec() runs multi-statement SQL with no binds (initSchema shape)', () => {
    const s = sql();
    s.exec(`
      CREATE TABLE a (x INTEGER);
      CREATE TABLE b (y TEXT);
      INSERT INTO a (x) VALUES (1);
    `);
    expect(s.all('SELECT x FROM a')).toEqual([{ x: 1 }]);
  });

  it('all() returns rows for bound SELECTs', () => {
    const s = sql();
    s.exec('CREATE TABLE t (k TEXT, v INTEGER)');
    s.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
    s.run('INSERT INTO t (k, v) VALUES (?, ?)', 'b', 2);
    expect(s.all('SELECT * FROM t WHERE v > ? ORDER BY v', 0)).toEqual([
      { k: 'a', v: 1 },
      { k: 'b', v: 2 },
    ]);
  });

  it('run() reports changes for writes (UPDATE hit and miss)', () => {
    const s = sql();
    s.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
    s.run('INSERT INTO t (k, v) VALUES (?, ?)', 'a', 1);
    expect(s.run("UPDATE t SET v = 2 WHERE k = 'a'").changes).toBe(1);
    expect(s.run("UPDATE t SET v = 2 WHERE k = 'zzz'").changes).toBe(0);
  });

  it('binds null and numeric values', () => {
    const s = sql();
    s.exec('CREATE TABLE t (a, b)');
    s.run('INSERT INTO t (a, b) VALUES (?, ?)', null, 3.5);
    expect(s.all('SELECT * FROM t')).toEqual([{ a: null, b: 3.5 }]);
  });

  it('run() throws on multi-statement SQL (exec is the only multi-statement path)', () => {
    const s = sql();
    expect(() => s.run('SELECT 1; SELECT 2', 5)).toThrow();
  });
});
