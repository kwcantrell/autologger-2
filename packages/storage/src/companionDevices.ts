// The CompanionDeviceStore port on `catalog.companion_devices` (companion-devices D2, D5;
// api-contract-freeze "Companion device tokens authenticate only the Companion surface"). It binds
// its own reviewed system reason, `companion-device` (RLS `catalog_system` allow-all; `catalog_user`
// has no privilege on the table), and serves both the device-token lookup and the management
// routes. There is no user RLS on the table, so the `user_id` predicates here are the only
// isolation. Every time it reads or writes comes from the Clock port, as ISO `*_utc` text.

import { randomUUID } from 'node:crypto';
import type {
  CatalogDb,
  CatalogRoot,
  Clock,
  CompanionDevice,
  CompanionDeviceAuth,
  CompanionDeviceStore,
  CreateCompanionDeviceResult,
} from '@autologger/ports';

/** At most this many devices per user (D5). */
export const COMPANION_DEVICE_CAP = 10;
/** A device unused for this long no longer authenticates (D2 idle expiry: 90 days). */
export const COMPANION_DEVICE_IDLE_MS = 90 * 86_400_000;
/** `last_used_at_utc` is updated at most once per this interval per device (D2). */
export const COMPANION_DEVICE_TOUCH_MS = 60_000;

interface StoredDevice {
  id: string;
  name: string;
  created_at_utc: string;
  last_used_at_utc: string | null;
  expired: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class PostgresCompanionDeviceStore implements CompanionDeviceStore {
  private readonly db: CatalogDb;

  constructor(
    root: CatalogRoot,
    private readonly clock: Clock,
  ) {
    this.db = root.bindSystem('companion-device');
  }

  async lookup(tokenHash: string): Promise<CompanionDeviceAuth | null> {
    if (!tokenHash) return null;
    const row = await this.db.first<Record<string, unknown>>(
      `SELECT d.id AS device_id, u.id, u.email, u.google_sub, u.given_name, u.family_name,
              u.picture_url
         FROM companion_devices d JOIN users u ON u.id = d.user_id
        WHERE d.token_hash = ? AND u.disabled_at_utc IS NULL
          AND coalesce(d.last_used_at_utc, d.created_at_utc) > ?`,
      tokenHash,
      iso(this.clock.now() - COMPANION_DEVICE_IDLE_MS),
    );
    if (row === null) return null;
    return {
      deviceId: String(row.device_id),
      user: {
        id: String(row.id),
        email: String(row.email),
        google_sub: String(row.google_sub),
        given_name: String(row.given_name ?? ''),
        family_name: String(row.family_name ?? ''),
        picture_url: String(row.picture_url ?? ''),
      },
    };
  }

  /** The conditional update (D2). The locked subquery reads the previous value, so of two
   * concurrent first uses only the one that sets it reports `firstUse`. */
  async touch(deviceId: string): Promise<{ firstUse: boolean } | null> {
    const now = this.clock.now();
    const row = await this.db.first<{ first_use: boolean }>(
      `UPDATE companion_devices d SET last_used_at_utc = ?
         FROM (SELECT id, last_used_at_utc AS prev FROM companion_devices WHERE id = ? FOR UPDATE) p
        WHERE d.id = p.id
          AND (d.last_used_at_utc IS NULL OR d.last_used_at_utc < ?)
       RETURNING p.prev IS NULL AS first_use`,
      iso(now),
      deviceId,
      iso(now - COMPANION_DEVICE_TOUCH_MS),
    );
    return row === null ? null : { firstUse: row.first_use === true };
  }

  async list(userId: string): Promise<CompanionDevice[]> {
    const rows = await this.db.all<StoredDevice>(
      `SELECT id, name, created_at_utc, last_used_at_utc,
              coalesce(last_used_at_utc, created_at_utc) <= ? AS expired
         FROM companion_devices
        WHERE user_id = ?
        ORDER BY created_at_utc DESC, id`,
      iso(this.clock.now() - COMPANION_DEVICE_IDLE_MS),
      userId,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      created_at_utc: r.created_at_utc,
      last_used_at_utc: r.last_used_at_utc,
      expired: r.expired === true,
    }));
  }

  async create(
    userId: string,
    name: string,
    tokenHash: string,
  ): Promise<CreateCompanionDeviceResult> {
    const id = randomUUID();
    const createdAt = iso(this.clock.now());
    return this.db.tx(async (t) => {
      // Serializes the count and the insert per user (D5), so concurrent creates can't make 11.
      await t.first(
        "SELECT pg_advisory_xact_lock(hashtextextended('companion-device:' || ?, 0))::text AS locked",
        userId,
      );
      const count = await t.first<{ n: number }>(
        'SELECT count(*)::int AS n FROM companion_devices WHERE user_id = ?',
        userId,
      );
      if (Number(count?.n ?? 0) >= COMPANION_DEVICE_CAP) return { kind: 'cap-reached' as const };
      await t.run(
        `INSERT INTO companion_devices (id, user_id, name, token_hash, created_at_utc)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        userId,
        name,
        tokenHash,
        createdAt,
      );
      return {
        kind: 'created' as const,
        device: { id, name, created_at_utc: createdAt, last_used_at_utc: null, expired: false },
      };
    });
  }

  async delete(userId: string, deviceId: string): Promise<boolean> {
    const { changes } = await this.db.run(
      'DELETE FROM companion_devices WHERE id = ? AND user_id = ?',
      deviceId,
      userId,
    );
    return changes > 0;
  }
}
