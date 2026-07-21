import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __clearDashboardPersistenceForTest,
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
