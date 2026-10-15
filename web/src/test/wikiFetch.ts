import { vi } from 'vitest';
import type { WikiPage } from '../api/types';

// Shared by the wiki component tests (show-wiki tasks 5.5, 5.6): a wiki page factory and a
// `fetch` stub that answers by method and path, as the AiChat tests stub `fetch` globally. The
// real `apiFetch` and React Query run on top of it, so the tests see the wire bodies.

export interface FetchCall {
  method: string;
  /** The path after `/api/`, query string included. */
  path: string;
  body: unknown;
}

export interface Reply {
  status?: number;
  json: unknown;
}

export function wikiPage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    id: 'p1',
    show_id: 'sh-1',
    kind: 'person',
    title: 'Christina Ramos',
    body_md: 'Christina **hosts** the show.',
    aliases: ['Chris R.'],
    session_id: null,
    revision: 3,
    merged_into: null,
    deleted: false,
    created_at_utc: '2026-10-01T10:00:00.000Z',
    created_by_name: 'Kai Lee',
    updated_at_utc: '2026-10-12T15:30:00.000Z',
    updated_by_name: 'Ana Ruiz',
    ...overrides,
  };
}

/** Stub `fetch`; `handler` answers each call (`undefined` answers 404). Returns the call log. */
export function stubApi(handler: (call: FetchCall) => Reply | undefined): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^\/api\//, '');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const call = { method, path, body };
      calls.push(call);
      const reply = handler(call) ?? { status: 404, json: { detail: 'Not found.' } };
      return new Response(JSON.stringify(reply.json), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

/** The writes in the log (everything but `GET`). */
export const writesOf = (calls: FetchCall[]) => calls.filter((c) => c.method !== 'GET');
