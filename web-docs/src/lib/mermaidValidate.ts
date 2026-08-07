// DOM-shimmed mermaid parser (task 6.3; design.md D1/D9; spec "Diagram
// validity gates use a DOM-bootstrapped parser and size budgets" —
// "Build-time mermaid validation SHALL run with a DOM shim (jsdom or
// equivalent) bootstrapped before mermaid loads — never a dependency that
// downloads a browser at install (puppeteer / `@mermaid-js/mermaid-cli` are
// prohibited)").
//
// Why the DOM must be bootstrapped BEFORE mermaid's module body runs:
// measured empirically (mermaid 11.16.1, Node 26, no globals set) — a
// diagram source with NO labelled node (e.g. `flowchart TD\n a --> b`)
// parses fine, but the moment a diagram needs FlowDB.sanitizeText (i.e. any
// node/edge carries a text label, which every real generated/authored
// diagram in this repo does), it throws:
//   TypeError: DOMPurify.addHook is not a function
// mermaid's own module-load code wires DOMPurify against `window`/
// `document` once, at import time — a `window`/`document` that doesn't
// exist yet when mermaid's ESM module body runs never gets wired, and no
// later assignment fixes it. So the bootstrap below sets the globals
// SYNCHRONOUSLY, then dynamically `import()`s mermaid — dynamic import's
// module evaluation is deferred to a microtask, which runs after the
// synchronous globals assignment completes, giving mermaid a real
// `window`/`document` the first time its module body executes. A static
// top-level `import mermaid from 'mermaid'` would NOT work here: ESM
// imports are hoisted and evaluated before any of this module's own
// top-level code runs, i.e. before the bootstrap has a chance to set the
// globals — this is the one piece of ordering this module exists to get
// right.
//
// jsdom, never a browser-downloading dependency (puppeteer /
// `@mermaid-js/mermaid-cli` are prohibited by name in the spec): jsdom is
// a devDependency already (task 1.1), pure JS, no binary download.
import { JSDOM } from 'jsdom';
import { MERMAID_CLIENT_CONFIG } from '../../model/mermaidConfig';

export type MermaidParseResult = { valid: true } | { valid: false; error: string };

let bootstrapped = false;

/**
 * Idempotent: sets `window`/`document`/`navigator` on `globalThis` from a
 * throwaway jsdom document, once per process. Node 22+ already defines a
 * read-only `globalThis.navigator` getter (its own Web-standard-adjacent
 * `navigator.userAgent`), so `navigator` must be reassigned via
 * `Object.defineProperty` — a plain `globalThis.navigator = ...` throws
 * ("Cannot set property navigator ... which has only a getter") — measured.
 */
function bootstrapDom(): void {
  if (bootstrapped) return;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });
  (globalThis as unknown as { window: typeof dom.window }).window = dom.window;
  (globalThis as unknown as { document: typeof dom.window.document }).document =
    dom.window.document;
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
  });
  bootstrapped = true;
}

// biome-ignore lint/suspicious/noExplicitAny: mermaid's own default export type, imported dynamically below to preserve bootstrap ordering — see module header.
let mermaidModulePromise: Promise<any> | undefined;

/**
 * Bootstraps the DOM (idempotent) and dynamically imports + initializes
 * mermaid (memoized — subsequent calls reuse the same module instance and
 * skip re-initializing). `MERMAID_CLIENT_CONFIG` (model/mermaidConfig.ts) is
 * the SAME object embedded verbatim into `atlas.json` for the client to
 * initialize with (spec: "The client SHALL initialize mermaid with the same
 * configuration object ... that validation used").
 */
// biome-ignore lint/suspicious/noExplicitAny: see mermaidModulePromise.
function loadMermaid(): Promise<any> {
  if (!mermaidModulePromise) {
    bootstrapDom();
    mermaidModulePromise = import('mermaid').then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize(MERMAID_CLIENT_CONFIG);
      return mermaid;
    });
  }
  return mermaidModulePromise;
}

/**
 * Parses `source` with the real mermaid parser under the DOM shim.
 * `suppressErrors: false` is deliberate — a thrown parse error becomes this
 * function's `{ valid: false, error }` return, never an uncaught exception
 * that would crash the whole gate battery on one bad diagram (spec
 * "Broken or empty authored diagram fails" / "Oversized diagram fails" —
 * every violation should be collectible into the gate's issue list, not a
 * process crash).
 *
 * Only parses — never renders. Full in-browser render smoke is out of v1
 * (design.md D9 residual risk): mermaid's `render()` needs `CSSStyleSheet`,
 * which jsdom does not implement (measured) — `parse()` alone doesn't need
 * it, which is exactly why this module validates parse validity, not
 * render output.
 */
export async function parseMermaidSource(source: string): Promise<MermaidParseResult> {
  const mermaid = await loadMermaid();
  try {
    await mermaid.parse(source, { suppressErrors: false });
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}
