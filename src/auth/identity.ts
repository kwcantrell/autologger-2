// Identity — KV-backed login sessions + OAuth CSRF state, bearer-token compare,
// and the /api login gate. Ports src/autologger/web/auth_identity.py; the
// login_sessions + oauth_csrf_tokens SQLite tables become KV keys with TTL.

import type { AuthUser, Catalog } from '../db/d1';

const SESSION_PREFIX = 'session:'; // session:<sha256(token)> -> userId
const CSRF_PREFIX = 'csrf:'; // csrf:<state> -> "1"

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(nbytes: number): string {
  const buf = new Uint8Array(nbytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time string compare (length leak only, like hmac.compare_digest). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// -- OAuth CSRF state (replaces oauth_csrf_tokens + 30-min expiry) -------------

export async function putOauthState(
  kv: KVNamespace,
  state: string,
  ttlSeconds = 1800,
): Promise<void> {
  await kv.put(`${CSRF_PREFIX}${state}`, '1', { expirationTtl: ttlSeconds });
}

/** Delete and return true if the state existed (one-shot). */
export async function takeOauthState(kv: KVNamespace, state: string): Promise<boolean> {
  const key = `${CSRF_PREFIX}${state}`;
  const v = await kv.get(key);
  if (v === null) return false;
  await kv.delete(key);
  return true;
}

export function newOauthState(): string {
  return randomToken(32);
}

// -- Login sessions (replaces login_sessions + manual expiry sweep) -----------

/** Create an opaque bearer token; store SHA-256(token) -> userId in KV with TTL. */
export async function createLoginSession(
  kv: KVNamespace,
  userId: string,
  ttlDays: number,
): Promise<string> {
  const raw = randomToken(48);
  const hash = await sha256Hex(raw);
  const ttl = Math.max(60, Math.floor(ttlDays * 86400));
  await kv.put(`${SESSION_PREFIX}${hash}`, userId, { expirationTtl: ttl });
  return raw;
}

export async function revokeLoginSession(kv: KVNamespace, rawToken: string): Promise<void> {
  const t = rawToken.trim();
  if (!t) return;
  await kv.delete(`${SESSION_PREFIX}${await sha256Hex(t)}`);
}

/** Resolve a session cookie value to an AuthUser via KV → D1, or null. */
export async function resolveSessionUser(
  kv: KVNamespace,
  catalog: Catalog,
  rawToken: string | undefined,
): Promise<AuthUser | null> {
  const t = (rawToken ?? '').trim();
  if (!t) return null;
  const userId = await kv.get(`${SESSION_PREFIX}${await sha256Hex(t)}`);
  if (userId === null) return null;
  const row = await catalog.authGetUserById(userId);
  if (row === null) return null;
  return {
    id: String(row.id),
    email: String(row.email),
    google_sub: String(row.google_sub),
    given_name: String(row.given_name ?? ''),
    family_name: String(row.family_name ?? ''),
    picture_url: String(row.picture_url ?? ''),
  };
}

// -- Bearer token + gate ------------------------------------------------------

function bearerToken(req: Request): string | null {
  const auth = (req.headers.get('Authorization') ?? '').trim();
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

/** True when the request bears the API_TOKEN (device-level credential). */
export function requestHasValidApiToken(req: Request, apiToken: string): boolean {
  const expected = (apiToken ?? '').trim();
  if (!expected) return false;
  const got = bearerToken(req);
  if (got === null) return false;
  return timingSafeEqual(got, expected);
}

/** True when the request bears the ADMIN_TOKEN. */
export function requestHasValidAdminToken(req: Request, adminToken: string): boolean {
  const expected = (adminToken ?? '').trim();
  if (!expected) return false;
  const got = bearerToken(req);
  if (got === null) return false;
  return timingSafeEqual(got, expected);
}

/** GET /api/profile is the only anonymous API when strict login is on; /api/admin/* is token-gated. */
export function apiRequestRequiresLogin(path: string, method: string): boolean {
  if (path === '/api/profile' && method === 'GET') return false;
  if (path.startsWith('/api/admin/')) return false;
  return path.startsWith('/api/');
}

/** Trim + percent-decode an OAuth state param (mirror _normalize_oauth_state_param). */
export function normalizeOauthStateParam(value: string): string {
  const s = (value ?? '').trim();
  if (!s) return '';
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
