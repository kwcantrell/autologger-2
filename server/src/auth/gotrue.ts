// Sign-in through Supabase Auth (gotrue-sign-in D1-D3): the Google ID token the server has just
// verified is exchanged with GoTrue's id_token grant, which verifies it again and returns its user.
// GoTrue is reached directly over the two-member auth-app network, so no Supabase key is needed.
// The tokens it issues are discarded (D5); only the user id is kept.

const GOTRUE_TOKEN_URL = 'http://auth:9999/token?grant_type=id_token';

/** GoTrue could not vouch for this identity. `reason` is short and safe to log: never a response
 * body or a token. */
export class IdentityUnavailableError extends Error {
  override name = 'IdentityUnavailableError';
  constructor(readonly reason: string) {
    super(`Supabase Auth exchange failed: ${reason}`);
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Exchange a verified Google ID token for the GoTrue user id. The user must hold exactly one
 * Google identity, and it must be `googleSub`: GoTrue links identities by email, so a different
 * Google account can come back attached to the same user (D2). */
export async function exchangeGoogleIdToken(
  idToken: string,
  googleSub: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 5000,
): Promise<{ id: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  let body: unknown;
  try {
    res = await fetchImpl(GOTRUE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', id_token: idToken }),
      signal,
    });
    if (!res.ok) throw new IdentityUnavailableError(`status ${res.status}`);
    body = await res.json().catch(() => null);
  } catch (e) {
    if (e instanceof IdentityUnavailableError) throw e;
    throw new IdentityUnavailableError(signal.aborted ? 'timeout' : 'network');
  }
  const user = (body as { user?: { id?: unknown; identities?: unknown } } | null)?.user;
  const id = user?.id;
  if (typeof id !== 'string' || id === '' || id.includes('\u0000')) {
    throw new IdentityUnavailableError('malformed');
  }
  const googles = (Array.isArray(user?.identities) ? user.identities : []).filter(
    (i: { provider?: unknown }) => i?.provider === 'google',
  ) as Array<{ provider_id?: unknown; identity_data?: { sub?: unknown } }>;
  const subject = googles[0]?.provider_id ?? googles[0]?.identity_data?.sub;
  if (googles.length !== 1 || subject !== googleSub) {
    throw new IdentityUnavailableError('identity mismatch');
  }
  return { id };
}
