// apiFetch header-merge regression coverage (2026-07-27 review, finding 1.2):
// `...opts` used to be spread AFTER the merged headers object, so any
// caller-supplied `opts.headers` replaced the whole merged object and dropped
// the default Content-Type. The merge now happens after the spread.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('sends the default Content-Type when no headers are supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('sessions');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('caller-supplied headers extend the defaults instead of dropping Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('admin/users', { headers: { Authorization: 'Bearer t0k' } });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer t0k',
    });
  });

  it('caller-supplied Content-Type overrides the default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('upload', { headers: { 'Content-Type': 'audio/webm' } });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ 'Content-Type': 'audio/webm' });
  });

  it('other RequestInit fields (method, body) still pass through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('sessions', { method: 'POST', body: '{"title":"x"}' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"title":"x"}');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('non-ok responses throw ApiError with the extracted detail', async () => {
    // Fresh Response per call — a Response body is single-use.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ detail: 'nope' }, 403)),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('admin/users')).rejects.toThrow(ApiError);
    await expect(
      apiFetch('admin/users').catch((e: ApiError) => Promise.reject(e.message)),
    ).rejects.toBe('nope');
  });
});
