import { describe, expect, it } from 'vitest';
import { googleAuthorizationUrl } from './oauth_google';

describe('googleAuthorizationUrl', () => {
  it('builds the Google auth URL with the expected params', () => {
    const url = new URL(
      googleAuthorizationUrl({
        clientId: 'cid',
        state: 'st8',
        redirectUri: 'http://127.0.0.1:8787/auth/google/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('cid');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:8787/auth/google/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('state')).toBe('st8');
    expect(q.get('access_type')).toBe('online');
    expect(q.get('prompt')).toBe('select_account');
  });
});
