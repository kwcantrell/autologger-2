import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLogImportJobs } from '../logImport/jobStore';
import { app, env } from '../test/harness';
import { seedShow, seedStudio } from '../test/helpers';

afterEach(() => {
  clearLogImportJobs();
  vi.unstubAllGlobals();
});

describe('log-import job HTTP surface', () => {
  it('404s unknown job ids', async () => {
    const res = await app.request('/api/log-import/no-such-job', {}, env);
    expect(res.status).toBe(404);
  });

  it('404s unknown shows on POST', async () => {
    const res = await app.request(
      '/api/shows/missing/log-import',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spreadsheet_url: 'https://docs.google.com/spreadsheets/d/abc/edit' }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns a job_id and eventually fails when fetch is not xlsx', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );

    const post = await app.request(
      `/api/shows/${show}/log-import`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          spreadsheet_url: 'https://docs.google.com/spreadsheets/d/abc123xyz/edit',
        }),
      },
      env,
    );
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };
    expect(job_id).toBeTruthy();

    let status = 'queued';
    for (let i = 0; i < 40; i++) {
      const get = await app.request(`/api/log-import/${job_id}`, {}, env);
      expect(get.status).toBe(200);
      const body = (await get.json()) as { status: string; error: string | null };
      status = body.status;
      if (status === 'failed' || status === 'completed') {
        expect(status).toBe('failed');
        expect(body.error).toMatch(/HTML|link/i);
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`job did not finish, last status=${status}`);
  });
});
