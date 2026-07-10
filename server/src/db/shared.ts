// Shared D1-layer types and helpers, kept dependency-free so both the Catalog
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
