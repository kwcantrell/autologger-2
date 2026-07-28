export interface LogImportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  lines: string[];
  error: string | null;
  createdAtMs: number;
}

const jobs = new Map<string, LogImportJob>();

export function createLogImportJob(): LogImportJob {
  const id = crypto.randomUUID();
  const job: LogImportJob = {
    id,
    status: 'queued',
    lines: [],
    error: null,
    createdAtMs: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

export function getLogImportJob(id: string): LogImportJob | null {
  return jobs.get(id) ?? null;
}

export function appendLogImportLine(id: string, line: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.lines.push(line);
}

export function setLogImportStatus(
  id: string,
  status: LogImportJob['status'],
  error: string | null = null,
): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = status;
  if (error !== null) job.error = error;
}

/** Test-only. */
export function clearLogImportJobs(): void {
  jobs.clear();
}
