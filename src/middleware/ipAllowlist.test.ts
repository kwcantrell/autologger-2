import { describe, expect, it } from 'vitest';
import { parseIpAllowlist } from './ipAllowlist';

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
});
