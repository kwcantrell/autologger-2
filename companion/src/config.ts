import { Regex, type SomeCompanionConfigField } from '@companion-module/base';

export interface ModuleConfig {
  url: string;
  pollMs: number;
}

/** Kept in Companion's secrets store, not the config store (design D7). */
export interface ModuleSecrets {
  token?: string;
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function clampPollMs(n: number): number {
  if (!Number.isFinite(n)) return 1000;
  return Math.min(10000, Math.max(250, Math.trunc(n)));
}

export function getConfigFields(): SomeCompanionConfigField[] {
  return [
    {
      type: 'textinput',
      id: 'url',
      label: 'AutoLogger server URL',
      width: 8,
      default: 'http://127.0.0.1:8787',
      regex: Regex.SOMETHING,
    },
    {
      type: 'secret-text',
      id: 'token',
      label: 'Device token (required)',
      tooltip: 'Create one in AutoLogger Settings → Companion devices',
      width: 8,
      default: '',
    },
    {
      type: 'number',
      id: 'pollMs',
      label: 'Poll interval (ms)',
      width: 4,
      default: 1000,
      min: 250,
      max: 10000,
    },
  ];
}
