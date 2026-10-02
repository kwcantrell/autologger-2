// gotrue-sign-in D2: the Google ID token is exchanged with GoTrue, whose user must hold exactly one
// Google identity with the verified subject. Failures carry a short reason, never a body or token.
import { describe, expect, it } from 'vitest';
import { exchangeGoogleIdToken, IdentityUnavailableError } from './gotrue';

const SUB = 'google-sub-1';
const ID = '6c0d2b6e-2a43-4a4e-9a3e-0c1f6f3c9b11';

type FakeFetch = (url: string, init: RequestInit) => Promise<Response>;
const calls: Array<{ url: string; init: RequestInit }> = [];
const respond =
  (status: number, body: unknown): FakeFetch =>
  async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
const google = (providerId: string) => ({ provider: 'google', provider_id: providerId });
const user = (identities: unknown[], id: unknown = ID) => ({
  access_token: 'at-secret',
  refresh_token: 'rt-secret',
  user: { id, email: 'a@example.com', identities },
});

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IdentityUnavailableError);
    return (e as IdentityUnavailableError).reason;
  }
  throw new Error('expected a rejection');
}

describe('exchangeGoogleIdToken', () => {
  it('posts the token to the id_token grant and returns the user id', async () => {
    calls.length = 0;
    const out = await exchangeGoogleIdToken('the-id-token', SUB, respond(200, user([google(SUB)])));
    expect(out).toEqual({ id: ID });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://auth:9999/token?grant_type=id_token');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      provider: 'google',
      id_token: 'the-id-token',
    });
  });

  it('accepts the subject from identity_data when provider_id is absent', async () => {
    const ident = { provider: 'google', identity_data: { sub: SUB } };
    expect(await exchangeGoogleIdToken('t', SUB, respond(200, user([ident])))).toEqual({ id: ID });
  });

  it('refuses a user without exactly one Google identity for the verified subject', async () => {
    for (const identities of [
      [],
      [google('other-sub')],
      [google(SUB), google('other-sub')],
      [{ provider: 'email', provider_id: SUB }],
    ]) {
      expect(await reason(exchangeGoogleIdToken('t', SUB, respond(200, user(identities))))).toBe(
        'identity mismatch',
      );
    }
  });

  it('reports a non-2xx status without the response body', async () => {
    for (const status of [400, 429, 500]) {
      const err = (await exchangeGoogleIdToken(
        't',
        SUB,
        respond(status, { error_description: 'leaky detail', id_token: 'echo' }),
      ).catch((e: unknown) => e)) as IdentityUnavailableError;
      expect(err).toBeInstanceOf(IdentityUnavailableError);
      expect(err.reason).toBe(`status ${status}`);
      expect(err.message).not.toMatch(/leaky|echo/);
    }
  });

  it('times out', async () => {
    const hang: FakeFetch = (_url, init) =>
      new Promise((_r, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    expect(await reason(exchangeGoogleIdToken('t', SUB, hang, 20))).toBe('timeout');
  });

  it('reports a network error', async () => {
    const down: FakeFetch = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await reason(exchangeGoogleIdToken('t', SUB, down))).toBe('network');
  });

  it('refuses a malformed body or user id', async () => {
    for (const body of [
      'not json',
      { user: null },
      user([google(SUB)], ''),
      user([google(SUB)], 'a\u0000b'),
    ]) {
      expect(await reason(exchangeGoogleIdToken('t', SUB, respond(200, body)))).toBe('malformed');
    }
  });
});
