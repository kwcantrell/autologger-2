import type { webcrypto } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { vi } from 'vitest';

type JsonWebKey = webcrypto.JsonWebKey;

let kidCounter = 0;

export async function makeKeypair(): Promise<{
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  kidCounter += 1;
  const kid = `test-kid-${kidCounter}`;
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey: privateKey as CryptoKey, publicJwk };
}

export async function mintIdToken(opts: {
  privateKey: CryptoKey;
  kid: string;
  audience: string;
  claims: Record<string, unknown>;
}): Promise<string> {
  return new SignJWT(opts.claims)
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid })
    .setIssuer('https://accounts.google.com')
    .setAudience(opts.audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(opts.privateKey);
}

// FALLBACK from undici's MockAgent: on this stack (Node 22.22.1 + undici
// 8.7.0), MockAgent.setGlobalDispatcher only replaces the
// Symbol.for('undici.globalDispatcher.2') slot. Node's built-in fetch reads
// Symbol.for('undici.globalDispatcher.1') (its own bundled, older undici),
// which the npm package leaves pointed at a `Dispatcher1Wrapper` compat shim
// that does *not* delegate to the MockAgent — so requests made through global
// fetch() reach the real network uncontested (confirmed: a real Google
// `invalid_grant_type` JSON error came back through despite
// `disableNetConnect()`). Route global fetch through a queued-response mock
// instead, keyed on (method, origin+path), matching in registration order.
interface QueuedMock {
  method: string;
  path: string;
  status: number;
  body: string;
  headers: Record<string, string>;
}

let queue: QueuedMock[] = [];
let stubbed = false;

function ensureStub(): void {
  if (stubbed) return;
  stubbed = true;
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET') ?? 'GET')
        .toString()
        .toUpperCase();
      const idx = queue.findIndex((m) => m.method === method && m.path === url.pathname);
      if (idx === -1) {
        throw new Error(`No mock registered for ${method} ${url.pathname}`);
      }
      const [match] = queue.splice(idx, 1);
      return new Response(match.body, { status: match.status, headers: match.headers });
    },
  );
}

/** Test-only: drop any unconsumed queued mocks so one test's leftovers don't
 * bleed into the next. Call from an `afterEach` in suites that use
 * `mockGoogleToken`/`mockGoogleJwks`. */
export function resetMockAgent(): void {
  queue = [];
}

export function mockGoogleToken(body: unknown, status = 200): void {
  ensureStub();
  queue.push({
    method: 'POST',
    path: '/token',
    status,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

export function mockGoogleJwks(publicJwk: JsonWebKey): void {
  ensureStub();
  queue.push({
    method: 'GET',
    path: '/oauth2/v3/certs',
    status: 200,
    body: JSON.stringify({ keys: [publicJwk] }),
    headers: { 'content-type': 'application/json' },
  });
}
