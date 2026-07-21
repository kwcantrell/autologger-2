// ai-v2-dashboards — the client-side dashboard PERSISTENCE BOUNDARY (task
// 4.6; spec "Dashboards are edited directly, not only by conversation").
//
// Phase 5 ("Persistence", tasks.md 5.1-5.3) has not landed yet and owns the
// real wire contract (spec "Dashboard persistence": write authorization,
// whole-config validation, per-session/per-dashboard/serialized-size
// bounds, `created_by`/originating-turn provenance). This module is the SEAM
// Phase 5 backs with real HTTP endpoints: a `DashboardPersistencePort` with
// `load(sessionId)` / `save(sessionId, config)`. Per this unit's brief, it
// deliberately does NOT invent a server route or a wire shape beyond the
// `DashboardConfig` JSON the spec already defines
// (server/src/aiV2/catalog.ts's `dashboardConfigSchema`, mirrored on the web
// side as `DashboardConfig` in ./widgetTypes) — the boundary carries that
// value and nothing else.
//
// Request/response shape for Phase 5 to wire real endpoints to (recorded
// here, not invented beyond the spec's own schema):
//   load(sessionId)         -> Promise<DashboardConfig | null>
//     GET-shaped; `null` means "no dashboard saved yet for this session" —
//     never a fabricated empty dashboard.
//   save(sessionId, config) -> Promise<void>
//     PUT/POST-shaped; `config` is a `DashboardConfig` value (the exact shape
//     `dashboardConfigSchema` validates). Phase 5 scopes both to the session
//     per the spec ("Reading SHALL be scoped exactly as the session... "
//     "Writing SHALL be scoped at least as tightly") and records
//     `created_by` / the originating turn server-side; neither is this
//     seam's concern.
//
// MOCKED default implementation (task 4.6 constraint: "build against a
// MOCKED save/load boundary"): `localStorageDashboardPersistence` below is
// backed by `window.localStorage`, keyed per session, so editing survives a
// reload today even though no server endpoint exists yet — this is NOT the
// real persistence path and Phase 5 replaces it wholesale with a
// `fetch`-backed implementation of the same `DashboardPersistencePort`. Every
// caller in this unit (DashboardEditor, AiV2Panel) depends only on the port
// interface, never on the localStorage detail, so that swap is a one-object
// replacement with no call-site changes.

import type { DashboardConfig } from './widgetTypes';

export interface DashboardPersistencePort {
  load(sessionId: string): Promise<DashboardConfig | null>;
  save(sessionId: string, config: DashboardConfig): Promise<void>;
}

const STORAGE_PREFIX = 'aiv2-dashboard:';

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

// In-environments-without-localStorage fallback (defensive; this app always
// runs in a browser, so this path is not expected to be exercised).
const memoryFallback = new Map<string, DashboardConfig>();

export const localStorageDashboardPersistence: DashboardPersistencePort = {
  async load(sessionId: string): Promise<DashboardConfig | null> {
    if (!hasLocalStorage()) return memoryFallback.get(sessionId) ?? null;
    const raw = window.localStorage.getItem(storageKey(sessionId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as DashboardConfig).widgets)
      ) {
        return parsed as DashboardConfig;
      }
      return null;
    } catch {
      return null;
    }
  },
  async save(sessionId: string, config: DashboardConfig): Promise<void> {
    if (!hasLocalStorage()) {
      memoryFallback.set(sessionId, config);
      return;
    }
    window.localStorage.setItem(storageKey(sessionId), JSON.stringify(config));
  },
};

/** Test-only helper — clears both storage backends for one session so tests
 * don't leak dashboard state across cases. Not used by app code. */
export function __clearDashboardPersistenceForTest(sessionId: string): void {
  memoryFallback.delete(sessionId);
  if (hasLocalStorage()) window.localStorage.removeItem(storageKey(sessionId));
}
