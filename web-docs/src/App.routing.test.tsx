// @vitest-environment jsdom
//
// Routing smoke test (task 7.3; spec "Three-level drill-down site" / gated
// scope trim: "one routing smoke... with the mermaid module stubbed
// (mermaid `render()` cannot run under jsdom)" — design.md D9 measured this
// directly: mermaid's real `render()` needs `CSSStyleSheet`, which jsdom
// does not implement). Heavy logic (extraction, generation, gates) is
// already exercised by the extraction-layer tests throughout `model/`/
// `src/lib/`; this file only proves the SPA's plumbing — atlas → route →
// page → (mocked) mermaid DOM → navigation — actually connects end to end,
// plus the label text the spec mandates ("authored", "mechanical",
// "pending").
//
// The mermaid mock is deliberately GENERIC rather than hand-wired to one
// fixture: it regex-scans whatever mermaid source text it's given for lines
// shaped like `  <id>[...` (exactly what generateL0.ts/generateL1.ts emit
// for a node) and fabricates one `<g class="node" id="flowchart-<id>-N">`
// per match — mirroring mermaid's own real DOM id scheme
// (`MERMAID_DOM_ID_PREFIX + id + '-' + counter`, verified by reading
// mermaid 11.16.1's flowchart renderer; see MermaidDiagram.tsx's header).
// That means the same mock exercises the real post-render navigation-wiring
// code path (MermaidDiagram's `wireNavigation`) rather than a hand-wired
// test double for it, and the fixture atlas below is built via the real,
// already-tested `buildAtlas`/`buildOverlay` (never a hand-rolled `Atlas`
// object), so this test can't drift out of sync with the real atlas shape.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Not using React Testing Library (not a dependency here — see this file's
// header, zero new packages) means nothing else sets this global for React
// 18/19's `act` to recognize the environment as test-like; without it,
// `act()` warns "not configured to support act(...)" and DOES NOT flush
// effects synchronously, which silently breaks every assertion below that
// depends on MermaidDiagram's effect having run.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { buildAtlas } from '../model/atlas';
import type { ComponentModel } from '../model/components';
import type { EdgeSnapshot } from '../model/edges';
import { buildOverlay } from '../model/overlay';
import { App } from './App';
import { AtlasContext } from './lib/AtlasProvider';

vi.mock('mermaid', () => {
  const NODE_LINE = /^\s*([a-z][a-z0-9_]*)\[/gm;
  return {
    default: {
      initialize: vi.fn(),
      render: vi.fn(async (id: string, source: string) => {
        NODE_LINE.lastIndex = 0;
        let match: RegExpExecArray | null;
        let counter = 0;
        const nodes: string[] = [];
        // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom.
        while ((match = NODE_LINE.exec(source))) {
          // Real mermaid prefixes the WHOLE node id with the `id` argument
          // passed to `render()` (e.g. `mermaid-l0-xyz-flowchart-aiv2-0`,
          // confirmed against the real library in a real browser) — this
          // mock reproduces that prefix so MermaidDiagram's id-matching
          // regex is exercised against a realistic shape, not a simplified
          // one that would hide a start-anchored regex bug.
          nodes.push(`<g class="node" id="${id}-flowchart-${match[1]}-${counter++}"></g>`);
        }
        return { svg: `<svg>${nodes.join('')}</svg>`, bindFunctions: undefined };
      }),
    },
  };
});

const model: ComponentModel = {
  components: [
    {
      name: 'web-app',
      kind: 'runtime',
      description: 'The web app.',
      globs: ['web/src/pages/index/**'],
      capabilities: ['demo-capability'],
      authoredDiagrams: [],
    },
    {
      name: 'session',
      kind: 'runtime',
      description: 'Session spine.',
      globs: ['server/src/session/**'],
      capabilities: [],
      authoredDiagrams: ['web-docs/diagrams/demo.mmd'],
    },
    {
      name: 'server-test-harness',
      kind: 'test-harness',
      description: 'Shared test infra.',
      globs: ['server/src/test/**'],
      capabilities: [],
      authoredDiagrams: [],
    },
  ],
  relationships: [],
  capabilityScopes: [{ type: 'component', capability: 'demo-capability', components: ['web-app'] }],
  exclusions: [
    { file: 'web-docs/vite.config.ts', reason: 'Vite build tool config, not application code.' },
  ],
};

const snapshot: EdgeSnapshot = [{ from: 'web-app', to: 'session', kind: 'production' }];

const overlay = buildOverlay({
  model,
  changeDirectoriesOnDisk: ['demo-change'],
  activeChangeNames: ['demo-change'],
  baselineCapabilities: ['demo-capability'],
  deltaCapabilitiesFor: () => ['demo-capability', 'brand-new-capability'],
});

const atlas = buildAtlas({
  model,
  snapshot,
  overlay,
  mappedFiles: [
    'web/src/pages/index/App.tsx',
    'server/src/session/SessionHub.ts',
    'server/src/test/fakeCore.ts',
  ],
  imports: [],
  dynamicWarnings: [],
  catalogErDiagram: 'erDiagram\n  USERS {\n    text id PK\n  }',
  sessionErDiagram: 'erDiagram\n  EVENTS {\n    text id PK\n  }',
  authoredDiagramSources: {
    'web-docs/diagrams/demo.mmd': 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Active: start',
  },
  specTrees: [
    {
      capability: 'demo-capability',
      requirements: [
        {
          name: 'Demo requirement',
          body: 'The system SHALL demo.',
          scenarios: [{ name: 'Demo scenario', body: '- **WHEN** x\n- **THEN** y' }],
        },
      ],
    },
  ],
  baselineCapabilities: ['demo-capability'],
  pendingCapabilities: ['brand-new-capability'],
});

/** Flushes the microtask queue enough times for MermaidDiagram's `mermaid.render(...).then(...)` chain (two `await`s deep) to settle inside `act`. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SPA routing smoke test', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    window.location.hash = '';
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    window.location.hash = '';
  });

  it('navigates L0 → component (via a mocked mermaid node click) → capability, and shows authored/mechanical/pending labels', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <AtlasContext.Provider value={{ status: 'ready', atlas }}>
          <App />
        </AtlasContext.Provider>,
      );
    });
    await flush();

    // L0: pending capability visible in the changes sidebar (spec: "pending
    // (new) capabilities render per the pending-grace requirement").
    expect(container.textContent).toContain('brand-new-capability');
    expect(container.textContent).toContain('pending');

    // Click the mocked mermaid node for "web-app" — proves post-render DOM
    // navigation (MermaidDiagram's wireNavigation over the atlas nav map),
    // not a plain <a> click.
    const node = container.querySelector('[id*="flowchart-web_app-"]');
    expect(node).not.toBeNull();
    await act(async () => {
      node?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();

    expect(window.location.hash).toBe('#/component/web-app');
    expect(container.textContent).toContain('web-app');
    expect(container.textContent).toContain('demo-capability');
    expect(container.textContent).toContain('1 requirement');

    // Component → capability browser: a plain <a> hop, asserting
    // requirement/scenario markdown renders as text (never HTML).
    await act(async () => {
      window.location.hash = '#/capability/demo-capability';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();

    expect(container.textContent).toContain('Demo requirement');
    expect(container.textContent).toContain('Demo scenario');
    expect(container.textContent).toContain('The system SHALL demo.');

    // Authored diagram — "authored" label, distinct from mechanical.
    await act(async () => {
      window.location.hash = '#/diagram/web-docs%2Fdiagrams%2Fdemo.mmd';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
    expect(container.textContent).toContain('authored');

    // ER page — "mechanical" label + the sparsity note.
    await act(async () => {
      window.location.hash = '#/er/catalog';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
    expect(container.textContent).toContain('mechanical');
    expect(container.textContent).toContain('Sparse by design');
  });
});
