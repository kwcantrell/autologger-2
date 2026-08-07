// Client-side mermaid rendering + post-render DOM navigation (design.md
// D1/D9; spec "Mermaid runs strict; navigation and text are injection-safe").
//
// SEAM: the ONE `mermaid.initialize()` call in the whole SPA lives here
// (`ensureMermaidInitialized`, called with exactly the `config` prop the
// caller passes — every page threads through `atlas.mermaidConfig`, the same
// object `src/lib/mermaidValidate.ts` used to validate these sources at
// build time, per spec "The client SHALL initialize mermaid with the same
// configuration object carried in `atlas.json`"). No other module in this
// SPA may construct or call into a competing mermaid config.
//
// Navigation is wired by inspecting the rendered SVG's DOM after insertion —
// never a mermaid `click` directive (which would force `securityLevel:
// 'loose'`, D1's rejected XSS path). Mermaid gives each flowchart node
// element an `id` containing `flowchart-<nodeId>-<counter>`
// (mermaid's own `MERMAID_DOM_ID_PREFIX` + the node id used in the diagram
// source + a per-render vertex counter), but — confirmed against the real
// library in a real browser, not just the jsdom-mocked unit test — mermaid
// additionally prefixes the WHOLE id with the `id` argument passed to
// `mermaid.render()` (e.g. `mermaid-l0-xyz-flowchart-aiv2-0`), so the match
// below searches for `flowchart-...-<digits>` anywhere in the id rather
// than anchoring to the start of the string. `slugifyComponentId` (the ONE
// slugifier, model/navigation.ts) never emits a hyphen, so the text between
// `flowchart-` and the final `-<digits>` suffix unambiguously recovers the
// node id mermaid was given — no risk of a hyphen inside the id colliding
// with the counter separator.
//
// The mermaid-rendered SVG string is inserted via a plain DOM `innerHTML`
// assignment on a ref (mermaid's own documented integration pattern:
// `div.innerHTML = svg; bindFunctions?.(div);`) — deliberately NOT React's
// `dangerouslySetInnerHTML` prop. The distinction matters here: this
// component is the one place in the SPA that renders markup instead of
// text, and it only ever does so with mermaid's own output, generated (by
// generateL0.ts/generateL1.ts/erSchema.ts, or authored under
// `web-docs/diagrams/`) from strings that were themselves escaped for
// mermaid label syntax before interpolation — never raw disk-derived text
// reaching the DOM unescaped. Every other disk-derived string in this SPA
// (component descriptions, requirement/scenario bodies, file paths, change
// names) renders as a React text child, relying on React's default
// escaping, and never flows through this component.

import mermaid from 'mermaid';
import { useEffect, useId, useRef, useState } from 'react';
import type { MermaidClientConfig } from '../../model/mermaidConfig';
import type { NavIdEntry } from '../../model/navigation';

let initializedWith: MermaidClientConfig | undefined;

function ensureMermaidInitialized(config: MermaidClientConfig): void {
  if (initializedWith === config) return;
  mermaid.initialize(config);
  initializedWith = config;
}

const NODE_DOM_ID_PATTERN = /flowchart-(.+)-\d+$/;

function wireNavigation(
  root: HTMLElement,
  navIds: NavIdEntry[],
  navigate: (route: string) => void,
): void {
  const byNodeId = new Map(navIds.map((entry) => [entry.id, entry]));
  const nodes = root.querySelectorAll<SVGGElement>('g.node[id*="flowchart-"]');
  for (const node of Array.from(nodes)) {
    const match = node.id.match(NODE_DOM_ID_PATTERN);
    const navId = match ? byNodeId.get(match[1]) : undefined;
    if (!navId) continue;

    node.style.cursor = 'pointer';
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'link');
    node.setAttribute('aria-label', `Open ${navId.componentName}`);

    const go = () => navigate(navId.route);
    node.addEventListener('click', go);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        go();
      }
    });
  }
}

export interface MermaidDiagramProps {
  /** Must be unique among diagrams simultaneously mounted (mermaid uses it as the rendered `<svg>`'s own id). */
  id: string;
  source: string;
  /** Always `atlas.mermaidConfig` — see module header. */
  config: MermaidClientConfig;
  /** Present only for diagrams with navigable nodes (L0) — omitted elsewhere (L1/ER/authored diagrams have no post-render navigation). */
  navIds?: NavIdEntry[];
  /** Defaults to `location.hash = route`; overridable for tests. */
  onNavigate?: (route: string) => void;
}

export function MermaidDiagram({ id, source, config, navIds, onNavigate }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reactId = useId();
  const diagramId = `mermaid-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;

  useEffect(() => {
    ensureMermaidInitialized(config);
    let cancelled = false;
    setError(null);

    mermaid
      .render(diagramId, source)
      .then(({ svg, bindFunctions }) => {
        if (cancelled) return;
        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = svg;
        bindFunctions?.(container);
        if (navIds && navIds.length > 0) {
          wireNavigation(
            container,
            navIds,
            onNavigate ??
              ((route) => {
                window.location.hash = route;
              }),
          );
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [diagramId, source, config, navIds, onNavigate]);

  if (error) {
    return (
      <p role="alert" className="diagram-error">
        Diagram failed to render: {error}
      </p>
    );
  }
  return <div className="mermaid-diagram" ref={containerRef} />;
}
