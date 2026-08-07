// Shared catalog-layer types and helpers, kept dependency-free so both the Catalog
// facade and the individual domain stores can import them without a cycle.

export interface AuthUser {
  id: string;
  email: string;
  google_sub: string;
  given_name: string;
  family_name: string;
  picture_url: string;
}

export interface ProfileCtx {
  oauthConfigured: boolean;
  adminMeta: Record<string, boolean>;
}

export type Row = Record<string, unknown>;

export function nowIso(): string {
  return new Date().toISOString();
}

/** Invite/sign-in email normalization (design D2) — JS toLowerCase().trim()
 * only, identically wherever an email is matched against `email_norm`, never
 * SQL lower() (whose ASCII-only folding diverges on non-ASCII local parts).
 * Single shared source so invite time, sign-in time, and lookup time can
 * never drift apart. */
export function normalizeEmail(raw: string): string {
  return raw.toLowerCase().trim();
}
