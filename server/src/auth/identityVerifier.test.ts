// IdentityVerifier port (de-cloudflare-strong-core task 6.2): the JWKS cache
// is instance state with its TTL on the injected Clock, and a fake verifier
// satisfies the port with no network at all.

import type { Clock, IdentityVerifier } from '@autologger/ports';
import type { JWTPayload } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { makeKeypair, mintIdToken, mockGoogleJwks, resetMockAgent } from '../test/oauth';
import { GoogleIdentityVerifier } from './oauth_google';

const CLIENT = 'test-client';

function fakeClock(startMs = 1_750_000_000_000): { clock: Clock; tick(ms: number): void } {
  let now = startMs;
  return { clock: { now: () => now }, tick: (ms) => (now += ms) };
}

afterEach(() => resetMockAgent());

describe('GoogleIdentityVerifier JWKS cache', () => {
  it('caches the JWKS per instance and refetches only after the Clock passes the TTL', async () => {
    const kp = await makeKeypair();
    const { clock, tick } = fakeClock();
    const verifier = new GoogleIdentityVerifier(clock);
    const token = await mintIdToken({
      privateKey: kp.privateKey,
      kid: kp.kid,
      audience: CLIENT,
      claims: { sub: 's1', email: 'a@b.com' },
    });

    mockGoogleJwks(kp.publicJwk); // exactly ONE queued JWKS response
    await verifier.verifyIdToken(token, CLIENT);
    // Within the TTL: the cached JWKS serves; no second fetch is queued, so a
    // refetch here would throw "No mock registered".
    await verifier.verifyIdToken(token, CLIENT);

    tick(10 * 60_000 + 1); // past the 10-minute TTL on the injected clock
    await expect(verifier.verifyIdToken(token, CLIENT)).rejects.toThrow(/No mock registered/);

    mockGoogleJwks(kp.publicJwk); // queue the refetch response
    await expect(verifier.verifyIdToken(token, CLIENT)).resolves.toMatchObject({ sub: 's1' });
  });

  it('two instances hold independent caches (no module-level singleton)', async () => {
    const kp = await makeKeypair();
    const { clock } = fakeClock();
    const a = new GoogleIdentityVerifier(clock);
    const b = new GoogleIdentityVerifier(clock);
    const token = await mintIdToken({
      privateKey: kp.privateKey,
      kid: kp.kid,
      audience: CLIENT,
      claims: { sub: 's2', email: 'a@b.com' },
    });
    mockGoogleJwks(kp.publicJwk);
    await a.verifyIdToken(token, CLIENT);
    // b has no cache of its own: with no mock queued it must try to fetch.
    await expect(b.verifyIdToken(token, CLIENT)).rejects.toThrow(/No mock registered/);
  });
});

describe('fake IdentityVerifier (no network)', () => {
  it('satisfies the port with canned claims and zero fetches', async () => {
    const fake: IdentityVerifier = {
      authorizationUrl: () => 'https://fake.example/auth',
      exchangeCode: async () => ({ id_token: 'fake-token' }),
      verifyIdToken: async (): Promise<JWTPayload> => ({
        sub: 'fake-sub',
        email: 'fake@example.com',
      }),
    };
    const tokens = await fake.exchangeCode({
      code: 'x',
      redirectUri: 'r',
      clientId: 'c',
      clientSecret: 's',
    });
    const claims = await fake.verifyIdToken(String(tokens.id_token), 'c');
    expect(claims.sub).toBe('fake-sub');
    expect(fake.authorizationUrl({ clientId: 'c', state: 's', redirectUri: 'r' })).toContain(
      'fake.example',
    );
  });
});
