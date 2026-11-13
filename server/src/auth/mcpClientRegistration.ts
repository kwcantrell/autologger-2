// MCP OAuth dynamic client registration rules (RFC 7591; ADR 0035 decision 5; design
// docs/design/custom-session-dashboards.md section 4.3; mcp-authorization "Dynamic client
// registration"). Pure functions: the route (`routers/oauth.ts`) owns the rate limit, the cap and
// the insert.
//
// - Redirect URIs: an absolute `https:` URL, or a loopback `http://127.0.0.1`, `http://localhost`
//   or `http://[::1]` URL with any port (RFC 8252 section 7.3, for Claude Code). No fragment, no
//   user info, no whitespace or control characters, at most 2000 characters. Anything else is
//   `invalid_redirect_uri`.
// - An authorization request's `redirect_uri` matches a registered one exactly, except that a
//   loopback URI matches ignoring its port (`redirectUriMatches`, used by J3).
// - `client_name` is 1-100 characters with no control characters and no bidirectional-text
//   controls, so the consent page can't be made to show reordered text. Other metadata fields
//   (`logo_uri`, `client_uri`, `policy_uri`, ...) are ignored and never fetched.

import { randomBytes } from 'node:crypto';

export const MCP_CLIENT_ID_PREFIX = 'alc_';
export const MCP_CLIENT_NAME_MAX = 100;
export const MCP_REDIRECT_URIS_MAX = 5;
export const MCP_REDIRECT_URI_MAX_LENGTH = 2000;
/** Registrations counted per source address in one window (design 4.3). */
export const MCP_REGISTRATIONS_PER_WINDOW = 10;
export const MCP_REGISTRATION_WINDOW_MS = 60 * 60_000;
/** The most clients that may exist at once; past it registration answers 429 (design 4.3). */
export const MCP_MAX_CLIENTS = 10_000;
/** The largest registration body read; a larger one is `invalid_client_metadata`. */
export const MCP_REGISTRATION_MAX_BODY_BYTES = 64 * 1024;

/** The grant types every registered client may use; the response always states both. */
export const MCP_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

export function newMcpClientId(): string {
  return `${MCP_CLIENT_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
}

// C0, DEL and C1 controls, plus every whitespace character.
const URI_FORBIDDEN = /[\p{Cc}\s]/u;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?([/?].*)?$/i;
// Control characters, and the bidirectional-text controls (embeddings, overrides, isolates and
// marks) that would reorder how the name is shown.
const NAME_FORBIDDEN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

// A lone UTF-16 surrogate, which has no UTF-8 form to store.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const wellFormed = (s: string): boolean => !LONE_SURROGATE.test(s);

/** Whether `raw` is an acceptable redirect URI (design 4.3). */
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MCP_REDIRECT_URI_MAX_LENGTH) {
    return false;
  }
  if (!wellFormed(raw) || URI_FORBIDDEN.test(raw) || raw.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (/^https:\/\//i.test(raw)) return url.protocol === 'https:' && url.hostname !== '';
  const m = LOOPBACK.exec(raw);
  if (!m) return false;
  return m[2] === undefined || Number(m[2]) <= 65535;
}

/** A loopback URI split into its scheme and host (lower-cased) and the rest after the port. */
function loopbackParts(uri: string): { origin: string; rest: string } | null {
  const m = LOOPBACK.exec(uri);
  if (!m) return null;
  return { origin: `http://${(m[1] as string).toLowerCase()}`, rest: m[3] ?? '' };
}

/**
 * Whether an authorization request's `redirect_uri` matches a registered one (design 4.3): the
 * same string, or, when both are valid loopback URIs, the same host, path and query with any port
 * (RFC 8252 section 7.3).
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  if (!validRedirectUri(requested)) return false;
  const a = loopbackParts(registered);
  const b = loopbackParts(requested);
  return a !== null && b !== null && a.origin === b.origin && a.rest === b.rest;
}

export type RegistrationError = 'invalid_redirect_uri' | 'invalid_client_metadata';

export interface ClientMetadata {
  client_name: string;
  redirect_uris: string[];
  application_type?: 'web' | 'native';
}

export type ParsedRegistration =
  | { ok: true; value: ClientMetadata }
  | { ok: false; error: RegistrationError; description: string };

const fail = (error: RegistrationError, description: string): ParsedRegistration => ({
  ok: false,
  error,
  description,
});

/** Validates a registration body (parsed JSON) and names the first problem (design 4.3). */
export function parseClientMetadata(body: unknown): ParsedRegistration {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('invalid_client_metadata', 'The body must be a JSON object.');
  }
  const m = body as Record<string, unknown>;

  const uris = m.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length < 1 ||
    uris.length > MCP_REDIRECT_URIS_MAX ||
    !uris.every(validRedirectUri)
  ) {
    return fail(
      'invalid_redirect_uri',
      'redirect_uris must list 1 to 5 https URLs, or loopback http URLs, without fragments.',
    );
  }

  const name = m.client_name;
  if (
    typeof name !== 'string' ||
    !wellFormed(name) ||
    [...name].length < 1 ||
    [...name].length > MCP_CLIENT_NAME_MAX ||
    NAME_FORBIDDEN.test(name)
  ) {
    return fail(
      'invalid_client_metadata',
      'client_name must be 1 to 100 characters with no control characters.',
    );
  }

  if (m.grant_types !== undefined) {
    const g = m.grant_types;
    if (
      !Array.isArray(g) ||
      !g.includes('authorization_code') ||
      !g.every((t) => (MCP_GRANT_TYPES as readonly unknown[]).includes(t))
    ) {
      return fail(
        'invalid_client_metadata',
        'grant_types must include authorization_code and may add only refresh_token.',
      );
    }
  }
  if (m.response_types !== undefined) {
    const r = m.response_types;
    if (!Array.isArray(r) || r.length !== 1 || r[0] !== 'code') {
      return fail('invalid_client_metadata', 'response_types must be ["code"].');
    }
  }
  if (m.token_endpoint_auth_method !== undefined && m.token_endpoint_auth_method !== 'none') {
    return fail(
      'invalid_client_metadata',
      'token_endpoint_auth_method must be "none": only public clients are registered.',
    );
  }
  const appType = m.application_type;
  if (appType !== undefined && appType !== 'web' && appType !== 'native') {
    return fail('invalid_client_metadata', 'application_type must be "web" or "native".');
  }

  return {
    ok: true,
    value: {
      client_name: name,
      redirect_uris: uris as string[],
      ...(appType === undefined ? {} : { application_type: appType }),
    },
  };
}
