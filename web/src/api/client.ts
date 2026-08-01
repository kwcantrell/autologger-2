export const API_ROOT = '/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const url = `${API_ROOT}/${path.replace(/^\//, '')}`;
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...opts,
    // Merge AFTER spreading opts so caller-supplied headers extend the default
    // Content-Type instead of replacing the whole merged object.
    headers: {
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { detail?: unknown; message?: unknown };
      if (j.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
      else if (typeof j.message === 'string' && j.message.trim()) detail = j.message;
    } catch {
      // ignore parse errors — use statusText
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`);
  }

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return res.json() as Promise<T>;
  return res.text() as unknown as Promise<T>;
}

export function apiUrl(path: string): string {
  return `${API_ROOT}/${path.replace(/^\//, '')}`;
}

/**
 * WebSocket URL for an API path: resolves same-origin against the current
 * page under the `/api` root. The cookie rides the same-origin upgrade.
 */
export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${API_ROOT}/${path.replace(/^\//, '')}`;
}
