// ai-v2-dashboards — dashboard persistence (task 5.1/5.2/5.3; design D5
// ruled session DB, D5a whole-config validation, D5b write-authz/bounds/
// delete). Stored in the session DB (`session_dashboards`, sessionCore.ts's
// `initSchema` — idempotent `CREATE TABLE IF NOT EXISTS`, no migration
// files, per D5) rather than the catalog DB: a dashboard belongs to exactly
// one session, is deleted with it, and there is no cross-session reuse story
// in v1.
//
// Every write goes through `validateDashboardConfig` (packages/contract/src/
// aiV2Catalog.ts) — the SAME function the persistence route (task 5.2) and, in a
// later unit, the design turn's `propose_dashboard` MCP tool (task 5.4) both
// call. This module never re-derives a second validator (design D5a: "This
// same whole-configuration validation SHALL be applied wherever a
// configuration enters the system"). The per-session dashboard-COUNT bound
// (design D5b) is the one bound that can't live in that shared schema (it
// needs to know how many dashboards already exist for the session), so it is
// enforced here, importing `MAX_DASHBOARDS_PER_SESSION` from catalog.ts
// rather than defining its own number — catalog.ts stays the single source
// of truth for every ai-v2 bound.
//
// Route-facing note: today's `DashboardPersistencePort` (web) and the
// `/ai/v2/dashboard` route (task 5.2) both operate on exactly ONE dashboard
// per session (`PRIMARY_DASHBOARD_ID` in aiV2.ts), matching the current
// single-canvas UI. This store's `id`-keyed shape is intentionally more
// general than that: `saveDashboard` accepts an arbitrary caller-supplied id
// and enforces the per-session COUNT bound on any id that doesn't already
// exist, so the bound is genuinely load-bearing (testable directly against
// this store) rather than trivially satisfied by always upserting the same
// row — a future multi-dashboard feature can reuse this store unchanged.

import type { DashboardConfig } from '@autologger/contract';
import { MAX_DASHBOARDS_PER_SESSION, validateDashboardConfig } from '@autologger/contract';
import { isoZ } from '@autologger/domain';
import type { Row, SessionCore } from './sessionCore';

export interface StoredDashboard {
  id: string;
  config: DashboardConfig;
  createdBy: string | null;
  createdByTurnId: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}

/** Design D5a: the whole config failed `validateDashboardConfig` — an
 * unknown widget type, a dangling interaction, a dangerous content pattern,
 * or an oversized config. Carries the Zod issue messages for the caller to
 * surface (mapped to 422 by the route). */
export class DashboardValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('; ') || 'Invalid dashboard configuration.');
    this.name = 'DashboardValidationError';
  }
}

/** Design D5b: the per-session dashboard-count bound was exceeded by this
 * write. Distinct from `DashboardValidationError` (a config-content problem)
 * — this is a session-scoped collection bound. */
export class DashboardBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashboardBoundsError';
  }
}

export function dashboardRow(r: Row): StoredDashboard {
  return {
    id: String(r.id),
    config: JSON.parse(String(r.config_json)) as DashboardConfig,
    createdBy: (r.created_by as string | null) ?? null,
    createdByTurnId: (r.created_by_turn_id as string | null) ?? null,
    createdAtUtc: String(r.created_at_utc ?? ''),
    updatedAtUtc: String(r.updated_at_utc ?? ''),
  };
}

export class DashboardStore {
  constructor(private core: SessionCore) {}

  getDashboard(id: string): StoredDashboard | null {
    const row = this.core.first('SELECT * FROM session_dashboards WHERE id = ?', id);
    return row ? dashboardRow(row) : null;
  }

  listDashboards(): StoredDashboard[] {
    return this.core
      .all('SELECT * FROM session_dashboards ORDER BY created_at_utc, id')
      .map(dashboardRow);
  }

  /** Whole-config validated (design D5a) and bounds-checked (design D5b)
   * BEFORE any write — throws rather than silently clamping, so a rejected
   * write stores nothing. An existing `id` is an UPDATE (config + updated_at
   * only — `created_by`/`created_by_turn_id` are set ONCE, at creation, and
   * never overwritten by a later direct edit, so provenance survives
   * subsequent direct-manipulation edits, design D5b: "stored configurations
   * SHALL record the principal that created them and the turn they
   * originated from"). A new `id` is an INSERT, gated on the per-session
   * count bound. */
  saveDashboard(input: {
    id: string;
    config: unknown;
    createdBy: string | null;
    createdByTurnId: string | null;
  }): StoredDashboard {
    const parsed = validateDashboardConfig(input.config);
    if (!parsed.success) {
      throw new DashboardValidationError(parsed.error.issues.map((i) => i.message));
    }

    const existing = this.core.first('SELECT 1 FROM session_dashboards WHERE id = ?', input.id);
    if (existing === null) {
      const count = Number(this.core.first('SELECT COUNT(*) AS n FROM session_dashboards')?.n ?? 0);
      if (count >= MAX_DASHBOARDS_PER_SESSION) {
        throw new DashboardBoundsError(
          `This session already has the maximum of ${MAX_DASHBOARDS_PER_SESSION} saved dashboards.`,
        );
      }
    }

    const now = isoZ(new Date(this.core.now()));
    const configJson = JSON.stringify(parsed.data);
    this.core.db.run(
      `INSERT INTO session_dashboards
         (id, config_json, created_by, created_by_turn_id, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         config_json = excluded.config_json,
         updated_at_utc = excluded.updated_at_utc`,
      input.id,
      configJson,
      input.createdBy,
      input.createdByTurnId,
      now,
      now,
    );
    return this.getDashboard(input.id) as StoredDashboard;
  }

  deleteDashboard(id: string): boolean {
    const r = this.core.db.run('DELETE FROM session_dashboards WHERE id = ?', id);
    return r.changes > 0;
  }
}
