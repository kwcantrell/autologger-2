import { describe, expect, it } from 'vitest';
import { ipInAllowlist, parseIpAllowlist } from './ipAllowlist';

describe('parseIpAllowlist', () => {
  it('returns null for empty / whitespace (disabled)', () => {
    expect(parseIpAllowlist('')).toBeNull();
    expect(parseIpAllowlist('   ')).toBeNull();
  });

  it('parses a v4 host and a v4 CIDR', () => {
    const nets = parseIpAllowlist('10.0.0.1, 192.168.0.0/24');
    expect(nets).toHaveLength(2);
    expect(nets?.[0]).toMatchObject({ version: 4, bits: 32 });
    expect(nets?.[1]).toMatchObject({ version: 4, bits: 24 });
  });

  it('parses v6, strips brackets and zone ids', () => {
    const nets = parseIpAllowlist('[2001:db8::1]/64, fe80::1%en0');
    expect(nets).toHaveLength(2);
    expect(nets?.[0]).toMatchObject({ version: 6, bits: 64 });
    expect(nets?.[1]).toMatchObject({ version: 6, bits: 128 });
  });

  it('throws on a malformed entry', () => {
    expect(() => parseIpAllowlist('999.1.1.1')).toThrow();
    expect(() => parseIpAllowlist('10.0.0.0/40')).toThrow();
  });

  it('parses a v6-mapped entry as a literal v6 network, not stripped to v4', () => {
    const nets = parseIpAllowlist('::ffff:10.0.0.0/104');
    expect(nets).toHaveLength(1);
    expect(nets?.[0]).toMatchObject({ version: 6, bits: 104 });
  });

  it('does not match a plain v4 address against a v6-mapped allowlist entry', () => {
    const nets = parseIpAllowlist('::ffff:10.0.0.0/24');
    expect(nets).not.toBeNull();
    expect(ipInAllowlist('10.0.0.5', nets ?? [])).toBe(false);
  });
});

describe('ipInAllowlist', () => {
  it('matches the v6-mapped loopback address against a plain v4 allowlist entry', () => {
    const nets = parseIpAllowlist('127.0.0.1');
    expect(nets).not.toBeNull();
    expect(ipInAllowlist('::ffff:127.0.0.1', nets ?? [])).toBe(true);
  });

  it('does not match a v6-mapped address outside the allowed v4 range', () => {
    const nets = parseIpAllowlist('203.0.113.0/24');
    expect(nets).not.toBeNull();
    expect(ipInAllowlist('::ffff:198.51.100.7', nets ?? [])).toBe(false);
  });
});
