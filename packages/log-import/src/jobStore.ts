// The log-import job store over the KvStore port (shared-request-state D1, ADR 0021 slice 9b).
// Each job is one JSON record in the catalog kv under `log-import-job:<id>`, so any server
// process sharing the database can answer a status poll. Built per server binding
// (`createLogImportJobStore(kv, clock)`, reached through `c.env.ports.logImportJobs`); the former
// `globalThis` map, its 200-job size cap and `clearLogImportJobs` are gone.
//
// Writes: every write for a job (appendLine, setStatus, heartbeat) goes on that job's promise
// chain, so they run one at a time in issue order, and each is one atomic
// `replaceIf(key, lastWritten, next, {expirationTtl})` with `seq + 1` (panel: unordered whole-record
// puts lost a terminal status). A mismatch means another writer changed the record — the only one
// is a poll's stale-failure swap — so the job is `lost`: it writes nothing more and its runner
// stops before the next sheet. A write that throws is logged and the next write carries its
// change (the record is rebuilt from local state each time); nothing on this path ever rejects.
//
// Staleness: a queued/running record whose heartbeat is more than 60 s old reads as `failed`
// with STALE_JOB_ERROR, and `get` writes that switch with a compare-and-swap, so it is final.

import type { Clock, KvStore } from '@autologger/ports';

export type LogImportJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface LogImportJob {
  id: string;
  status: LogImportJobStatus;
  lines: string[];
  error: string | null;
  createdAtMs: number;
  /** Instant the job reached a terminal status (completed/failed); null while
   * queued/running. The record expires an hour after it, so a long-running
   * import isn't dropped the moment it completes. */
  finishedAtMs: number | null;
  /** Creator principal: the signed-in user's id (login is always required,
   * require-login D3). The status GET route 404s any requester whose id
   * differs — same shape as the studio-membership scope on sibling routes. */
  createdByUserId: string;
  /** Last write by the running process; staleness is judged from it. */
  heartbeatMs: number;
}

/** The stored value: the job without its id (the key carries it), versioned, with a sequence
 * number so every write is a distinct value for the compare-and-swap. */
interface JobRecord extends Omit<LogImportJob, 'id'> {
  v: 1;
  seq: number;
}

export const STALE_JOB_ERROR = 'The server running this import stopped.';
/** A queued/running job whose heartbeat is older than this reads as failed. */
export const STALE_JOB_AFTER_MS = 60 * 1000;
/** How often the running process should heartbeat (the route's timer). */
export const JOB_HEARTBEAT_INTERVAL_MS = 10 * 1000;
/** Record expiry, in seconds: refreshed by each write while live, then an hour once terminal. */
const LIVE_JOB_TTL_S = 2 * 60 * 60;
const TERMINAL_JOB_TTL_S = 60 * 60;

const KEY_PREFIX = 'log-import-job:';

function keyOf(id: string): string {
  return KEY_PREFIX + id;
}

function isTerminal(status: LogImportJobStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function ttlFor(record: JobRecord): number {
  return isTerminal(record.status) ? TERMINAL_JOB_TTL_S : LIVE_JOB_TTL_S;
}

function parseRecord(raw: string): JobRecord | null {
  try {
    const r = JSON.parse(raw) as Partial<JobRecord> | null;
    if (!r || r.v !== 1 || !Array.isArray(r.lines) || typeof r.status !== 'string') return null;
    return r as JobRecord;
  } catch {
    return null;
  }
}

function toJob(id: string, r: JobRecord): LogImportJob {
  return {
    id,
    status: r.status,
    lines: r.lines,
    error: r.error,
    createdAtMs: r.createdAtMs,
    finishedAtMs: r.finishedAtMs,
    createdByUserId: r.createdByUserId,
    heartbeatMs: r.heartbeatMs,
  };
}

/** The creating process's local view of one job: the record it wants stored, the value it last
 * wrote (the compare-and-swap's `expected`), the tail of its write chain and the lost flag. */
interface LocalJob {
  record: JobRecord;
  lastWritten: string;
  tail: Promise<void>;
  lost: boolean;
}

export interface LogImportJobStore {
  /** Stores a new `queued` job (a plain put) and returns it. Throws if the kv write fails. */
  create(createdByUserId: string): Promise<LogImportJob>;
  /** Reads a job from kv; a stale queued/running job is switched to failed first. */
  get(id: string): Promise<LogImportJob | null>;
  /** The writes below are queued on the job's chain, resolve once their write ran, and never
   * reject. They are no-ops for a job this store did not create or has released. */
  appendLine(id: string, line: string): Promise<void>;
  setStatus(id: string, status: LogImportJobStatus, error?: string | null): Promise<void>;
  heartbeat(id: string): Promise<void>;
  /** True once a write found the record changed by another writer: the runner must stop. */
  isLost(id: string): boolean;
  /** Awaits the job's queued writes, then forgets its local state. Never rejects. */
  release(id: string): Promise<void>;
}

export function createLogImportJobStore(kv: KvStore, clock: Clock): LogImportJobStore {
  const local = new Map<string, LocalJob>();

  async function write(id: string, job: LocalJob): Promise<void> {
    if (job.lost) return;
    const next: JobRecord = { ...job.record, seq: job.record.seq + 1 };
    const value = JSON.stringify(next);
    try {
      const swapped = await kv.replaceIf(keyOf(id), job.lastWritten, value, {
        expirationTtl: ttlFor(next),
      });
      if (!swapped) {
        job.lost = true;
        console.warn(`[log-import] job ${id} record changed by another writer; stopping`);
        return;
      }
      job.record = next;
      job.lastWritten = value;
    } catch (err) {
      // The next write carries this change: the record is rebuilt from local state each time.
      console.warn(
        `[log-import] job ${id} write failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /** Applies `change` to the local record and queues one write after the job's earlier ones. */
  function enqueue(id: string, change: (r: JobRecord) => JobRecord | null): Promise<void> {
    const job = local.get(id);
    if (!job) return Promise.resolve();
    const run = job.tail.then(async () => {
      if (job.lost) return;
      const changed = change(job.record);
      if (!changed) return;
      // The seq stays the last written one until the swap succeeds (write() bumps it).
      job.record = { ...changed, seq: job.record.seq };
      await write(id, job);
    });
    job.tail = run.catch((err) => {
      console.warn(`[log-import] job ${id} write chain error`, err);
    });
    return job.tail;
  }

  return {
    async create(createdByUserId) {
      const now = clock.now();
      const id = crypto.randomUUID();
      const record: JobRecord = {
        v: 1,
        status: 'queued',
        lines: [],
        error: null,
        createdAtMs: now,
        finishedAtMs: null,
        createdByUserId,
        heartbeatMs: now,
        seq: 0,
      };
      const value = JSON.stringify(record);
      await kv.put(keyOf(id), value, { expirationTtl: LIVE_JOB_TTL_S });
      local.set(id, { record, lastWritten: value, tail: Promise.resolve(), lost: false });
      return toJob(id, record);
    },

    async get(id) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await kv.get(keyOf(id));
        if (raw === null) return null;
        const record = parseRecord(raw);
        if (!record) return null;
        const now = clock.now();
        if (isTerminal(record.status) || now - record.heartbeatMs <= STALE_JOB_AFTER_MS) {
          return toJob(id, record);
        }
        const failed: JobRecord = {
          ...record,
          status: 'failed',
          error: STALE_JOB_ERROR,
          finishedAtMs: now,
          seq: record.seq + 1,
        };
        if (
          await kv.replaceIf(keyOf(id), raw, JSON.stringify(failed), {
            expirationTtl: TERMINAL_JOB_TTL_S,
          })
        ) {
          return toJob(id, failed);
        }
        // Another writer changed the record between the read and the swap: read it again.
      }
      return null;
    },

    appendLine(id, line) {
      return enqueue(id, (r) => ({ ...r, lines: [...r.lines, line], heartbeatMs: clock.now() }));
    },

    setStatus(id, status, error = null) {
      return enqueue(id, (r) => {
        const now = clock.now();
        return {
          ...r,
          status,
          finishedAtMs: isTerminal(status) ? now : null,
          error: error !== null ? error : r.error,
          heartbeatMs: now,
        };
      });
    },

    heartbeat(id) {
      return enqueue(id, (r) =>
        isTerminal(r.status) ? null : { ...r, heartbeatMs: clock.now() },
      );
    },

    isLost(id) {
      return local.get(id)?.lost ?? false;
    },

    async release(id) {
      const job = local.get(id);
      if (!job) return;
      // A write queued while waiting (a heartbeat tick) moves the tail: wait for that one too.
      let tail: Promise<void>;
      do {
        tail = job.tail;
        await tail;
      } while (tail !== job.tail);
      // Writes queued after this point are dropped: the job is done on this process.
      local.delete(id);
    },
  };
}
