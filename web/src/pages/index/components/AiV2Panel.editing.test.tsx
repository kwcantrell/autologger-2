import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import { AiV2Panel } from './AiV2Panel';
import type { DashboardPersistencePort } from './aiV2/dashboardPersistence';
import type { DashboardConfig } from './aiV2/widgetTypes';

// --- AiV2Panel — direct-manipulation editing wiring (ai-v2-dashboards, task
// 4.6; spec "Dashboards are edited directly, not only by conversation") ---
//
// These tests exercise the CANVAS seam end to end: "Start blank" creating an
// empty dashboard config in edit mode, add/remove/retitle mutating it and
// calling the persistence boundary's `save` — and, the load-bearing gate
// assertion, that NONE of this ever calls `fetch` (i.e. never runs a design
// turn against `/ai/v2/design` or `/ai/v2/answer` — the ONLY fetch call
// sites for this feature, both in AiV2Design.tsx, which this panel mounts
// alongside the canvas the whole time).

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

function fakePort(initial: DashboardConfig | null = null): DashboardPersistencePort & {
  saves: DashboardConfig[];
} {
  let current = initial;
  const saves: DashboardConfig[] = [];
  return {
    saves,
    async load() {
      return current;
    },
    async save(_sessionId, config) {
      current = config;
      saves.push(config);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AiV2Panel — Start blank', () => {
  it('creates an empty dashboard config, drops straight into edit mode, and persists it', async () => {
    const port = fakePort(null);
    renderStrict(<AiV2Panel sessionId="sess-1" persistence={port} />);

    const startBlank = await screen.findByTestId('aiv2-start-blank');
    fireEvent.click(startBlank);

    expect(await screen.findByTestId('aiv2-dashboard-editor')).toBeTruthy();
    await waitFor(() => {
      expect(port.saves).toEqual([{ widgets: [], interactions: [] }]);
    });
  });

  it('a previously saved dashboard loads directly into read-only view mode (DashboardGrid), not the editor', async () => {
    const saved: DashboardConfig = {
      widgets: [{ id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 3 }],
      interactions: [],
    };
    const port = fakePort(saved);
    renderStrict(<AiV2Panel sessionId="sess-1" persistence={port} />);

    expect(await screen.findByTestId('aiv2-dashboard-grid')).toBeTruthy();
    expect(screen.queryByTestId('aiv2-dashboard-editor')).toBeNull();
    expect(screen.getByTestId('aiv2-dashboard-edit')).toBeTruthy();
  });
});

describe('AiV2Panel — a dashboard is modified end-to-end with NO agent turn', () => {
  it('add + retitle + remove on a blank dashboard call save() but never fetch()', async () => {
    const fetchSpy = vi.mocked(fetch);
    const port = fakePort(null);
    renderStrict(<AiV2Panel sessionId="sess-1" persistence={port} />);

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

    // Gate assertion: none of add/retitle/reposition/resize/remove ever
    // touched `fetch` — the ONLY call sites for the design-turn endpoints
    // (/ai/v2/design, /ai/v2/answer) both live in AiV2Design.tsx, mounted
    // alongside this canvas the entire time.
    expect(fetchSpy).not.toHaveBeenCalled();
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
    renderStrict(<AiV2Panel sessionId="sess-1" persistence={port} />);

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
    renderStrict(<AiV2Panel sessionId="sess-1" persistence={port} />);

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
    renderStrict(<AiV2Panel sessionId="sess-1" persistence={port} />);

    fireEvent.click(await screen.findByTestId('aiv2-dashboard-edit'));
    fireEvent.click(screen.getByTestId('aiv2-editor-add-widget'));
    fireEvent.click(screen.getByTestId('aiv2-picker-item-session_duration'));
    await screen.findByTestId('aiv2-dashboard-error');

    shouldFail = false;
    fireEvent.click(screen.getByTestId('aiv2-editor-remove'));
    await waitFor(() => expect(screen.queryByTestId('aiv2-dashboard-error')).toBeNull());
  });
});
