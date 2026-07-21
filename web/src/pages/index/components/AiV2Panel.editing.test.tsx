import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQueryClient } from '../../../test/renderWithQueryClient';
import { AiV2Panel } from './AiV2Panel';
import type { DashboardPersistencePort } from './aiV2/dashboardPersistence';
import type { DashboardConfig } from './aiV2/widgetTypes';

// --- AiV2Panel — direct-manipulation editing wiring (ai-v2-dashboards, task
// 4.6; spec "Dashboards are edited directly, not only by conversation") ---
//
// These tests exercise the CANVAS seam end to end: "Start blank" creating an
// empty dashboard config in edit mode, add/remove/retitle mutating it and
// calling the persistence boundary's `save` — and, the load-bearing gate
// assertion, that NONE of this ever calls `/ai/v2/design` or `/ai/v2/answer`
// (i.e. never runs a design turn — the only two fetch call sites for that,
// both in AiV2Design.tsx, which this panel mounts alongside the canvas the
// whole time). Since ai-v2-dashboards task 5.6, the canvas ALSO fires plain
// GET requests for its widget-data hooks (transcript-words/topics/events/
// show-categories) on every mount — legitimate, unrelated to running a
// design turn — so the gate below asserts those two specific endpoints were
// never called, rather than "fetch was never called at all" (this file's
// original, now over-broad, assertion).

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

function fakePort(initial: DashboardConfig | null = null): DashboardPersistencePort & {
  saves: DashboardConfig[];
  saveTurnIds: Array<string | null | undefined>;
} {
  let current = initial;
  const saves: DashboardConfig[] = [];
  const saveTurnIds: Array<string | null | undefined> = [];
  return {
    saves,
    saveTurnIds,
    async load() {
      return current;
    },
    async save(_sessionId, config, turnId) {
      current = config;
      saves.push(config);
      saveTurnIds.push(turnId);
    },
  };
}

/** A single benign, empty-shaped 200 response satisfies every widget-data GET
 * (transcript-words/topics/events/show-categories) — none of these tests
 * assert on rendered widget content, only on the editing/persistence seam,
 * so an unrouted catch-all is sufficient (and keeps this file's `fetchSpy`
 * simple enough to still assert against directly). */
function benignFetchResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({}),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => benignFetchResponse()),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AiV2Panel — Start blank', () => {
  it('creates an empty dashboard config, drops straight into edit mode, and persists it', async () => {
    const port = fakePort(null);
    renderWithQueryClient(<AiV2Panel sessionId="sess-1" persistence={port} />);

    const startBlank = await screen.findByTestId('aiv2-start-blank');
    fireEvent.click(startBlank);

    expect(await screen.findByTestId('aiv2-dashboard-editor')).toBeTruthy();
    await waitFor(() => {
      expect(port.saves).toEqual([{ widgets: [], interactions: [] }]);
    });
    // Fix wave (Phase 5 review, D5b completeness): a user-authored save
    // (no design turn involved) never supplies a turnId — `createdByTurnId`
    // correctly stays null server-side for this path.
    expect(port.saveTurnIds).toEqual([undefined]);
  });

  it('a previously saved dashboard loads directly into read-only view mode (DashboardGrid), not the editor', async () => {
    const saved: DashboardConfig = {
      widgets: [{ id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 3 }],
      interactions: [],
    };
    const port = fakePort(saved);
    renderWithQueryClient(<AiV2Panel sessionId="sess-1" persistence={port} />);

    expect(await screen.findByTestId('aiv2-dashboard-grid')).toBeTruthy();
    expect(screen.queryByTestId('aiv2-dashboard-editor')).toBeNull();
    expect(screen.getByTestId('aiv2-dashboard-edit')).toBeTruthy();
  });
});

describe('AiV2Panel — a dashboard is modified end-to-end with NO agent turn', () => {
  it('add + retitle + remove on a blank dashboard call save() but never fetch()', async () => {
    const fetchSpy = vi.mocked(fetch);
    const port = fakePort(null);
    renderWithQueryClient(<AiV2Panel sessionId="sess-1" persistence={port} />);

    fireEvent.click(await screen.findByTestId('aiv2-start-blank'));
    await screen.findByTestId('aiv2-dashboard-editor');

    // add
    fireEvent.click(screen.getByTestId('aiv2-editor-add-widget'));
    fireEvent.click(screen.getByTestId('aiv2-picker-item-session_duration'));
    await waitFor(() => expect(port.saves.length).toBe(2)); // start-blank save + add save
    expect(last(port.saves)?.widgets).toHaveLength(1);

    // retitle
    const widgetNode = screen.getByTestId('aiv2-editor-widget');
    fireEvent.keyDown(widgetNode, { key: 'Enter' });
    const input = screen.getByTestId('aiv2-editor-retitle-input');
    fireEvent.change(input, { target: { value: 'My duration' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(last(port.saves)?.widgets[0].title).toBe('My duration'));

    // reposition + resize (keyboard)
    fireEvent.keyDown(screen.getByTestId('aiv2-editor-widget'), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByTestId('aiv2-editor-widget'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    await waitFor(() => {
      const w = last(port.saves)?.widgets[0];
      expect(w?.x).toBe(1);
      expect(w?.h).toBe(4);
    });

    // remove
    fireEvent.click(screen.getByTestId('aiv2-editor-remove'));
    await waitFor(() => expect(last(port.saves)?.widgets).toEqual([]));

    // Gate assertion: none of add/retitle/reposition/resize/remove (nor the
    // widget-data hooks firing on mount) ever touched the design-turn
    // endpoints (/ai/v2/design, /ai/v2/answer) — the ONLY call sites for
    // those both live in AiV2Design.tsx, mounted alongside this canvas the
    // entire time. (The canvas's OWN GET requests for widget data are
    // expected and unrelated to this gate — see this file's header comment.)
    const designOrAnswerCalls = fetchSpy.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : String(input);
      return url.includes('/ai/v2/design') || url.includes('/ai/v2/answer');
    });
    expect(designOrAnswerCalls).toHaveLength(0);
  });
});

// --- ai-v2-dashboards task 5.2: "Surface save errors in the UI" — the
// Phase 4 boundary was fire-and-forget with no error path at all. ---
describe('AiV2Panel — save/load errors are surfaced, not silently swallowed', () => {
  it('a rejected save() shows an inline error banner', async () => {
    const port: DashboardPersistencePort = {
      async load() {
        return null;
      },
      async save() {
        throw new Error('Serialized dashboard configuration exceeds the limit.');
      },
    };
    renderWithQueryClient(<AiV2Panel sessionId="sess-1" persistence={port} />);

    fireEvent.click(await screen.findByTestId('aiv2-start-blank'));

    expect((await screen.findByTestId('aiv2-dashboard-error')).textContent).toBe(
      'Serialized dashboard configuration exceeds the limit.',
    );
  });

  it('a rejected load() shows an inline error banner and still renders the empty state (fails open)', async () => {
    const port: DashboardPersistencePort = {
      async load() {
        throw new Error('Failed to load dashboard (HTTP 500).');
      },
      async save() {},
    };
    renderWithQueryClient(<AiV2Panel sessionId="sess-1" persistence={port} />);

    expect((await screen.findByTestId('aiv2-dashboard-error')).textContent).toBe(
      'Failed to load dashboard (HTTP 500).',
    );
    expect(await screen.findByTestId('aiv2-start-blank')).toBeTruthy();
  });

  it('a subsequent successful save clears a prior error banner', async () => {
    let shouldFail = true;
    const port: DashboardPersistencePort = {
      async load() {
        return { widgets: [], interactions: [] };
      },
      async save() {
        if (shouldFail) throw new Error('Save failed.');
      },
    };
    renderWithQueryClient(<AiV2Panel sessionId="sess-1" persistence={port} />);

    fireEvent.click(await screen.findByTestId('aiv2-dashboard-edit'));
    fireEvent.click(screen.getByTestId('aiv2-editor-add-widget'));
    fireEvent.click(screen.getByTestId('aiv2-picker-item-session_duration'));
    await screen.findByTestId('aiv2-dashboard-error');

    shouldFail = false;
    fireEvent.click(screen.getByTestId('aiv2-editor-remove'));
    await waitFor(() => expect(screen.queryByTestId('aiv2-dashboard-error')).toBeNull());
  });
});
