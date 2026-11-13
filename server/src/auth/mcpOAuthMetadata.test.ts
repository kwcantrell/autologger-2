// The MCP OAuth identifiers and the per-address limit's source key (design sections 4.1-4.3).
import type { Config } from '@autologger/ports';
import { describe, expect, it } from 'vitest';
import { mcpIssuer, mcpResource, rateLimitSource } from './mcpOAuthMetadata';

const cfg = (url: string) => ({ PUBLIC_BASE_URL: url }) as unknown as Config;

describe('issuer and resource (design 4.1)', () => {
  it('are the public origin without a trailing slash, and it plus /mcp', () => {
    expect(mcpIssuer(cfg('https://app.example.com/'))).toBe('https://app.example.com');
    expect(mcpResource(cfg('https://app.example.com'))).toBe('https://app.example.com/mcp');
  });
});

describe('rate-limit source (design 4.3)', () => {
  it('counts an IPv4 address alone', () => {
    expect(rateLimitSource('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitSource('203.0.113.8')).toBe('203.0.113.8');
  });

  it('counts an IPv4-mapped IPv6 address as its IPv4 address', () => {
    expect(rateLimitSource('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts an IPv6 address by its /64', () => {
    expect(rateLimitSource('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitSource('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(rateLimitSource('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(rateLimitSource('[2001:db8::1]')).toBe('2001:db8:0:0::/64');
    expect(rateLimitSource('::1')).toBe('0:0:0:0::/64');
  });

  it('counts an address that does not parse as unknown', () => {
    expect(rateLimitSource('')).toBe('unknown');
    expect(rateLimitSource('not-an-ip')).toBe('unknown');
  });
});
