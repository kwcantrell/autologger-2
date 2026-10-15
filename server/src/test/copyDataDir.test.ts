// Task 7.3 — WAL-safe DATA_DIR copier (server/scripts/copyDataDir.ts).
// Temp directories only; never touches a real DATA_DIR.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyDataDir, EXIT_OK, EXIT_UNSAFE, EXIT_VERIFY } from '../../scripts/copyDataDir';

let root: string;
const open: Database.Database[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copydatadir-'));
});
afterEach(() => {
  for (const d of open.splice(0)) if (d.open) d.close();
  rmSync(root, { recursive: true, force: true });
});

/** A WAL-mode db whose latest rows live ONLY in the -wal file: autocheckpoint
 * is off and the writer connection stays open, so nothing is checkpointed. */
function walDb(path: string, rows: number, table = 'items'): Database.Database {
  const db = new Database(path);
  open.push(db);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, v TEXT)`);
  db.exec('CREATE TABLE other (id INTEGER PRIMARY KEY)');
  db.pragma('wal_checkpoint(TRUNCATE)');
  const ins = db.prepare(`INSERT INTO ${table} (v) VALUES (?)`);
  for (let i = 0; i < rows; i += 1) ins.run(`row-${i}`);
  return db;
}

function fixture(): { src: string; dst: string; live: Database.Database[] } {
  const src = join(root, 'src');
  const dst = join(root, 'dst');
  mkdirSync(join(src, 'sessions'), { recursive: true });
  mkdirSync(join(src, 'blobs', 'audio'), { recursive: true });
  writeFileSync(join(src, 'blobs', 'audio', 'x.db'), 'not a database; blobs are skipped');
  const live = [walDb(join(src, 'catalog.db'), 50), walDb(join(src, 'sessions', 's1.db'), 20)];
  return { src, dst, live };
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      // -shm is SQLite's volatile shared-memory index, not durable data.
      else if (!p.endsWith('-shm')) {
        out[p] =
          `${statSync(p).mtimeMs}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
      }
    }
  };
  walk(dir);
  return out;
}

const quiet = { log: () => {}, err: () => {} };

describe('copyDataDir', () => {
  it('copies uncheckpointed WAL rows, verifies, and leaves the source untouched', async () => {
    const { src, dst } = fixture();
    // Precondition of the fixture: the rows really are only in the -wal.
    expect(statSync(join(src, 'catalog.db-wal')).size).toBeGreaterThan(0);
    const roCheck = new Database(join(src, 'catalog.db'), { readonly: true });
    roCheck.close();
    const before = snapshot(src);

    const res = await copyDataDir(src, dst, quiet);

    expect(res.exitCode).toBe(EXIT_OK);
    expect(res.dbs.map((d) => d.rel).sort()).toEqual(['catalog.db', 'sessions/s1.db']);
    expect(snapshot(src)).toEqual(before);

    const c = new Database(join(dst, 'catalog.db'), { readonly: true });
    expect((c.prepare('SELECT count(*) n FROM items').get() as { n: number }).n).toBe(50);
    expect(c.pragma('integrity_check', { simple: true })).toBe('ok');
    c.close();
    const s = new Database(join(dst, 'sessions', 's1.db'), { readonly: true });
    expect((s.prepare('SELECT count(*) n FROM items').get() as { n: number }).n).toBe(20);
    s.close();
    // blobs are not copied; no stray -wal/-shm/temp files in the destination.
    expect(existsSync(join(dst, 'blobs'))).toBe(false);
    expect(readdirSync(dst).sort()).toEqual(['catalog.db', 'sessions']);
    expect(readdirSync(join(dst, 'sessions'))).toEqual(['s1.db']);
  });

  it('is a consistent snapshot: a concurrent writer process causes no false mismatch', async () => {
    const { src, dst } = fixture();
    const writer = spawn(
      process.execPath,
      [
        '-e',
        `const D=require('better-sqlite3');const d=new D(process.argv[1]);d.pragma('busy_timeout=5000');
         const s=d.prepare("INSERT INTO items (v) VALUES ('live')");console.log('ready');
         for(;;){try{s.run()}catch{}}`,
        join(src, 'catalog.db'),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise((r) => writer.stdout.once('data', r));
      for (let i = 0; i < 3; i += 1) {
        const res = await copyDataDir(src, dst, { ...quiet, overwrite: true });
        expect(res.dbs.find((d) => d.rel === 'catalog.db')?.error).toBeUndefined();
        expect(res.exitCode).toBe(EXIT_OK);
      }
    } finally {
      writer.kill('SIGKILL');
    }
  });

  it('refuses destination == source, nesting either way, and a missing source (exit 2)', async () => {
    const { src } = fixture();
    const before = snapshot(src);
    for (const [s, d] of [
      [src, src],
      [src, join(src, 'nested')],
      [join(src, 'sessions'), src],
      [join(root, 'missing'), join(root, 'out')],
    ] as const) {
      const res = await copyDataDir(s, d, quiet);
      expect(res.exitCode).toBe(EXIT_UNSAFE);
    }
    expect(snapshot(src)).toEqual(before);
    expect(existsSync(join(src, 'nested'))).toBe(false);
  });

  it('refuses to overwrite an existing destination db without overwrite; copies nothing', async () => {
    const { src, dst } = fixture();
    mkdirSync(join(dst, 'sessions'), { recursive: true });
    writeFileSync(join(dst, 'sessions', 's1.db'), 'seeded');
    const res = await copyDataDir(src, dst, quiet);
    expect(res.exitCode).toBe(EXIT_UNSAFE);
    expect(existsSync(join(dst, 'catalog.db'))).toBe(false);
    expect(readFileSync(join(dst, 'sessions', 's1.db'), 'utf8')).toBe('seeded');
  });

  it('overwrites a seeded copy when overwrite is set (cutover)', async () => {
    const { src, dst } = fixture();
    expect((await copyDataDir(src, dst, quiet)).exitCode).toBe(EXIT_OK);
    const db = new Database(join(src, 'catalog.db'));
    db.prepare("INSERT INTO items (v) VALUES ('after-seed')").run();
    db.close();
    expect((await copyDataDir(src, dst, { ...quiet, overwrite: true })).exitCode).toBe(EXIT_OK);
    const c = new Database(join(dst, 'catalog.db'), { readonly: true });
    expect((c.prepare('SELECT count(*) n FROM items').get() as { n: number }).n).toBe(51);
    c.close();
  });

  it('overwrite removes stale -wal/-shm/-journal siblings of the destination (no WAL replay onto the new file)', async () => {
    const { src, dst } = fixture();
    mkdirSync(join(dst, 'sessions'), { recursive: true });
    // Realistic stale state: a destination db that a since-stopped api left with an
    // uncheckpointed -wal. Snapshot db+wal while the writer is live, then close it.
    const old = walDb(join(dst, 'catalog.db'), 7);
    for (const s of ['', '-wal'])
      copyFileSync(join(dst, `catalog.db${s}`), join(root, `stale.db${s}`));
    old.close();
    rmSync(join(dst, 'catalog.db-wal'), { force: true });
    rmSync(join(dst, 'catalog.db-shm'), { force: true });
    copyFileSync(join(root, 'stale.db'), join(dst, 'catalog.db'));
    copyFileSync(join(root, 'stale.db-wal'), join(dst, 'catalog.db-wal'));
    writeFileSync(join(dst, 'catalog.db-shm'), Buffer.alloc(32768));
    writeFileSync(join(dst, 'catalog.db-journal'), 'stale');
    copyFileSync(join(src, 'sessions', 's1.db'), join(dst, 'sessions', 's1.db')); // clash, plain seed
    expect(statSync(join(dst, 'catalog.db-wal')).size).toBeGreaterThan(0);

    const res = await copyDataDir(src, dst, { ...quiet, overwrite: true });
    expect(res.exitCode).toBe(EXIT_OK);
    for (const s of ['-wal', '-shm', '-journal']) {
      expect(existsSync(join(dst, `catalog.db${s}`))).toBe(false);
    }
    const c = new Database(join(dst, 'catalog.db'));
    expect(c.pragma('integrity_check', { simple: true })).toBe('ok');
    const rows = c.prepare('SELECT v FROM items ORDER BY id').all() as Array<{ v: string }>;
    expect(rows.length).toBe(50); // the source's rows, not the stale 7 replayed on top
    expect(rows.every((r, i) => r.v === `row-${i}`)).toBe(true);
    c.close();
    // source untouched by the copier's sidecar cleanup
    expect(existsSync(join(src, 'catalog.db-wal'))).toBe(true);
  });

  it('overwrite refuses (exit 2, nothing written) while the destination db is open by another connection', async () => {
    const { src, dst } = fixture();
    mkdirSync(dst, { recursive: true });
    const inUse = walDb(join(dst, 'catalog.db'), 3); // stays open: a running api
    const before = readFileSync(join(dst, 'catalog.db'));
    const errs: string[] = [];
    const res = await copyDataDir(src, dst, {
      ...quiet,
      overwrite: true,
      err: (l) => errs.push(l),
    });
    expect(res.exitCode).toBe(EXIT_UNSAFE);
    expect(errs.join('\n')).toMatch(/in use.*stop the api/i);
    expect(readFileSync(join(dst, 'catalog.db')).equals(before)).toBe(true);
    expect(existsSync(join(dst, 'sessions'))).toBe(false);
    inUse.close();
    // once the holder is gone, the same invocation succeeds
    expect((await copyDataDir(src, dst, { ...quiet, overwrite: true })).exitCode).toBe(EXIT_OK);
  });

  it('exits non-zero and keeps the prior destination when verification fails', async () => {
    const { src, dst } = fixture();
    expect((await copyDataDir(src, dst, quiet)).exitCode).toBe(EXIT_OK);
    const good = readFileSync(join(dst, 'catalog.db'));
    const res = await copyDataDir(src, dst, {
      ...quiet,
      overwrite: true,
      // test seam: tamper with the staged copy before verification
      afterBackup: (tmp) => {
        const d = new Database(tmp);
        d.prepare('DELETE FROM items WHERE id = 1').run();
        d.close();
      },
    });
    expect(res.exitCode).toBe(EXIT_VERIFY);
    expect(res.dbs.find((d) => d.rel === 'catalog.db')?.error).toMatch(/row count/i);
    expect(readFileSync(join(dst, 'catalog.db')).equals(good)).toBe(true);
    expect(readdirSync(dst).sort()).toEqual(['catalog.db', 'sessions']);
  });

  it('exits non-zero on a corrupt (non-SQLite) *.db in the source', async () => {
    const { src, dst } = fixture();
    writeFileSync(join(src, 'sessions', 'bad.db'), 'garbage garbage garbage garbage');
    const res = await copyDataDir(src, dst, quiet);
    expect(res.exitCode).toBe(EXIT_VERIFY);
  });

  it('CLI: usage exit 2, success exit 0, points blobs at the README (shared-blob-volume D5)', () => {
    const { src, dst } = fixture();
    const tsx = resolve(__dirname, '../../../node_modules/.bin/tsx');
    const script = resolve(__dirname, '../../scripts/copyDataDir.ts');
    const noArgs = spawnSync(tsx, [script], { encoding: 'utf8' });
    expect(noArgs.status).toBe(2);
    expect(noArgs.stderr).toMatch(/usage:/i);
    const ok = execFileSync(tsx, [script, src, dst], { encoding: 'utf8' });
    // shared-blob-volume D5: audio lives in BLOB_DIR, not DATA_DIR, so no blob command targets
    // the destination's DATA_DIR/blobs; the README sections hold the steps.
    expect(ok).toMatch(/audio is not in DATA_DIR/);
    expect(ok).toContain('"Blob sync guard"');
    expect(ok).toContain('"Moving audio into BLOB_DIR"');
    expect(ok).not.toContain(`${dst}/blobs/`);
    expect(ok).not.toMatch(/rsync/);
    const again = spawnSync(tsx, [script, src, dst], { encoding: 'utf8' });
    expect(again.status).toBe(2);
    chmodSync(dst, 0o755);
  });
});
