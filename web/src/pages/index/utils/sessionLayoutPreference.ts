export const SESSION_LAYOUT_PREFERENCE_KEY = 'autologger.sessionLayoutPreference';

export type SessionLayoutPreference = 'default' | 'maximize-log';

export function parseSessionLayoutPreference(raw: string | null | undefined): SessionLayoutPreference {
  if (raw === 'maximize-log') return 'maximize-log';
  return 'default';
}

export function readSessionLayoutPreference(): SessionLayoutPreference {
  if (typeof window === 'undefined') return 'default';
  try {
    return parseSessionLayoutPreference(window.localStorage.getItem(SESSION_LAYOUT_PREFERENCE_KEY));
  } catch {
    return 'default';
  }
}

export function writeSessionLayoutPreference(value: SessionLayoutPreference): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SESSION_LAYOUT_PREFERENCE_KEY, value);
}
