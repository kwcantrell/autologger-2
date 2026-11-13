// MCP OAuth dynamic client registration rules (design section 4.3; mcp-authorization "Dynamic
// client registration"): every redirect URI rule, the loopback port rule, and each field limit.
import { describe, expect, it } from 'vitest';
import {
  MCP_CLIENT_ID_PREFIX,
  newMcpClientId,
  parseClientMetadata,
  redirectUriMatches,
  validRedirectUri,
} from './mcpClientRegistration';

const OK_URI = 'https://claude.ai/api/mcp/auth_callback';
const meta = (over: Record<string, unknown> = {}) => ({
  client_name: 'Claude',
  redirect_uris: [OK_URI],
  ...over,
});

describe('redirect URIs (design 4.3)', () => {
  it.each([
    OK_URI,
    'https://example.com',
    'https://example.com/',
    'https://example.com:8443/cb?x=1',
    'HTTPS://Example.COM/cb',
    'https://[2001:db8::1]/cb',
    // Loopback with any port, or none (RFC 8252 section 7.3).
    'http://127.0.0.1/callback',
    'http://127.0.0.1:33418/callback',
    'http://localhost:8080/',
    'http://localhost',
    'http://LOCALHOST:1/cb',
    'http://[::1]:65535/cb',
    'http://[::1]/cb?state=x',
  ])('accepts %s', (uri) => {
    expect(validRedirectUri(uri)).toBe(true);
  });

  it.each([
    ['a non-loopback http URL', 'http://example.com/cb'],
    ['another loopback-looking address', 'http://127.0.0.2/cb'],
    ['a host that only starts with localhost', 'http://localhost.evil.com/cb'],
    ['user info hiding a host', 'http://127.0.0.1@evil.com/cb'],
    ['user info on https', 'https://user:pw@example.com/cb'],
    ['a fragment', 'https://example.com/cb#frag'],
    ['an empty fragment', 'https://example.com/cb#'],
    ['a fragment on loopback', 'http://localhost:1/cb#x'],
    ['a custom scheme', 'com.example.app:/oauth'],
    ['javascript', 'javascript:alert(1)'],
    ['a relative URL', '/callback'],
    ['a scheme-relative URL', '//example.com/cb'],
    ['https without slashes', 'https:example.com/cb'],
    ['a port over 65535', 'http://localhost:65536/cb'],
    ['whitespace', 'https://example.com/a b'],
    ['leading whitespace', ' https://example.com/cb'],
    ['a control character', 'https://example.com/\u0000'],
    ['a lone surrogate', 'https://example.com/\ud800'],
    ['the empty string', ''],
    ['over 2000 characters', `https://example.com/${'a'.repeat(1981)}`],
  ])('refuses %s', (_label, uri) => {
    expect(validRedirectUri(uri)).toBe(false);
  });

  it('accepts exactly 2000 characters', () => {
    expect(validRedirectUri(`https://example.com/${'a'.repeat(1980)}`)).toBe(true);
  });

  it('refuses a non-string', () => {
    expect(validRedirectUri(42)).toBe(false);
    expect(validRedirectUri(null)).toBe(false);
  });
});

describe('redirect URI matching: exact, except the loopback port (design 4.3, RFC 8252 7.3)', () => {
  it('matches an identical URI', () => {
    expect(redirectUriMatches(OK_URI, OK_URI)).toBe(true);
  });

  it('matches a loopback URI on any port, or with none', () => {
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1:51234/cb')).toBe(true);
    expect(redirectUriMatches('http://localhost:3000/cb', 'http://localhost:4000/cb')).toBe(true);
    expect(redirectUriMatches('http://[::1]:1/cb?a=1', 'http://[::1]/cb?a=1')).toBe(true);
  });

  it('keeps the loopback host, path and query exact', () => {
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://localhost:5/cb')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1:5/cb2')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1:5/cb?x=1')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1:5/cb#x')).toBe(false);
  });

  it('never ignores the port of an https URI', () => {
    expect(redirectUriMatches('https://example.com/cb', 'https://example.com:443/cb')).toBe(false);
    expect(redirectUriMatches('https://localhost/cb', 'https://localhost:8443/cb')).toBe(false);
  });

  it('matches nothing else: case, trailing slash or a prefix', () => {
    expect(redirectUriMatches(OK_URI, `${OK_URI}/`)).toBe(false);
    expect(redirectUriMatches(OK_URI, OK_URI.toUpperCase())).toBe(false);
    expect(redirectUriMatches(OK_URI, `${OK_URI}?x=1`)).toBe(false);
  });
});

describe('client metadata (design 4.3)', () => {
  it('accepts the minimal and the full form; other fields are ignored', () => {
    expect(parseClientMetadata(meta())).toEqual({
      ok: true,
      value: { client_name: 'Claude', redirect_uris: [OK_URI] },
    });
    expect(
      parseClientMetadata(
        meta({
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          application_type: 'native',
          logo_uri: 'https://evil.example/logo.png',
          client_uri: 'https://evil.example',
          scope: 'dashboards',
        }),
      ),
    ).toEqual({
      ok: true,
      value: { client_name: 'Claude', redirect_uris: [OK_URI], application_type: 'native' },
    });
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['null', null],
  ])('a body that is %s is invalid_client_metadata', (_l, body) => {
    expect(parseClientMetadata(body)).toMatchObject({
      ok: false,
      error: 'invalid_client_metadata',
    });
  });

  it.each([
    ['missing', undefined],
    ['not an array', OK_URI],
    ['empty', []],
    ['six URIs', Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`)],
    ['a non-string entry', [OK_URI, 5]],
    ['one bad entry among good ones', [OK_URI, 'http://example.com/cb']],
  ])('redirect_uris %s is invalid_redirect_uri', (_l, uris) => {
    expect(parseClientMetadata(meta({ redirect_uris: uris }))).toMatchObject({
      ok: false,
      error: 'invalid_redirect_uri',
    });
  });

  it('accepts five redirect URIs', () => {
    const uris = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`);
    expect(parseClientMetadata(meta({ redirect_uris: uris })).ok).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['not a string', 7],
    ['empty', ''],
    ['101 characters', 'n'.repeat(101)],
    ['a newline', 'Claude\nApproved'],
    ['NUL', 'Cla\u0000ude'],
    ['DEL', 'Claude\u007f'],
    ['a C1 control', 'Claude\u0085'],
    ['a right-to-left override', 'Claude ‮edualC'],
    ['a bidi isolate', 'Claude ⁦x⁩'],
    ['a lone surrogate', 'Claude \udc00'],
  ])('client_name %s is invalid_client_metadata', (_l, name) => {
    expect(parseClientMetadata(meta({ client_name: name }))).toMatchObject({
      ok: false,
      error: 'invalid_client_metadata',
    });
  });

  it('accepts a 1- and a 100-character name, counted in characters, not UTF-16 units', () => {
    expect(parseClientMetadata(meta({ client_name: 'C' })).ok).toBe(true);
    expect(parseClientMetadata(meta({ client_name: 'n'.repeat(100) })).ok).toBe(true);
    // 100 astral characters are 200 UTF-16 code units.
    expect(parseClientMetadata(meta({ client_name: '\u{1F600}'.repeat(100) })).ok).toBe(true);
    expect(parseClientMetadata(meta({ client_name: '\u{1F600}'.repeat(101) })).ok).toBe(false);
  });

  it.each([
    ['grant_types', 'authorization_code'],
    ['grant_types', []],
    ['grant_types', ['refresh_token']],
    ['grant_types', ['authorization_code', 'client_credentials']],
    ['grant_types', ['authorization_code', 'implicit']],
    ['response_types', ['token']],
    ['response_types', ['code', 'token']],
    ['response_types', 'code'],
    ['response_types', []],
    ['token_endpoint_auth_method', 'client_secret_basic'],
    ['token_endpoint_auth_method', 'client_secret_post'],
    ['application_type', 'desktop'],
  ])('%s %j is invalid_client_metadata', (field, value) => {
    expect(parseClientMetadata(meta({ [field]: value }))).toMatchObject({
      ok: false,
      error: 'invalid_client_metadata',
    });
  });

  it('accepts grant_types with authorization_code alone', () => {
    expect(parseClientMetadata(meta({ grant_types: ['authorization_code'] })).ok).toBe(true);
  });
});

describe('client ids (design 4.3)', () => {
  it('are alc_ plus 16 random bytes in base64url', () => {
    const a = newMcpClientId();
    const b = newMcpClientId();
    expect(a.startsWith(MCP_CLIENT_ID_PREFIX)).toBe(true);
    expect(a.slice(4)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(a.slice(4), 'base64url')).toHaveLength(16);
    expect(a).not.toBe(b);
  });
});
