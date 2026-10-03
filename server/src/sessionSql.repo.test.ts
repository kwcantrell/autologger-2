import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// --- Every session statement names its session (session-tables design D4, guard 1) ---
// (core-ports-architecture "Session runtime is an asynchronous, per-session serialized port on
// Postgres": "Every statement the session spine sends SHALL be scoped to its session".)
//
// The session tables hold every session's rows, so a statement without a `session_id` predicate
// (or a `session_id` insert column) reads, changes or deletes other sessions' rows. Every string or
// template literal in the production sources of `packages/session-core/src` that starts with
// SELECT, INSERT, UPDATE, DELETE or WITH must contain `session_id`. Interpolated literals count
// (`nextOrdinal`'s table name, the partial-update `SET` list).
//
// LIMITS (stated, not papered over): this is a textual scan. A statement assembled by string
// concatenation, or whose `session_id` sits in a comment or a different branch, slips past it; the
// isolation test (`server/src/test/session/isolation.int.test.ts`) is the behavioural backstop. The
// scan function is mutation-checked against synthetic trees below, so it cannot silently go
// vacuous.

const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\s/i;
/** Block comments and `//` comments that start a line or follow whitespace (so a comment's
 * apostrophes and backticks cannot pair up with a literal's). */
const COMMENT = /\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm;
/** Single-quoted, double-quoted and template literals (template interpolations included). */
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

function productionFiles(root: string): string[] {
  const dir = path.join(root, 'packages/session-core/src');
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'test') continue;
        walk(full);
      } else if (
        ent.name.endsWith('.ts') &&
        !ent.name.endsWith('.test.ts') &&
        !ent.name.endsWith('.d.ts')
      ) {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Every SQL literal without `session_id`, as `file: first line of the statement`; and how many
 * SQL literals were seen, so an empty scan is visible. */
function scanSessionSql(root: string): { unscoped: string[]; statements: number } {
  const unscoped: string[] = [];
  let statements = 0;
  for (const file of productionFiles(root)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8').replace(COMMENT, '$1');
    for (const m of text.matchAll(LITERAL)) {
      const body = m[0].slice(1, -1);
      if (!SQL_START.test(body)) continue;
      statements += 1;
      if (!body.includes('session_id')) {
        unscoped.push(`${file}: ${body.trim().split('\n')[0]}`);
      }
    }
  }
  return { unscoped, statements };
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('every session statement names session_id (session-tables D4)', () => {
  it('the session-core production sources hold no unscoped statement', () => {
    const r = scanSessionSql(REPO);
    expect(r.statements).toBeGreaterThan(40);
    expect(r.unscoped).toEqual([]);
  });
});

describe('the scan is mutation-checked against synthetic trees (session-tables D4)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function tree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sql-scan-'));
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
  }

  it('a compliant tree passes, interpolated table names included', () => {
    const root = tree({
      'packages/session-core/src/a.ts': [
        "db.all('SELECT * FROM session_events WHERE session_id = ? AND id = ?', sid, id);",
        'db.all(`SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM ${table} WHERE session_id = ?`, sid);',
        'db.run(`INSERT INTO session_meta (session_id, key, value) VALUES (?, ?, ?)`, sid, k, v);',
        "// the hub's lock: `SELECT` below",
      ].join('\n'),
      'packages/session-core/src/a.test.ts': "db.all('SELECT * FROM session_events');\n",
      'packages/session-core/src/test/fake.ts': "db.all('DELETE FROM session_events');\n",
    });
    expect(scanSessionSql(root)).toEqual({ unscoped: [], statements: 3 });
  });

  it('a literal without session_id fails, naming the file and the statement', () => {
    const root = tree({
      'packages/session-core/src/b.ts':
        "db.run('DELETE FROM session_transcript_words');\ndb.all(\"select id from session_topics where id = ?\", id);\n",
    });
    expect(scanSessionSql(root).unscoped).toEqual([
      'packages/session-core/src/b.ts: DELETE FROM session_transcript_words',
      'packages/session-core/src/b.ts: select id from session_topics where id = ?',
    ]);
  });

  it('an interpolated table name without session_id fails', () => {
    const root = tree({
      'packages/session-core/src/c.ts':
        'db.all(`SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM ${table}`);\n',
    });
    expect(scanSessionSql(root).unscoped).toEqual([
      'packages/session-core/src/c.ts: SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM ${table}',
    ]);
  });

  it('a multi-line template statement is one statement', () => {
    const root = tree({
      'packages/session-core/src/d.ts':
        'db.run(`\n  UPDATE session_events SET category = ?\n  WHERE id = ?`, c, id);\n',
    });
    expect(scanSessionSql(root).unscoped).toEqual([
      'packages/session-core/src/d.ts: UPDATE session_events SET category = ?',
    ]);
  });
});
