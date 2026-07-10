import { normalizeBaseUrl } from './config.js';
import type { ServerStatePayload } from './state.js';

export type ApiErrorKind = 'network' | 'auth' | 'no_session' | 'bad_category' | 'http';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

export interface CategoriesResponse {
  session_id: string;
  show_id: string | null;
  show_name: string | null;
  show_code: string | null;
  categories: Array<{ id: string; label: string }>;
}

function statusToKind(status: number): ApiErrorKind {
  if (status === 401) return 'auth';
  if (status === 409) return 'no_session';
  if (status === 400) return 'bad_category';
  return 'http';
}

export class AutologgerApi {
  private readonly base: string;
  private readonly token: string;
  private readonly signal: AbortSignal;
  private readonly timeoutMs: number;

  constructor(opts: { url: string; token: string; signal: AbortSignal; timeoutMs?: number }) {
    this.base = normalizeBaseUrl(opts.url);
    this.token = opts.token.trim();
    this.signal = opts.signal;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    // Per-request timeout, linked to the instance-scoped abort signal.
    const timer = new AbortController();
    const onAbort = (): void => timer.abort();
    this.signal.addEventListener('abort', onAbort, { once: true });
    const to = setTimeout(() => timer.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timer.signal,
      });
      if (!res.ok) {
        throw new ApiError(statusToKind(res.status), `${method} ${path} -> ${res.status}`, res.status);
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError('network', `${method} ${path} failed: ${String(err)}`);
    } finally {
      clearTimeout(to);
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  getState(): Promise<ServerStatePayload> {
    return this.request<ServerStatePayload>('GET', '/api/companion/state');
  }

  getCategories(): Promise<CategoriesResponse> {
    return this.request<CategoriesResponse>('GET', '/api/companion/categories');
  }

  async log(body: { category_id: string; message: string }): Promise<void> {
    await this.request('POST', '/api/companion/log', body);
  }

  async transport(action: 'start' | 'stop' | 'toggle'): Promise<void> {
    await this.request('POST', '/api/companion/transport', { action });
  }

  async command(
    type: 'record-start' | 'record-stop' | 'record-toggle' | 'play-toggle',
  ): Promise<void> {
    await this.request('POST', '/api/companion/command', { type });
  }
}
