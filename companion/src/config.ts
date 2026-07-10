import { Regex, type SomeCompanionConfigField } from '@companion-module/base';

export interface ModuleConfig {
  url: string;
  token: string;
  pollMs: number;
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
      type: 'textinput',
      id: 'token',
      label: 'API token (only if REQUIRE_LOGIN=1)',
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
