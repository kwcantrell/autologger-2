// Companion device tokens (companion-devices D2; api-contract-freeze "Companion device management
// routes"): `ald_` followed by base64url of 32 random bytes. Only the token's SHA-256 (hex) is
// stored and looked up; the token itself is returned once, by the create route.

import { createHash, randomBytes } from 'node:crypto';

export const COMPANION_DEVICE_TOKEN_PREFIX = 'ald_';

export function newCompanionDeviceToken(): string {
  return `${COMPANION_DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashCompanionDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
