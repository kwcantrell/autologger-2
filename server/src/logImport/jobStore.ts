export interface LogImportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  lines: string[];
  error: string | null;
  createdAtMs: number;
}

/** Survive `tsx watch` module re-eval so POST→poll doesn't 404 mid-job. */
const GLOBAL_KEY = '__autologger_log_import_jobs__';
function jobsMap(): Map<string, LogImportJob> {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: Map<string, LogImportJob>;
  };
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY];
}

export function createLogImportJob(): LogImportJob {
  const id = crypto.randomUUID();
  const job: LogImportJob = {
    id,
    status: 'queued',
    lines: [],
    error: null,
    createdAtMs: Date.now(),
  };
  jobsMap().set(id, job);
  return job;
}

export function getLogImportJob(id: string): LogImportJob | null {
  return jobsMap().get(id) ?? null;
}

export function appendLogImportLine(id: string, line: string): void {
  const job = jobsMap().get(id);
  if (!job) return;
  job.lines.push(line);
}

export function setLogImportStatus(
  id: string,
  status: LogImportJob['status'],
  error: string | null = null,
): void {
  const job = jobsMap().get(id);
  if (!job) return;
  job.status = status;
  if (error !== null) job.error = error;
}

/** Test-only. */
export function clearLogImportJobs(): void {
  jobsMap().clear();
}
