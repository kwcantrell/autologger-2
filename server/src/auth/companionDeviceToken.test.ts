// Companion device token generation and hashing (companion-devices D2; api-contract-freeze
// "Companion device management routes"): `ald_` + base64url of 32 random bytes; only the SHA-256
// (hex) is stored.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashCompanionDeviceToken, newCompanionDeviceToken } from './companionDeviceToken';

describe('Companion device tokens (companion-devices D2)', () => {
  it('is ald_ followed by unpadded base64url of 32 random bytes', () => {
    const token = newCompanionDeviceToken();
    expect(token).toMatch(/^ald_[A-Za-z0-9_-]{43}$/);
    const bytes = Buffer.from(token.slice(4), 'base64url');
    expect(bytes).toHaveLength(32);
    expect(bytes.toString('base64url')).toBe(token.slice(4));
  });

  it('is different every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newCompanionDeviceToken()));
    expect(tokens.size).toBe(50);
  });

  it('hashes to the lowercase hex SHA-256 of the whole token', () => {
    const token = newCompanionDeviceToken();
    const hash = hashCompanionDeviceToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(hashCompanionDeviceToken('ald_x')).toBe(
      createHash('sha256').update('ald_x', 'utf8').digest('hex'),
    );
    expect(hashCompanionDeviceToken(token)).toBe(hash);
  });
});
