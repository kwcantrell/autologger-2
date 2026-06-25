import { fetchMock } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

let kidCounter = 0;

export async function makeKeypair(): Promise<{
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = `test-kid-${(kidCounter += 1)}`;
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

export function mockGoogleToken(body: unknown, status = 200): void {
  fetchMock
    .get('https://oauth2.googleapis.com')
    .intercept({ path: '/token', method: 'POST' })
    .reply(status, JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

export function mockGoogleJwks(publicJwk: JsonWebKey): void {
  fetchMock
    .get('https://www.googleapis.com')
    .intercept({ path: '/oauth2/v3/certs', method: 'GET' })
    .reply(200, JSON.stringify({ keys: [publicJwk] }), {
      headers: { 'content-type': 'application/json' },
    });
}
