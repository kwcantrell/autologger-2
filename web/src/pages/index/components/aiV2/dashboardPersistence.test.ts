import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __clearDashboardPersistenceForTest,
  fetchDashboardPersistence,
  localStorageDashboardPersistence,
} from './dashboardPersistence';
import type { DashboardConfig } from './widgetTypes';

// --- dashboardPersistence (ai-v2-dashboards, task 4.6) ---
//
// The MOCKED client-side persistence boundary (see the module header for the
// request/response shape Phase 5 wires real endpoints to). These tests cover
// the default localStorage-backed implementation's own contract — round
// trip, `null` for a session with nothing saved, and independence between
// sessions — not the editing operations that call it (DashboardEditor.test.tsx
// covers the "no fetch" invariant for those).

const CONFIG: DashboardConfig = {
  widgets: [{ id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 3 }],
  interactions: [],
};

afterEach(() => {
  __clearDashboardPersistenceForTest('sess-a');
  __clearDashboardPersistenceForTest('sess-b');
});

describe('localStorageDashboardPersistence', () => {
  it('load() returns null for a session with nothing saved', async () => {
    expect(await localStorageDashboardPersistence.load('sess-a')).toBeNull();
  });

  it('save() then load() round-trips the exact config', async () => {
    await localStorageDashboardPersistence.save('sess-a', CONFIG);
    const loaded = await localStorageDashboardPersistence.load('sess-a');
    expect(loaded).toEqual(CONFIG);
  });

  it('two sessions do not cross-contaminate', async () => {
    await localStorageDashboardPersistence.save('sess-a', CONFIG);
    expect(await localStorageDashboardPersistence.load('sess-b')).toBeNull();
  });

  it('never calls fetch', async () => {
    const spy = vi.spyOn(global, 'fetch');
    await localStorageDashboardPersistence.save('sess-a', CONFIG);
    await localStorageDashboardPersistence.load('sess-a');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// --- fetchDashboardPersistence (ai-v2-dashboards task 5.2) — the REAL
// `DashboardPersistencePort`, backing AiV2Panel's default `persistence` prop.
// Calls `/api/sessions/:sessionId/ai/v2/dashboard`; a fetch mock stands in
// for the server here (server-side guard/validation behavior is covered by
// server/src/routers/aiV2.int.test.ts against the real route).
describe('fetchDashboardPersistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('load() GETs the session-scoped dashboard endpoint and returns config: null verbatim as null', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('/api/sessions/sess-a/ai/v2/dashboard');
      return { ok: true, status: 200, json: async () => ({ config: null }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchDashboardPersistence.load('sess-a')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('load() returns the config when the server has one saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ config: CONFIG }),
          }) as unknown as Response,
      ),
    );
    expect(await fetchDashboardPersistence.load('sess-a')).toEqual(CONFIG);
  });

  it('load() throws (surfacing the server detail) on a non-OK response, e.g. a masked 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 404,
            json: async () => ({ detail: 'Session not found' }),
          }) as unknown as Response,
      ),
    );
    await expect(fetchDashboardPersistence.load('sess-a')).rejects.toThrow('Session not found');
  });

  it('save() PUTs the config as the bare request body (no wrapper)', async () => {
    let capturedBody: unknown;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/sessions/sess-a/ai/v2/dashboard');
      expect(init?.method).toBe('PUT');
      capturedBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ config: CONFIG }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchDashboardPersistence.save('sess-a', CONFIG);
    expect(capturedBody).toEqual(CONFIG);
  });

  it('save() throws (surfacing the server detail) on a non-OK response, e.g. a 422 over a bound', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 422,
            json: async () => ({ detail: 'Serialized dashboard configuration exceeds the limit.' }),
          }) as unknown as Response,
      ),
    );
    await expect(fetchDashboardPersistence.save('sess-a', CONFIG)).rejects.toThrow(
      'Serialized dashboard configuration exceeds the limit.',
    );
  });

  it('save() falls back to a generic message when the error body carries no detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response,
      ),
    );
    await expect(fetchDashboardPersistence.save('sess-a', CONFIG)).rejects.toThrow(/HTTP 500/);
  });

  // Fix wave (Phase 5 review, D5b completeness): the originating turn is
  // carried as the PUT route's existing `?turnId=` query param, never a body
  // field — proves the seam the AiV2Panel proposal-persist flow now uses.
  it('save() with a turnId appends it as ?turnId= on the PUT URL', async () => {
    let capturedUrl: string | undefined;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ config: CONFIG }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchDashboardPersistence.save('sess-a', CONFIG, 'turn-123');
    expect(capturedUrl).toBe('/api/sessions/sess-a/ai/v2/dashboard?turnId=turn-123');
  });

  it('save() with no turnId (a user-authored save) omits the query param entirely', async () => {
    let capturedUrl: string | undefined;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ config: CONFIG }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchDashboardPersistence.save('sess-a', CONFIG);
    expect(capturedUrl).toBe('/api/sessions/sess-a/ai/v2/dashboard');
  });
});
