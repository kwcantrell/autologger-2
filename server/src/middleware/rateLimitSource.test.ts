// The source a per-address rate limit counts (custom dashboards design section 4.3): IPv4 alone,
// IPv6 by its /64.
import { describe, expect, it } from 'vitest';
import { rateLimitSource } from './ipAllowlist';

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
