// Deterministic navigation ids for L0/L1 diagram nodes (design.md D1/D9;
// spec "Mermaid runs strict; navigation and text are injection-safe" — node
// navigation is implemented by post-render DOM handlers mapping node ids to
// routes, never mermaid `click` directives, which would force
// `securityLevel: 'loose'`). This is the ONE place a component name is
// turned into a mermaid node id; every generator (generateL0.ts,
// generateL1.ts) and the id<->route mapping consumed by the SPA (phase 7)
// and 6.3's dangling-navigation-id check import `slugifyComponentId` from
// here rather than re-deriving a slug independently — a second slugifier
// could silently drift and produce a dangling id the gate can't see.

/**
 * Mermaid flowchart/state-diagram node ids must be simple identifiers (no
 * quoting available for ids the way there is for labels), so this reduces
 * an arbitrary component name to `[a-z][a-z0-9_]*` — lowercased, every
 * run of non-alphanumeric characters collapsed to a single underscore,
 * leading/trailing underscores trimmed, and (defensively) prefixed with
 * `c_` if the result would otherwise start with a digit or be empty. Pure
 * and deterministic: the same name always produces the same id.
 */
export function slugifyComponentId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safe = slug.length > 0 ? slug : 'component';
  return /^[a-z]/.test(safe) ? safe : `c_${safe}`;
}

/** The L1 component-page route a navigation id resolves to (phase 7 SPA route; consumed by 6.3's dangling-id check). */
export function routeForComponent(componentName: string): string {
  return `/component/${componentName}`;
}

export interface NavIdEntry {
  id: string;
  componentName: string;
  route: string;
}

/**
 * One entry per given component name, sorted by id — the id<->route
 * mapping emitted alongside every generated diagram source (spec: "emit the
 * id↔route mapping alongside sources").
 */
export function buildNavIndex(componentNames: string[]): NavIdEntry[] {
  return [...componentNames]
    .map((componentName) => ({
      id: slugifyComponentId(componentName),
      componentName,
      route: routeForComponent(componentName),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
