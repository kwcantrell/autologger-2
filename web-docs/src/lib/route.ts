// Hash-based client routing (task 7.1-7.3; design.md D1/spec "Mermaid runs
// strict; navigation and text are injection-safe" — node navigation is
// implemented by post-render DOM handlers over the rendered SVG, never
// mermaid `click` directives). This is a deliberately tiny router (design.md
// D1 orchestrator directive: "keep dependencies at zero new packages... hash
// routing suffices for ~30 routes") — no react-router, just hash parsing +
// a `hashchange` listener.
//
// Route shapes mirror the atlas's own vocabulary: `component`/`capability`
// routes carry the exact names the atlas uses as map keys (component names,
// capability names), `er`/`diagram` are the two other L2 view families, and
// `about`/`l0` are the two top-level pages. `componentRoute`/`routeForComponent`
// in model/navigation.ts already fixes the `/component/<name>` shape for L0/L1
// navigation ids — `componentHashFor` below reuses that exact string (with a
// leading `#`) rather than re-deriving it, so a click on an L0 node and a
// direct link on this page always agree on the same route.

export type Route =
  | { kind: 'l0' }
  | { kind: 'about' }
  | { kind: 'component'; name: string }
  | { kind: 'capability'; name: string }
  | { kind: 'er'; schema: 'catalog' | 'session' }
  | { kind: 'diagram'; path: string }
  | { kind: 'not-found'; hash: string };

/**
 * Parses a `window.location.hash` value (with or without the leading `#`)
 * into a typed `Route`. Never throws — an unrecognized shape becomes
 * `{ kind: 'not-found' }` rather than a crash, since `hash` is
 * attacker/typo-reachable (a user can type anything after the `#`).
 */
export function parseHash(hash: string): Route {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const segments = withoutHash.split('/').filter((segment) => segment.length > 0);

  if (segments.length === 0) return { kind: 'l0' };

  const [head, next] = segments;
  if (head === 'about' && segments.length === 1) return { kind: 'about' };
  if (head === 'component' && next) return { kind: 'component', name: decodeURIComponent(next) };
  if (head === 'capability' && next) return { kind: 'capability', name: decodeURIComponent(next) };
  if (head === 'er' && (next === 'catalog' || next === 'session')) {
    return { kind: 'er', schema: next };
  }
  if (head === 'diagram' && next) return { kind: 'diagram', path: decodeURIComponent(next) };
  return { kind: 'not-found', hash: withoutHash };
}

export const L0_HASH = '#/';
export const ABOUT_HASH = '#/about';

export function componentHash(componentName: string): string {
  return `#/component/${encodeURIComponent(componentName)}`;
}

export function capabilityHash(capabilityName: string): string {
  return `#/capability/${encodeURIComponent(capabilityName)}`;
}

export function erHash(schema: 'catalog' | 'session'): string {
  return `#/er/${schema}`;
}

export function diagramHash(path: string): string {
  return `#/diagram/${encodeURIComponent(path)}`;
}
