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

function textResponse(body: string, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

// A body given as raw bytes (rather than a string) does not trigger the Response
// constructor's own content-type sniffing default (`text/plain;charset=UTF-8` for a
// string body) — so `res.headers.get('content-type')` is genuinely `null`, pinning
// the case where a real server response omits the header entirely.
function noContentTypeResponse(body: string, status = 200): Response {
  return new Response(new TextEncoder().encode(body), { status });
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

  it('a JSON content-type returns the parsed body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 7, title: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await apiFetch('sessions/7');
    expect(result).toEqual({ id: 7, title: 'x' });
  });

  it('a non-JSON content-type returns the raw text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('id,title\n7,x\n', 'text/csv'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await apiFetch('sessions/7/export.csv');
    expect(result).toBe('id,title\n7,x\n');
  });

  it('a JSON content-type with parameters still takes the JSON branch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        textResponse(JSON.stringify({ ok: true }), 'application/json; charset=utf-8'),
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = await apiFetch('sessions');
    expect(result).toEqual({ ok: true });
  });

  it('a missing content-type header takes the text branch (pinned, not asserted-desirable)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(noContentTypeResponse('plain body'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await apiFetch('sessions/7/raw');
    expect(result).toBe('plain body');
  });

  it('non-ok responses throw ApiError with the extracted detail', async () => {
    // Fresh Response per call — a Response body is single-use.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ detail: 'nope' }, 403)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('admin/users')).rejects.toThrow(ApiError);
    await expect(
      apiFetch('admin/users').catch((e: ApiError) => Promise.reject(e.message)),
    ).rejects.toBe('nope');
  });
});
