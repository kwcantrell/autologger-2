// dataDirLock.ts — one server per DATA_DIR (retire-host-dev D2).
//
// An exclusive SQLite lock on DATA_DIR/.server.lock, held for the process lifetime. It is an OS
// file lock (fcntl), so the kernel drops it when the process dies: no stale-PID handling. Notes:
//  * The file has no `.db` suffix, so the live backup (server/scripts/copyDataDir.ts copies every
//    `*.db`) never opens it.
//  * POSIX fcntl semantics: ANY other open+close of this file in the same process drops the lock.
//    Nothing in the server may read or copy the DATA_DIR root file by file.
//  * Assumes a local volume driver (fcntl over NFS with `nolock` is local-only).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export class DataDirLockedError extends Error {
  constructor(dir: string) {
    super(`another AutoLogger server holds ${dir}; refusing to start a second one on the same data directory`);
    this.name = 'DataDirLockedError';
  }
}

// Strong references: a garbage-collected handle would close and silently drop the lock.
const held = new Set<Database.Database>();

export function acquireDataDirLock(dir: string): { release(): void } {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, '.server.lock'), { timeout: 0 });
  try {
    // A file this process cannot write would only get a READ lock and "succeed" twice.
    if (db.readonly) throw new Error(`${join(dir, '.server.lock')} is not writable`);
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.pragma('user_version = 1'); // a write makes the exclusive lock real (and fails read-only)
  } catch (e) {
    db.close();
    if ((e as { code?: string }).code === 'SQLITE_BUSY') throw new DataDirLockedError(dir);
    throw e;
  }
  held.add(db);
  return {
    release() {
      if (!held.delete(db)) return;
      db.close(); // ROLLBACK alone keeps an EXCLUSIVE-mode lock; closing releases it
    },
  };
}
