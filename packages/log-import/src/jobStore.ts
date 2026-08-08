import type { Clock } from '@autologger/ports';

export interface LogImportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  lines: string[];
  error: string | null;
  createdAtMs: number;
  /** Instant the job reached a terminal status (completed/failed); null while
   * queued/running. Drives the terminal-TTL prune below — measured from when
   * the job FINISHED, so a long-running import isn't reaped the moment it
   * completes. */
  finishedAtMs: number | null;
  /** Creator principal: the authenticated user's id, or null for an anonymous
   * request (REQUIRE_LOGIN=0 dev mode, or API-token auth). The status GET
   * route 404s any authenticated requester whose id differs — same shape as
   * the studio-membership scope on sibling routes. */
  createdByUserId: string | null;
}

/** Terminal (completed/failed) jobs are prunable this long after finishing. */
const TERMINAL_JOB_TTL_MS = 60 * 60 * 1000;
/** Map-size cap; past it, oldest TERMINAL jobs are evicted first. Queued and
 * running jobs are NEVER evicted, so the map may transiently exceed the cap
 * rather than orphan a live import's status. */
const MAX_JOBS = 200;

/** Survive `tsx watch` module re-eval so POST→poll doesn't 404 mid-job. */
const GLOBAL_KEY = '__autologger_log_import_jobs__';
function jobsMap(): Map<string, LogImportJob> {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: Map<string, LogImportJob>;
  };
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY];
}

function isTerminal(job: LogImportJob): boolean {
  return job.status === 'completed' || job.status === 'failed';
}

/** Lifecycle sweep, run on every insert and lookup: drop terminal jobs older
 * than the TTL, then enforce the size cap by evicting the oldest terminal
 * jobs (Map iteration is insertion order, so the first terminal entries seen
 * are the oldest). Never touches a queued/running job. */
function pruneJobs(nowMs: number): void {
  const map = jobsMap();
  for (const [id, job] of map) {
    if (job.finishedAtMs !== null && nowMs - job.finishedAtMs > TERMINAL_JOB_TTL_MS) {
      map.delete(id);
    }
  }
  if (map.size <= MAX_JOBS) return;
  for (const [id, job] of map) {
    if (isTerminal(job)) map.delete(id);
    if (map.size <= MAX_JOBS) return;
  }
}

export function createLogImportJob(clock: Clock, createdByUserId: string | null): LogImportJob {
  const now = clock.now();
  pruneJobs(now);
  const id = crypto.randomUUID();
  const job: LogImportJob = {
    id,
    status: 'queued',
    lines: [],
    error: null,
    createdAtMs: now,
    finishedAtMs: null,
    createdByUserId,
  };
  jobsMap().set(id, job);
  return job;
}

export function getLogImportJob(clock: Clock, id: string): LogImportJob | null {
  pruneJobs(clock.now());
  return jobsMap().get(id) ?? null;
}

export function appendLogImportLine(id: string, line: string): void {
  const job = jobsMap().get(id);
  if (!job) return;
  job.lines.push(line);
}

export function setLogImportStatus(
  clock: Clock,
  id: string,
  status: LogImportJob['status'],
  error: string | null = null,
): void {
  const job = jobsMap().get(id);
  if (!job) return;
  job.status = status;
  job.finishedAtMs = status === 'completed' || status === 'failed' ? clock.now() : null;
  if (error !== null) job.error = error;
}

/** Test-only. */
export function clearLogImportJobs(): void {
  jobsMap().clear();
}
