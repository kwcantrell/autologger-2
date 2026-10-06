// session-edit-conflicts D2: the version guard an edit carries, and the matcher for the
// version-conflict 409 (`{"detail":"Version conflict.","current":<row>}`). No React.

import { ApiError } from './client';
import type { VersionConflict } from './types';

/** The version an edit was based on, and whether to replace a row that changed since. */
export interface VersionGuard {
  version?: number;
  overwrite?: boolean;
}

const VERSION_CONFLICT_DETAIL = 'Version conflict.';

function checked(g?: VersionGuard): VersionGuard | null {
  if (!g) return null;
  if (g.version === undefined) {
    // The server answers 422 to an overwrite with no version: a programming error.
    if (g.overwrite) throw new Error('VersionGuard: overwrite needs a version');
    return null;
  }
  return g;
}

/** Body fields for a versioned update. Nothing for an absent guard or version (last writer
 * wins, byte-identical to an unversioned request). */
export function guardBody(g?: VersionGuard): { version?: number; overwrite?: true } {
  const c = checked(g);
  if (!c) return {};
  return c.overwrite ? { version: c.version, overwrite: true } : { version: c.version };
}

/** Query string for a versioned delete: `''`, `?version=N` or `?version=N&overwrite=1`. */
export function versionQuery(g?: VersionGuard): string {
  const c = checked(g);
  if (!c) return '';
  return c.overwrite ? `?version=${c.version}&overwrite=1` : `?version=${c.version}`;
}

/**
 * The typed 409 body when `e` is a version conflict, else `null` (the caller rethrows). One
 * discriminator on the error path, not runtime shape checking: `C` must be a type the
 * conformance file covers from captured fixtures (Detector 8 `errorBody`).
 */
export function versionConflictOf<C extends VersionConflict<{ version: number }>>(
  e: unknown,
): C | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.body;
  if (typeof body !== 'object' || body === null) return null;
  const { detail, current } = body as { detail?: unknown; current?: unknown };
  if (detail !== VERSION_CONFLICT_DETAIL) return null;
  if (typeof current !== 'object' || current === null) return null;
  const version = (current as { version?: unknown }).version;
  if (typeof version !== 'number' || !Number.isFinite(version)) return null;
  return body as C;
}
