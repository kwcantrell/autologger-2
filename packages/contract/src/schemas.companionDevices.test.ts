// Companion device management routes (companion-devices D5; api-contract-freeze "Companion device
// management routes"): the request body of `POST /api/companion-devices` and the response shapes of
// the three routes. The routes themselves are pinned by `server/src/routers/companionDevices.int`.

import { describe, expect, it } from 'vitest';
import {
  COMPANION_DEVICE_NAME_MAX,
  companionDeviceCreateBodySchema,
  companionDeviceCreatedResponseSchema,
  companionDeviceListResponseSchema,
} from './schemas';

const TOKEN = `ald_${'A'.repeat(42)}w`; // 32 bytes as unpadded base64url: 43 characters
const CREATED_AT = '2026-10-08T12:00:00.000Z';

describe('companionDeviceCreateBodySchema', () => {
  it('trims the name', () => {
    const r = companionDeviceCreateBodySchema.safeParse({ name: '  Booth A  ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ name: 'Booth A' });
  });

  it('takes 1 to 80 characters after trimming', () => {
    expect(COMPANION_DEVICE_NAME_MAX).toBe(80);
    expect(companionDeviceCreateBodySchema.safeParse({ name: 'x' }).success).toBe(true);
    const eighty = ` ${'x'.repeat(80)} `;
    const r = companionDeviceCreateBodySchema.safeParse({ name: eighty });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toHaveLength(80);
    expect(companionDeviceCreateBodySchema.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
  });

  it('refuses an empty, blank, missing or non-string name', () => {
    for (const body of [{ name: '' }, { name: '   ' }, { name: '\t\n' }, {}, { name: 7 }, null]) {
      expect(companionDeviceCreateBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it('leaves NUL to the route (the existing NUL 400, not a 422)', () => {
    expect(companionDeviceCreateBodySchema.safeParse({ name: 'a\u0000b' }).success).toBe(true);
  });

  it('strips unknown keys (a client cannot choose the id, user or token)', () => {
    const r = companionDeviceCreateBodySchema.safeParse({
      name: 'Booth A',
      id: 'x',
      user_id: 'u',
      token: 'ald_x',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ name: 'Booth A' });
  });
});

describe('companionDeviceListResponseSchema', () => {
  const device = {
    id: 'd1',
    name: 'Booth A',
    created_at: CREATED_AT,
    last_used_at: null,
    expired: false,
  };

  it('accepts devices with a null or ISO last use', () => {
    const r = companionDeviceListResponseSchema.safeParse({
      devices: [device, { ...device, id: 'd2', last_used_at: CREATED_AT, expired: true }],
    });
    expect(r.success).toBe(true);
    expect(companionDeviceListResponseSchema.safeParse({ devices: [] }).success).toBe(true);
  });

  it('never carries a token or its hash', () => {
    for (const extra of [{ token: TOKEN }, { token_hash: 'ab'.repeat(32) }]) {
      const r = companionDeviceListResponseSchema.safeParse({ devices: [{ ...device, ...extra }] });
      expect(r.success).toBe(false);
    }
  });

  it('requires every field, with ISO-8601 UTC times and a boolean expired', () => {
    for (const key of Object.keys(device)) {
      const partial: Record<string, unknown> = { ...device };
      delete partial[key];
      expect(companionDeviceListResponseSchema.safeParse({ devices: [partial] }).success).toBe(
        false,
      );
    }
    for (const bad of [
      { created_at: 'yesterday' },
      { last_used_at: 'never' },
      { expired: 'false' },
    ]) {
      expect(
        companionDeviceListResponseSchema.safeParse({ devices: [{ ...device, ...bad }] }).success,
      ).toBe(false);
    }
  });
});

describe('companionDeviceCreatedResponseSchema', () => {
  const created = { id: 'd1', name: 'Booth A', created_at: CREATED_AT, token: TOKEN };

  it('is {id, name, created_at, token} with an ald_ token of 32 base64url bytes', () => {
    expect(companionDeviceCreatedResponseSchema.safeParse(created).success).toBe(true);
  });

  it('refuses a token without the prefix or of the wrong length or alphabet', () => {
    for (const token of [
      'A'.repeat(47),
      `ald_${'A'.repeat(42)}`,
      `ald_${'A'.repeat(44)}`,
      `ald_${'A'.repeat(42)}=`,
      `ald_${'A'.repeat(42)}+`,
    ]) {
      expect(companionDeviceCreatedResponseSchema.safeParse({ ...created, token }).success).toBe(
        false,
      );
    }
  });

  it('carries nothing else (no hash, no last use)', () => {
    for (const extra of [{ token_hash: 'ab'.repeat(32) }, { last_used_at: null }]) {
      expect(companionDeviceCreatedResponseSchema.safeParse({ ...created, ...extra }).success).toBe(
        false,
      );
    }
  });
});
