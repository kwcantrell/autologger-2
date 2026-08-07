// The shared mermaid client configuration object (design.md D1/D9; spec
// "Diagram validity gates use a DOM-bootstrapped parser and size budgets" —
// "The client SHALL initialize mermaid with the same configuration object
// carried in `atlas.json` that validation used"). ONE literal object,
// exported from here and nowhere else: `src/lib/mermaidValidate.ts` (task
// 6.3's build-time parser) initializes mermaid with it before every
// `parse()` call, `model/atlas.ts` embeds it verbatim into `atlas.json`, and
// the phase-7 SPA reads it back out of the atlas to initialize its own
// client-side mermaid instance — so validation and rendering can never drift
// out of sync on `securityLevel`/`htmlLabels`.
//
// `securityLevel: 'strict'` + `htmlLabels: false` together are the actual
// XSS mitigation (design.md D1): navigation is implemented by post-render
// DOM handlers keyed off node ids, never mermaid `click` directives (which
// would force `securityLevel: 'loose'` and open disk-derived strings — spec
// headings, change names — up to HTML injection reaching the anonymous
// loopback API). This object is the one place that guarantee is asserted;
// nothing else may construct a competing mermaid config.

export interface MermaidClientConfig {
  startOnLoad: boolean;
  securityLevel: 'strict';
  htmlLabels: boolean;
}

export const MERMAID_CLIENT_CONFIG: MermaidClientConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
};
