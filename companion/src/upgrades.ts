import type { CompanionStaticUpgradeScript } from '@companion-module/base';
import type { ModuleConfig, ModuleSecrets } from './config.js';

/**
 * 9d (design D7): the token moved from a plain config field to a secret. Carry an old
 * `config.token` into `secrets.token` once, unless a secret is already set. The old value
 * was the server's API_TOKEN, which the server no longer accepts, so the carried token
 * only keeps the field filled; the status then asks for a device token.
 */
const moveTokenToSecrets: CompanionStaticUpgradeScript<ModuleConfig, ModuleSecrets> = (
  _context,
  props,
) => {
  const noop = { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] };
  const config = props.config as (ModuleConfig & { token?: unknown }) | null;
  const oldToken = config?.token;
  if (!config || typeof oldToken !== 'string' || oldToken === '') return noop;
  if (props.secrets?.token) return noop;
  const { token: _dropped, ...rest } = config;
  return {
    updatedConfig: rest,
    updatedSecrets: { ...(props.secrets ?? {}), token: oldToken },
    updatedActions: [],
    updatedFeedbacks: [],
  };
};

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig, ModuleSecrets>[] = [
  moveTokenToSecrets,
];
