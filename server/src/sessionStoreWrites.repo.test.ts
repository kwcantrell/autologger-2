import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// --- The stores write only through `run` (session-row-versions design D2, Risks) ---
// (api-contract-freeze "The session revision advances once per session write".)
//
// A transaction-bound core advances the session revision when a statement sent through its
// counting handle's `run` changes a row. A store that wrote through `all` or `first` (an
// `INSERT … RETURNING`, say) would change a row without advancing it. So no `all(`/`first(` call in
// a `packages/session-core/src/*Store.ts` file may carry an INSERT, UPDATE or DELETE. The core's own
// statements (the revision bump, sent on the raw handle) live in `sessionCore.ts`, outside the scan.
//
// LIMITS: a textual scan of each call's first argument when it is a literal. A statement built in a
// variable slips past it; the revision tests (`server/src/test/session/revision.int.test.ts`) are
// the behavioural backstop. The scan is mutation-checked against synthetic trees below.

/** `all(` or `first(`, then the first argument when it is a quoted or template literal. */
const READ_CALL = /\b(?:all|first)(?:<[^>]*>)?\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;
const WRITE = /\b(INSERT|UPDATE|DELETE)\b/i;

function storeFiles(root: string): string[] {
  const dir = path.join(root, 'packages/session-core/src');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('Store.ts'))
    .map((f) => `packages/session-core/src/${f}`)
    .sort();
}

function scanStoreWrites(root: string): { writes: string[]; calls: number } {
  const writes: string[] = [];
  let calls = 0;
  for (const file of storeFiles(root)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of text.matchAll(READ_CALL)) {
      calls += 1;
      const body = m[1].slice(1, -1);
      if (WRITE.test(body)) writes.push(`${file}: ${body.trim().split('\n')[0]}`);
    }
  }
  return { writes, calls };
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('session stores write only through run (session-row-versions D2)', () => {
  it('no store reads-call carries an INSERT, UPDATE or DELETE', () => {
    const r = scanStoreWrites(REPO);
    expect(r.calls).toBeGreaterThan(20);
    expect(r.writes).toEqual([]);
  });
});

describe('the scan is mutation-checked against synthetic trees (session-row-versions D2)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function tree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-writes-'));
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
  }

  it('reads through all/first and writes through run pass; other files are not scanned', () => {
    const root = tree({
      'packages/session-core/src/aStore.ts': [
        "core.first('SELECT 1 AS x FROM session_events WHERE session_id = ?', sid);",
        'core.all<Row>(`SELECT * FROM session_topics WHERE session_id = ?`, sid);',
        "core.db.run('UPDATE session_topics SET summary = ? WHERE session_id = ?', s, sid);",
      ].join('\n'),
      'packages/session-core/src/sessionCore.ts':
        "raw.all('UPDATE sessions SET revision = revision + 1 RETURNING revision');\n",
    });
    expect(scanStoreWrites(root)).toEqual({ writes: [], calls: 2 });
  });

  it('a write through all or first fails, naming the file and the statement', () => {
    const root = tree({
      'packages/session-core/src/bStore.ts': [
        "core.all('INSERT INTO session_events (session_id, id) VALUES (?, ?) RETURNING id', sid, id);",
        'core.first<Row>(`\n  delete from session_topics WHERE session_id = ? RETURNING id`, sid);',
      ].join('\n'),
    });
    expect(scanStoreWrites(root).writes).toEqual([
      'packages/session-core/src/bStore.ts: INSERT INTO session_events (session_id, id) VALUES (?, ?) RETURNING id',
      'packages/session-core/src/bStore.ts: delete from session_topics WHERE session_id = ? RETURNING id',
    ]);
  });
});
