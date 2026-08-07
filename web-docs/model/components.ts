// The component model (design.md D3; spec "Component model maps every
// tracked source file to exactly one component"). This file is the single
// source of truth the coverage gate (model/coverage.ts), and later phases'
// edge/relationship/capability/diagram gates, all read from.
//
// Schema note (phase-2 scope): `Relationship`, `CapabilityScope`, and each
// component's `capabilities`/`authoredDiagrams` fields are carried here now
// so later phases (4.x capability accounting, 4.x relationship evidence,
// 6.x diagram attachment) extend this file rather than widen its shape.
// Their *gates* land in those later phases — phase 2 only builds and
// verifies the coverage gate (orphan/overlap/exclusion/bare-root-glob).

export type ComponentKind = 'runtime' | 'datastore' | 'external' | 'tooling' | 'test-harness';

export interface Component {
  /** Unique, kebab-case identifier. */
  name: string;
  kind: ComponentKind;
  description: string;
  /**
   * Glob patterns (see src/lib/repo.ts matchesGlob) that select this
   * component's tracked source files. Empty for `datastore`/`external`
   * components — they represent real-world systems, not TS modules, and
   * coverage only demands globs partition the tracked tree across the
   * glob-bearing components.
   */
  globs: string[];
  /** OpenSpec capability names attached to this component (phase 4). */
  capabilities: string[];
  /** Paths to authored `web-docs/diagrams/*.mmd` files attached (phase 6). */
  authoredDiagrams: string[];
}

export interface RelationshipEvidence {
  /** Repo-relative path to the file the evidence rule inspects. */
  file: string;
  /** Substrings/patterns that must all appear in `file` for the relationship to hold. */
  mustContain: string[];
}

/** A declared non-import relationship between two components (design.md D3/D4). */
export interface Relationship {
  id: string;
  from: string;
  to: string;
  label: string;
  evidence: RelationshipEvidence;
  /** Name of the config gate that must be set for this relationship to activate (external nodes). */
  gated?: string;
}

export type CapabilityScope =
  | { type: 'component'; capability: string; components: string[] }
  | { type: 'cross-cutting'; capability: string; components: string[] }
  | { type: 'process'; capability: string };

/** A tracked `.ts`/`.tsx` file that is genuinely tooling-config, not application code. */
export interface Exclusion {
  file: string;
  reason: string;
}

export interface ComponentModel {
  components: Component[];
  relationships: Relationship[];
  capabilityScopes: CapabilityScope[];
  exclusions: Exclusion[];
}

// ---------------------------------------------------------------------------
// The real model (task 2.2). Coverage is verified against the live tree by
// `npm run docs:check` (scripts/check.ts). `capabilities`, `authoredDiagrams`,
// and `relationships`/`capabilityScopes` are intentionally left empty here —
// they are populated by phase 4 (capability accounting, relationship
// evidence) and phase 6 (authored-diagram attachment); the coverage gate
// does not depend on them.
// ---------------------------------------------------------------------------

function runtimeComponent(name: string, description: string, globs: string[]): Component {
  return { name, kind: 'runtime', description, globs, capabilities: [], authoredDiagrams: [] };
}

function testHarnessComponent(name: string, description: string, globs: string[]): Component {
  return {
    name,
    kind: 'test-harness',
    description,
    globs,
    capabilities: [],
    authoredDiagrams: [],
  };
}

function toolingComponent(name: string, description: string, globs: string[]): Component {
  return { name, kind: 'tooling', description, globs, capabilities: [], authoredDiagrams: [] };
}

function datastoreComponent(name: string, description: string): Component {
  return {
    name,
    kind: 'datastore',
    description,
    globs: [],
    capabilities: [],
    authoredDiagrams: [],
  };
}

function externalComponent(name: string, description: string): Component {
  return {
    name,
    kind: 'external',
    description,
    globs: [],
    capabilities: [],
    authoredDiagrams: [],
  };
}

const serverComponents: Component[] = [
  runtimeComponent(
    'server-bootstrap',
    'Composition root: Hono app wiring (middleware chain, router mounts, static serving) ' +
      'and the Node process entry (env → bindings → app → listen).',
    ['server/src/app.ts', 'server/src/main.ts'],
  ),
  runtimeComponent(
    'server-core',
    'Cross-cutting server domain/config/time utilities shared by routers and the session ' +
      'spine: typed env accessors, the Clock port (core-ports-architecture), Zod request ' +
      'schemas, studio domain logic (profiles/categories/palette), SMPTE timecode math, ' +
      'and the composition-root Ports/Config/Variables type generics.',
    [
      'server/src/env.ts',
      'server/src/env.test.ts',
      'server/src/clock.ts',
      'server/src/schemas.ts',
      'server/src/schemas.test.ts',
      'server/src/studio.ts',
      'server/src/studio.test.ts',
      'server/src/timecode.ts',
      'server/src/timecode.test.ts',
      'server/src/types.ts',
    ],
  ),
  runtimeComponent(
    'routers',
    'The Hono route handlers: every HTTP/WS endpoint in the frozen api-contract-freeze ' +
      'surface (sessions, events, audio, transcribe, ai/aiV2, admin, auth, teams, shows, ' +
      'exports, companion, logImport, flows, static serving).',
    ['server/src/routers/**'],
  ),
  runtimeComponent(
    'session',
    'The in-process SessionHub live spine: events, transport, audio metadata, the ' +
      'recording lease, transcript words, topics, WebSocket fan-out, and the ' +
      'SessionHubRegistry idle-close/reopen lifecycle.',
    ['server/src/session/**'],
  ),
  runtimeComponent(
    'catalog-db',
    'The catalog SQLite access layer: users/studios/shows/prefs, login sessions, OAuth ' +
      'CSRF, Companion presence, and the sessions index, plus the sessions-index and ' +
      'active-changes readers.',
    ['server/src/db/**'],
  ),
  runtimeComponent(
    'node-infra',
    'Node-specific infrastructure: config wiring/composition root, the blob store, ' +
      'kv-on-sqlite, presence, the migrator, DeepGram transcript generation + its ' +
      'process-global lock, YouTube audio import (yt-dlp) + its guard/scratch handling, ' +
      'and audio-segment merge.',
    ['server/src/node/**'],
  ),
  runtimeComponent(
    'auth',
    'Google ID-token identity verification (JWKS-backed) and the OAuth login flow.',
    ['server/src/auth/**'],
  ),
  runtimeComponent(
    'aiV2',
    'AI dashboards v2 domain: catalog of widget/dashboard types, aggregate computation, ' +
      'and MCP tool definitions consumed by the AI chat CLI/MCP machinery.',
    ['server/src/aiV2/**'],
  ),
  runtimeComponent(
    'log-import',
    'Batch log-import domain logic: category matching, job store, Google Sheets fetch, ' +
      'sheet timecode parsing, sync scoring, and running an import against a session.',
    ['server/src/logImport/**'],
  ),
  runtimeComponent('middleware', 'Hono middleware: auth context and IP allowlisting.', [
    'server/src/middleware/**',
  ]),
  testHarnessComponent(
    'server-test-harness',
    'Shared server test infrastructure: fake clock/core, the HTTP test harness, OAuth ' +
      'test doubles, integration-test setup, and captured-fixture assertion helpers.',
    ['server/src/test/**'],
  ),
];

const webComponents: Component[] = [
  runtimeComponent(
    'web-api',
    'The web SPA’s server API client and React Query hooks: the fetch/WebSocket client ' +
      'module and every generated hook (sessions, events, audio, transport, topics, ' +
      'transcript words/generation status, companion presence, teams, profile) plus the ' +
      'response-type module.',
    ['web/src/api/**'],
  ),
  runtimeComponent(
    'web-app',
    'The main session-workspace SPA page: transport/timeline/feed components, the AI ' +
      'chat and AI v2 dashboard panels, batch import, and the page-local hooks/utils that ' +
      'back them.',
    ['web/src/pages/index/**'],
  ),
  runtimeComponent('web-admin', 'The standalone admin-users SPA page and its entry point.', [
    'web/src/pages/admin-users/**',
  ]),
  runtimeComponent(
    'web-shared',
    'Design-system primitives and cross-page utilities shared across web SPA pages: UI ' +
      'primitives (Dialog/Popover/Tooltip/RadioGroup/ConfirmDialog), theme, and shared ' +
      'utils (audio clips, timecode, waveform, login-return handling).',
    ['web/src/shared/**'],
  ),
  runtimeComponent(
    'web-types',
    'Ambient TypeScript declarations for non-TS asset imports (images/fonts) and CSS ' + 'modules.',
    ['web/src/types/**'],
  ),
  testHarnessComponent(
    'web-test-harness',
    'Shared web test infrastructure (strict-mode render helpers, React Query test ' +
      'wrapper, jsdom setup) plus repo-wide policy tests that assert properties of the ' +
      'whole web tree rather than one module (no agent-authored markup, query-key ' +
      'factory usage, API response-shape conformance).',
    [
      'web/src/test/**',
      'web/src/noAgentAuthoredMarkup.repo.test.ts',
      'web/src/queryKeyFactories.repo.test.ts',
      'web/src/apiResponseShapes.repo.test.ts',
    ],
  ),
];

const companionComponents: Component[] = [
  runtimeComponent(
    'companion-core',
    'Companion module bootstrap, config fields, persisted instance state, and version ' +
      'upgrade scripts. companion/src/ is flat (no subdirectories), so this and the two ' +
      'components below split it by responsibility rather than by directory.',
    [
      'companion/src/main.ts',
      'companion/src/config.ts',
      'companion/src/config.test.ts',
      'companion/src/state.ts',
      'companion/src/state.test.ts',
      'companion/src/upgrades.ts',
      'companion/src/variables.ts',
    ],
  ),
  runtimeComponent(
    'companion-actions',
    'The Companion module’s user-facing surface: button actions, feedbacks, and presets.',
    [
      'companion/src/actions.ts',
      'companion/src/actions.test.ts',
      'companion/src/feedbacks.ts',
      'companion/src/presets.ts',
      'companion/src/presets.test.ts',
    ],
  ),
  runtimeComponent(
    'companion-api',
    'HTTP communication with the AutoLogger server: the API client and the status ' + 'poller.',
    [
      'companion/src/api.ts',
      'companion/src/api.test.ts',
      'companion/src/poller.ts',
      'companion/src/poller.test.ts',
    ],
  ),
];

const otherComponents: Component[] = [
  testHarnessComponent(
    'contract-fixtures',
    'The contract-fixture corpus both server (captured-response assertions) and web ' +
      '(client-type conformance) assert against — one of the most load-bearing shared ' +
      'nodes in the repo, previously invisible outside test suites.',
    ['fixtures/api-responses/**'],
  ),
  testHarnessComponent(
    'e2e',
    'Playwright end-to-end smoke tests spanning server, web, and companion (not an npm ' +
      'workspace — CLAUDE.md).',
    ['e2e/**'],
  ),
  toolingComponent(
    'web-docs',
    'This documentation workspace itself: the extraction pipeline, drift gates, the ' +
      'component model, and the static site that renders them. Self-referential — the ' +
      'coverage gate covers its own source too.',
    ['web-docs/src/**', 'web-docs/scripts/**', 'web-docs/model/**'],
  ),
];

const datastoreComponents: Component[] = [
  datastoreComponent(
    'catalog-database',
    'The catalog SQLite database file (DATA_DIR/catalog.db): users/studios/shows/prefs, ' +
      'login sessions, OAuth CSRF, Companion presence, and the sessions index.',
  ),
  datastoreComponent(
    'session-databases',
    'One SQLite database file per session (DATA_DIR/sessions/<id>.db): events, ' +
      'transport, audio metadata, the recording lease, transcript words, and topics.',
  ),
  datastoreComponent(
    'blob-store',
    'Filesystem blob storage for recorded audio bytes (DATA_DIR/blobs/audio/…).',
  ),
];

const externalComponents: Component[] = [
  externalComponent(
    'deepgram',
    'Cloud speech-to-text API. Config-gated: transcript-words/generate is 503 unless ' +
      'DEEPGRAM_API_KEY is set.',
  ),
  externalComponent(
    'claude-cli',
    'The Claude CLI/MCP machinery backing AI chat, topics/generate, and events/generate. ' +
      'Config-gated: 503 unless CLAUDE_CLI_PATH is set.',
  ),
  externalComponent(
    'yt-dlp',
    'Operator-provided yt-dlp binary used to download YouTube video audio. Config-gated: ' +
      'youtube-import is 503 unless a yt-dlp binary is configured or resolvable on PATH.',
  ),
  externalComponent(
    'google-jwks',
    'Google’s JWKS endpoint, fetched via global fetch + jose’s createLocalJWKSet (10-' +
      'minute cache) to verify Google ID tokens.',
  ),
];

const exclusions: Exclusion[] = [
  { file: 'web/vite.config.ts', reason: 'Vite build tool config, not application code.' },
  { file: 'web/vitest.config.ts', reason: 'Vitest tool config, not application code.' },
  { file: 'server/vitest.config.ts', reason: 'Vitest tool config, not application code.' },
  {
    file: 'companion/vitest.config.ts',
    reason: 'Vitest tool config, not application code.',
  },
  {
    file: 'web-docs/vite.config.ts',
    reason: 'Vite build tool config, not application code.',
  },
  {
    file: 'web-docs/vitest.config.ts',
    reason: 'Vitest tool config, not application code.',
  },
  {
    file: 'playwright.config.ts',
    reason: 'Root Playwright e2e harness tool config, not application code.',
  },
  {
    file: 'server/scripts/merge-session-audio.ts',
    reason: 'Operator-run maintenance script, not part of the runtime app or its test suite.',
  },
];

export const model: ComponentModel = {
  components: [
    ...serverComponents,
    ...webComponents,
    ...companionComponents,
    ...otherComponents,
    ...datastoreComponents,
    ...externalComponents,
  ],
  relationships: [],
  capabilityScopes: [],
  exclusions,
};
