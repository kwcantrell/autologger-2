// ai-v2-dashboards — the client-side dashboard PERSISTENCE BOUNDARY (task
// 4.6; spec "Dashboards are edited directly, not only by conversation").
//
// Phase 5 (tasks.md 5.1-5.3) landed the real wire contract: GET/PUT/DELETE
// `/api/sessions/:sessionId/ai/v2/dashboard` (server/src/routers/aiV2.ts) —
// write authorization, whole-config validation, per-session/per-dashboard/
// serialized-size bounds, and `created_by`/originating-turn provenance all
// live server-side (spec "Dashboard persistence"). `fetchDashboardPersistence`
// below is the real `DashboardPersistencePort` implementation calling those
// endpoints, and is now `AiV2Panel`'s DEFAULT (no call-site changes there —
// only the default value the `persistence?` prop falls back to). It carries
// exactly the `DashboardConfig` JSON the spec already defines
// (packages/contract/src/aiV2Catalog.ts's `dashboardConfigSchema`, mirrored on the web
// side as `DashboardConfig` in ./widgetTypes) as the bare GET/PUT body — no
// wrapper beyond `{ config }` on the response envelope.
//
//   load(sessionId)         -> Promise<DashboardConfig | null>
//     GET; `null` means "no dashboard saved yet for this session" (a 200
//     `{ config: null }` response) — never a fabricated empty dashboard.
//     Rejects (throws) on any non-2xx response, INCLUDING 404 (an
//     inaccessible/nonexistent session) — a caller viewing a session already
//     has access, so a 404 here is a genuine error, not "no dashboard yet".
//   save(sessionId, config, turnId?) -> Promise<void>
//     PUT; `config` is a `DashboardConfig` value (the exact shape
//     `dashboardConfigSchema` validates). Rejects (throws, carrying the
//     server's `{ detail }` when present) on any non-2xx response — a 422
//     (invalid config/over a bound), a 404 (inaccessible session), or a 503
//     (AI v2 unconfigured) all surface as a thrown Error for the caller
//     (AiV2Panel) to catch and show, rather than failing silently
//     (task 5.2: "Surface save errors in the UI"). `turnId` (fix wave, D5b
//     completeness — "stored configurations SHALL record... the turn they
//     originated from") is optional: present when this save commits a design
//     turn's proposed dashboard (the `dashboard` SSE event now carries the
//     turn's id), absent for a user-authored save (`Start blank`, direct-
//     manipulation edits) — carried as the PUT route's existing `?turnId=`
//     query param, never a body field.
//
// MOCKED implementation kept for tests: `localStorageDashboardPersistence`
// below (task 4.6's original default, backed by `window.localStorage`) is
// NOT used by app code anymore, but stays exported/tested since existing
// DashboardEditor/AiV2Panel tests inject it (or an equivalent fake) directly
// via the `persistence` prop rather than exercising the network.

import type { DashboardConfig } from './widgetTypes';

export interface DashboardPersistencePort {
  load(sessionId: string): Promise<DashboardConfig | null>;
  save(sessionId: string, config: DashboardConfig, turnId?: string | null): Promise<void>;
}

async function readDetail(res: Response): Promise<string | null> {
  try {
    const data = (await res.json()) as { detail?: unknown };
    return typeof data.detail === 'string' ? data.detail : null;
  } catch {
    return null;
  }
}

/** The REAL persistence boundary (task 5.2) — calls
 * `/api/sessions/:sessionId/ai/v2/dashboard` (server/src/routers/aiV2.ts).
 * `AiV2Panel`'s default; every call site there is unchanged (it only ever
 * calls `persistence.load(...)`/`persistence.save(...)`, per the port
 * interface). */
export const fetchDashboardPersistence: DashboardPersistencePort = {
  async load(sessionId: string): Promise<DashboardConfig | null> {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ai/v2/dashboard`, {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const detail = await readDetail(res);
      throw new Error(detail ?? `Failed to load dashboard (HTTP ${res.status}).`);
    }
    const data = (await res.json()) as { config: DashboardConfig | null };
    return data.config ?? null;
  },
  async save(sessionId: string, config: DashboardConfig, turnId?: string | null): Promise<void> {
    const query = turnId ? `?turnId=${encodeURIComponent(turnId)}` : '';
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/ai/v2/dashboard${query}`,
      {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      },
    );
    if (!res.ok) {
      const detail = await readDetail(res);
      throw new Error(detail ?? `Failed to save dashboard (HTTP ${res.status}).`);
    }
  },
};

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
