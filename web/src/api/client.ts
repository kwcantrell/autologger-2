const rawApiRoot = (document.body.dataset.apiRoot ?? '').trim();
export const API_ROOT =
  rawApiRoot === '__API_ROOT__' || rawApiRoot === '' ? '/api' : rawApiRoot.replace(/\/$/, '');

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
    headers: {
      'Content-Type': 'application/json',
      ...opts.headers,
    },
    ...opts,
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { detail?: unknown };
      if (j.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
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
 * WebSocket URL for an API path, mirroring `apiUrl`'s API_ROOT logic:
 * an absolute API_ROOT (`http(s)://…`) swaps its scheme to `ws(s)`; a relative
 * `/api` root resolves same-origin against the current page. The cookie rides the
 * same-origin upgrade.
 */
export function wsUrl(path: string): string {
  const suffix = `/${path.replace(/^\//, '')}`;
  if (/^https?:\/\//i.test(API_ROOT)) {
    return `${API_ROOT.replace(/^http/i, 'ws')}${suffix}`;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${API_ROOT}${suffix}`;
}
