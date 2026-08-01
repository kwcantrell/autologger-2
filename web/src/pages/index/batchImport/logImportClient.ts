import { apiFetch } from '../../../api/client';

export interface LogImportJobStatus {
  status: 'queued' | 'running' | 'completed' | 'failed';
  lines: string[];
  error?: string | null;
}

export async function startLogImport(
  showId: string,
  spreadsheetUrl: string,
  signal: AbortSignal,
): Promise<string> {
  const res = await apiFetch<{ job_id: string }>(
    `shows/${encodeURIComponent(showId)}/log-import`,
    {
      method: 'POST',
      body: JSON.stringify({ spreadsheet_url: spreadsheetUrl }),
      signal,
    },
  );
  return res.job_id;
}

export async function fetchLogImportJob(
  jobId: string,
  signal: AbortSignal,
): Promise<LogImportJobStatus> {
  return apiFetch<LogImportJobStatus>(`log-import/${encodeURIComponent(jobId)}`, { signal });
}

/** Poll until completed/failed or aborted. Calls onLines with cumulative lines. */
export async function pollLogImportJob(
  jobId: string,
  signal: AbortSignal,
  onUpdate: (job: LogImportJobStatus) => void,
  intervalMs = 500,
): Promise<LogImportJobStatus> {
  for (;;) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const job = await fetchLogImportJob(jobId, signal);
    onUpdate(job);
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
