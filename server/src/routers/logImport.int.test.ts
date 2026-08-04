import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLogImportJobs } from '../logImport/jobStore';
import { app, env, envWith } from '../test/harness';
import { loginCookie, seedShow, seedStudio, seedUser } from '../test/helpers';

const NOT_CONFIGURED_DETAIL =
  'Google Sheets log import is not configured on this deployment. Set SHEETS_LOG_IMPORT_ENABLED=1 to enable it.';
const SHOW_NOT_FOUND_DETAIL = 'Show not found.';
const OPEN_NETWORK_DETAIL =
  'Google Sheets log import is refused: the server is bound to a non-loopback address with REQUIRE_LOGIN disabled and no IP_ALLOWLIST. ' +
  'Enable login, set an IP_ALLOWLIST, or bind to loopback (HOST=127.0.0.1) before importing logs.';

/** The base test env leaves SHEETS_LOG_IMPORT_ENABLED unset (503); suites that
 * exercise configured behavior opt in per-request, the envWith pattern. The
 * loopback HOST pin sidesteps the open-network refusal (the youtube-import
 * configuredEnv precedent — the base env is open-network by default). */
const enabledEnv = () => envWith({ SHEETS_LOG_IMPORT_ENABLED: '1', HOST: '127.0.0.1' });

const BODY = JSON.stringify({
  spreadsheet_url: 'https://docs.google.com/spreadsheets/d/abc123xyz/edit',
});

function postImport(showId: string, bindings = enabledEnv(), headers: Record<string, string> = {}) {
  return app.request(
    `/api/shows/${showId}/log-import`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: BODY,
    },
    bindings,
  );
}

afterEach(() => {
  clearLogImportJobs();
  vi.unstubAllGlobals();
});

describe('log-import job HTTP surface', () => {
  it('404s unknown job ids', async () => {
    const res = await app.request('/api/log-import/no-such-job', {}, env);
    expect(res.status).toBe(404);
  });

  it('404s unknown shows on POST (before the config gate — same base env, no opt-in)', async () => {
    const res = await postImport('missing', env);
    expect(res.status).toBe(404);
  });

  it('503s when SHEETS_LOG_IMPORT_ENABLED is unset, even for an existing show', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const res = await postImport(show, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: NOT_CONFIGURED_DETAIL });
  });

  it('503s with the open-network detail when configured but REQUIRE_LOGIN is off on a non-loopback bind', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const openNetwork = envWith({
      SHEETS_LOG_IMPORT_ENABLED: '1',
      REQUIRE_LOGIN: '0',
      HOST: '0.0.0.0',
      IP_ALLOWLIST: '',
    });
    const res = await postImport(show, openNetwork);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: OPEN_NETWORK_DETAIL });
  });

  it('a deployment that is BOTH unconfigured AND open-network-refused returns the NOT_CONFIGURED detail (config gate first)', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const bothConditions = envWith({ REQUIRE_LOGIN: '0', HOST: '0.0.0.0', IP_ALLOWLIST: '' });
    const res = await postImport(show, bothConditions);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: NOT_CONFIGURED_DETAIL });
  });

  it('404s (uniform "not found") when an authenticated non-member POSTs to another tenant’s show', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const otherStudio = seedStudio();
    const outsider = seedUser({ studios: [otherStudio] });
    const res = await postImport(show, enabledEnv(), { cookie: await loginCookie(outsider) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: SHOW_NOT_FOUND_DETAIL });
  });

  it('returns a job_id and eventually fails when fetch is not xlsx', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );

    const post = await postImport(show);
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

  it('POST succeeds for a studio member with the gate configured, and the creator can poll the job', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const member = seedUser({ studios: [studio] });
    const memberCookie = await loginCookie(member);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );

    const post = await postImport(show, enabledEnv(), { cookie: memberCookie });
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };
    expect(job_id).toBeTruthy();

    const get = await app.request(
      `/api/log-import/${job_id}`,
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(get.status).toBe(200);
    const body = (await get.json()) as { status: string };
    expect(['queued', 'running', 'completed', 'failed']).toContain(body.status);
  });

  it('GET job 404s for an authenticated non-creator (same 404 as an unknown id)', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const creator = seedUser({ studios: [studio] });
    const otherMember = seedUser({ studios: [studio] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );

    const post = await postImport(show, enabledEnv(), { cookie: await loginCookie(creator) });
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };

    const res = await app.request(
      `/api/log-import/${job_id}`,
      { headers: { cookie: await loginCookie(otherMember) } },
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Log import job not found.' });
  });

  it('anonymous GET still works in dev mode (user resolves to null, matching sibling-route scoping)', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );

    // Anonymous creator (REQUIRE_LOGIN=0 base env) → anonymous poll succeeds.
    const post = await postImport(show);
    const { job_id } = (await post.json()) as { job_id: string };
    const res = await app.request(`/api/log-import/${job_id}`, {}, env);
    expect(res.status).toBe(200);
  });
});
