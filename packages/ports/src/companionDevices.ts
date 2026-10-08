// CompanionDeviceStore port (companion-devices D2, D5; api-contract-freeze "Companion device tokens
// authenticate only the Companion surface"): per-user Companion device tokens in
// `catalog.companion_devices`. `@autologger/storage` implements it on
// `bindSystem('companion-device')` (`PostgresCompanionDeviceStore`), wired as
// `Bindings.ports.companionDevices`. The table has no user RLS, so every statement is scoped by
// user id in SQL. Only a token's SHA-256 (hex) is stored or passed here; the token itself never is.

/** The user a device authenticates as (an enabled user's row). */
export interface CompanionDeviceUser {
  id: string;
  email: string;
  google_sub: string;
  given_name: string;
  family_name: string;
  picture_url: string;
}

/** A device token lookup hit: the device and its enabled user. */
export interface CompanionDeviceAuth {
  deviceId: string;
  user: CompanionDeviceUser;
}

/** A listed device. Never carries the token or its hash. */
export interface CompanionDevice {
  id: string;
  name: string;
  created_at_utc: string;
  last_used_at_utc: string | null;
  /** True past the 90-day idle window (`coalesce(last_used_at_utc, created_at_utc)`). */
  expired: boolean;
}

/** `create`'s result: the new device, or the per-user cap (10) already reached (nothing created). */
export type CreateCompanionDeviceResult =
  | { kind: 'created'; device: CompanionDevice }
  | { kind: 'cap-reached' };

export interface CompanionDeviceStore {
  /** The device with this token hash whose user is enabled and which is not idle-expired, or null. */
  lookup(tokenHash: string): Promise<CompanionDeviceAuth | null>;
  /** Sets the device's last use to now, at most once a minute (a conditional update). Null when
   * nothing changed (used within the last minute, or no such device); otherwise `firstUse` is true
   * when the device had never been used. */
  touch(deviceId: string): Promise<{ firstUse: boolean } | null>;
  /** The user's devices, newest first. */
  list(userId: string): Promise<CompanionDevice[]>;
  /** Creates a device for the user, unless they already hold the cap; the count and the insert run
   * in one transaction under an advisory lock keyed on the user id. */
  create(userId: string, name: string, tokenHash: string): Promise<CreateCompanionDeviceResult>;
  /** Deletes the user's device; false when no device with that id belongs to the user. */
  delete(userId: string, deviceId: string): Promise<boolean>;
}
