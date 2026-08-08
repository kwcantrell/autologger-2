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
  /** Literal substrings that must all appear in `file` for this evidence rule to hold. */
  mustContain: string[];
}

/**
 * A declared non-import relationship between two components (design.md D3/D4).
 * `evidence` is a list — most relationships need one file, but a relationship
 * can span more than one real call site (e.g. web→server is both a `fetch`
 * client module and a separate WebSocket module); every entry must pass for
 * the relationship to hold, and a failing entry names both the relationship
 * and that entry's rule.
 */
export interface Relationship {
  id: string;
  from: string;
  to: string;
  label: string;
  evidence: RelationshipEvidence[];
  /** Name of the config gate that must be set for this relationship to activate (external nodes). */
  gated?: string;
}

export type CapabilityScope =
  | { type: 'component'; capability: string; components: string[] }
  | { type: 'cross-cutting'; capability: string; components: string[] }
  | { type: 'process'; capability: string };

/**
 * A tracked file the model deliberately does not map to a component: most
 * entries are `.ts`/`.tsx` tooling-config that is genuinely not application
 * code, but the mechanism is untyped by extension — `isMappedOrExcluded`
 * (model/coverage.ts) matches on `file` as a plain path, so a non-`.ts`
 * import *target* (e.g. a workspace `package.json` pulled in for its
 * `version` field) can also be excluded to resolve an otherwise-unmapped
 * import edge without widening any component's globs.
 */
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
      'and the Node process entry (env → bindings → app → listen). Also carries ' +
      '`httpError.ts` (router-directory-decomposition D3): the `ApiError` class, app-level ' +
      'plumbing mapped to a JSON response by the `onError` handler here and thrown by ' +
      'every router — root-level, not a `routers/` layer member.',
    ['server/src/app.ts', 'server/src/main.ts', 'server/src/httpError.ts'],
  ),
  runtimeComponent(
    'server-core',
    'Cross-cutting server config utilities shared by routers and the session spine: typed ' +
      'env accessors, and (package-split-foundation D3) `appEnv.ts` — the composition-root ' +
      'Ports/Config/Variables/AppEnv generics that replaced the retired `types.ts` ' +
      'god-barrel, the one app-level module allowed to name the concrete ' +
      '`SessionHubRegistry`/`Catalog` handle types.',
    ['server/src/env.ts', 'server/src/env.test.ts', 'server/src/appEnv.ts'],
  ),
  runtimeComponent(
    'routers',
    'The Hono route handlers: every HTTP/WS endpoint in the frozen api-contract-freeze ' +
      'surface (sessions, events, audio, transcribe, ai/aiV2, admin, auth, teams, shows, ' +
      'exports, companion, logImport, flows, static serving).',
    ['server/src/routers/**'],
  ),
  runtimeComponent(
    'ai-runtime',
    '`@autologger/ai-runtime` (ai-runtime-package D1): the AI runtime as an L2 service ' +
      'package — the MCP tool servers, the Claude-CLI and Agent-SDK subprocess runners and ' +
      'their process-group kill ladder, the turn orchestrator and relay, the shared ' +
      'per-session AI turn registry, the one-shot turn drivers backing topics/generate and ' +
      'events/generate, the generation prompt builder, and the session aggregate ' +
      'computations the design-turn toolset exposes (the former `server/src/aiV2/` pair, ' +
      'whose component this move deletes). Hono-free and injection-fed — takes the session ' +
      'registry and hub facades from `@autologger/session-core`, plus CLI path, budget, ' +
      'timeout, clock, and credential-source values, as plain parameters; imports no ' +
      '`hono`, no `appEnv`, and nothing under `server/src/` (enforced by the boundary repo ' +
      'test, whose walked root moved with the code). Admitted to the service layer because ' +
      'L2 is the only legal placement — five of its modules import ' +
      '`@autologger/session-core`, which forbids L0, and the L1-sibling rule forbids L1.',
    ['packages/ai-runtime/src/**'],
  ),
  runtimeComponent(
    'node-infra',
    'Node-specific infrastructure: only the composition root (config wiring), the system ' +
      'clock, and presence remain — matching CLAUDE.md’s documented role for this ' +
      'directory. DeepGram transcription + audio-segment merge left this component for ' +
      '`@autologger/transcription`, and YouTube audio import (yt-dlp) + its guard/scratch ' +
      'handling left for `@autologger/media-import`, in this change’s phases 4 and 3 ' +
      'respectively (feature-service-packages tasks 4.1/3.1) — the transcription and ' +
      'audio-import features that had accreted here, together outweighing the composition ' +
      'root by an order of magnitude, are both gone.',
    [
      'server/src/node/config.ts',
      'server/src/node/config.test.ts',
      'server/src/node/presence.ts',
      'server/src/node/presence.test.ts',
      'server/src/node/systemClock.ts',
    ],
  ),
  runtimeComponent(
    'auth',
    'Google ID-token identity verification (JWKS-backed) and the OAuth login flow.',
    ['server/src/auth/**'],
  ),
  // The `aiV2` component is DELETED, not emptied (ai-runtime-package task 3.6;
  // spec scenario "A component whose subject moves is deleted, not emptied").
  // Its two remaining modules — `aggregates.ts` and `mcpTools.ts` — moved into
  // `@autologger/ai-runtime` and are covered by that component's package glob
  // above. Clearing its globs instead would leave it rendering, nameable as a
  // capability scope and a relationship endpoint, and would additionally
  // DEFEAT `checkCapabilityAccounting`'s dangling-component check, which fires
  // only when a scope names a component that does not exist — the bypass this
  // change's gate ruling E1 demonstrated when it dropped the proposed
  // empty-component check.
  runtimeComponent('middleware', 'Hono middleware: auth context and IP allowlisting.', [
    'server/src/middleware/**',
  ]),
  testHarnessComponent(
    'server-test-harness',
    'Shared server test infrastructure: fake clock/core, the HTTP test harness, OAuth ' +
      'test doubles, integration-test setup, and captured-fixture assertion helpers, plus ' +
      'root-level repo-wide guard tests for the package split (package-split-foundation): ' +
      'the cross-package layering-boundary test and the cross-package 422/400 error-' +
      'identity pin, mirroring the web-test-harness convention for `*.repo.test.ts` files ' +
      'that assert a property of the whole tree rather than one module. Also carries the ' +
      'three catalog integration-test files (persistence-package-extraction task 3.4) ' +
      'relocated to `server/src/test/` alongside the migration integration scenarios ' +
      "(task 3.5) that pin the catalog package's migrations directory and content, plus " +
      '(task 4.4) the two session integration-test files (`SessionHub.int.test.ts`, ' +
      '`rowsWrittenReaders.int.test.ts`) relocated from the now-fully-retired ' +
      '`server/src/session/` — the directory glob below covers all of it.',
    [
      'server/src/test/**',
      'server/src/packageBoundaries.repo.test.ts',
      'server/src/crossPackageErrorIdentity.int.test.ts',
    ],
  ),
];

const packageComponents: Component[] = [
  runtimeComponent(
    'domain',
    '`@autologger/domain` (package-split-foundation D2): pure, dependency-free domain ' +
      'logic moved out of server/src — studio domain rules (profiles/categories/palette), ' +
      'SMPTE timecode math, and shared catalog/session-DB row types (formerly ' +
      '`server/src/studio.ts`, `timecode.ts`, `db/shared.ts`). Zero runtime dependencies.',
    ['packages/domain/src/**'],
  ),
  runtimeComponent(
    'contract',
    '`@autologger/contract` (package-split-foundation D2/D4): the wire-contract package — ' +
      'Zod request schemas validated at the Hono route boundary, and the AI v2 dashboard ' +
      'widget catalog/config validator (formerly `server/src/schemas.ts` and ' +
      '`server/src/aiV2/catalog.ts`). Gives dashboard-config validation a single ' +
      'structural home and structurally breaks the former session ⇄ aiV2 directory cycle; ' +
      '`zod` is a peerDependency so a second zod install can never break the app’s ' +
      '`instanceof ZodError` → 422 mapping.',
    ['packages/contract/src/**'],
  ),
  runtimeComponent(
    'ports',
    '`@autologger/ports` (package-split-foundation D2/D3): interface-only injectable port ' +
      'definitions (`Clock`, `BlobStore`, `KvStore`, `IdentityVerifier`, `CatalogDb`, ' +
      '`PresenceRegistry`) plus the `Config` type and the base `Ports` shape. No runtime ' +
      'implementations ship here — `systemClock` and the other concrete adapters live at ' +
      'the composition root (`server/src/node/**`); `server/src/appEnv.ts` composes the ' +
      'app-level `Ports`/`AppEnv` by extending this package’s base shape.',
    ['packages/ports/src/**'],
  ),
  runtimeComponent(
    'storage',
    '`@autologger/storage` (persistence-package-extraction task 2.2): the SQLite/' +
      'filesystem persistence adapters moved out of `server/src/node/` — `BlobStore` ' +
      '(filesystem audio blobs; exports `InvalidRangeError`, mapped to 416 by `instanceof` ' +
      'at server-bootstrap/routers), `KvStore` (the catalog `kv`-table adapter), `CatalogDb` ' +
      '(the synchronous better-sqlite3-backed `CatalogDb` port implementation), and the ' +
      'directory-generic migrator (`openCatalogDb`/`applyMigrations` — the catalog package ' +
      'owns the migrations `*.sql` files themselves; wired to them by ' +
      "`server/src/node/config.ts` via `@autologger/catalog`'s exported " +
      '`CATALOG_MIGRATIONS_DIR`, task 3.2/3.3). Depends only on `ports`; `better-sqlite3` ' +
      'is a peerDependency (design D5), never a second copy.',
    ['packages/storage/src/**'],
  ),
  runtimeComponent(
    'catalog',
    '`@autologger/catalog` (persistence-package-extraction task 3.2/3.3): the `Catalog` ' +
      'facade and its five domain stores — `studios`, `shows`, `auth`, `sessions` ' +
      '(session-index), `profile` — plus `sessionTitleDerivation`, moved out of ' +
      '`server/src/db/`, and the catalog schema migration `*.sql` files (design D7 — schema ' +
      'and stores evolve together; the directory-generic migrator that applies them stays ' +
      'in `@autologger/storage`). Exports `CATALOG_MIGRATIONS_DIR` (resolved via ' +
      '`import.meta.url`) and the `createCatalog(db)` factory — the sanctioned ' +
      "non-composition-root construction path for `middleware/auth.ts`'s per-request " +
      '`new Catalog(db)` + `init()` lifecycle. Depends on `domain` and `ports` only — no ' +
      '`better-sqlite3`: `Catalog` speaks the `CatalogDb` port, never the driver.',
    ['packages/catalog/src/**'],
  ),
  {
    ...runtimeComponent(
      'session-core',
      '`@autologger/session-core` (persistence-package-extraction task 4.3): the ' +
        'in-process SessionHub live spine, moved out of `server/src/session/` — events, ' +
        'transport, audio metadata, the recording lease, transcript words, topics, ' +
        'WebSocket fan-out, the SessionHubRegistry evict-and-reconstruct idle lifecycle, ' +
        'and the `SessionRuntime` port (the package-internal substitution seam, alongside ' +
        '`SessionCore`). Exports `DashboardValidationError`/`DashboardBoundsError` (mapped ' +
        'to 422 by `instanceof` at routers/aiV2.ts). Depends on `domain`, `contract`, and ' +
        '`ports`; `better-sqlite3` is a peerDependency (design D5), never a second copy — ' +
        'the same single-resolved-copy property `storage` relies on.',
      ['packages/session-core/src/**'],
    ),
    // Task 6.2 (design.md D7): two v1 authored state diagrams, derived from a
    // read of the current code, not prose — sorted for determinism. Relocated
    // here from the retired `session` server/src component at task 4.3 (the
    // diagrams describe SessionHub/LeaseStore behavior, which moved with it).
    authoredDiagrams: [
      'web-docs/diagrams/recording-lease.mmd',
      'web-docs/diagrams/session-hub-registry.mmd',
    ].sort(),
  },
  runtimeComponent(
    'log-import',
    '`@autologger/log-import` (feature-service-packages task 5.3): the L2 service-package ' +
      'home for Google Sheets batch log-import domain logic — `categoryMatch.ts` (fuzzy ' +
      'category-name matching), `jobStore.ts` (the in-memory job-status store, ' +
      'Clock-parameterized since task 5.2), `runSessionLogImport.ts` (sync scoring + event ' +
      'creation against one matched session), `sheetsFetch.ts` (public workbook fetch + row ' +
      'parse, via `exceljs`), `sheetTimecode.ts` (SMPTE timecode parsing for sheet rows), ' +
      '`syncScore.ts` (log-row-to-transcript-seam sync scoring) — moved verbatim out of ' +
      '`server/src/logImport/`, plus the package barrel (`index.ts`). The router-level ' +
      'coordinator (`ensureTimedTranscript`) stays in `routers/logImport.ts` (task 5.1 — a ' +
      'Hono-importing module can’t live in this package). Depends on `domain`, `ports`, and ' +
      '`session-core`; `exceljs` is declared here **and** by `server/package.json` (gate ' +
      'ruling E1 — `routers/logImport.int.test.ts` imports it directly and stays in the app).',
    ['packages/log-import/src/**'],
  ),
  runtimeComponent(
    'media-import',
    '`@autologger/media-import` (feature-service-packages task 3.1): the L2 service-package ' +
      'home for YouTube audio import — `ytdlp.ts` (the yt-dlp spawn + lockdown + bounds ' +
      'module), `youtubeImportGuard.ts` (per-session + global concurrency guard), ' +
      '`youtubeImportScratch.ts` (startup sweep of stale per-request temp dirs) — moved ' +
      'verbatim out of `server/src/node/`, plus the package barrel (`index.ts`, exporting ' +
      '`MEDIA_IMPORT_FIXTURES_DIR`) and its own fixtures (`fake-ytdlp.mjs`). Imports no ' +
      'workspace package at all (Node stdlib only), by role rather than by need — ' +
      '`resolveYtDlpPath` deliberately stays in `server/src/env.ts` (gate ruling E2).',
    ['packages/media-import/src/**'],
  ),
  runtimeComponent(
    'transcription',
    '`@autologger/transcription` (feature-service-packages task 4.1): the L2 service-package ' +
      'home for DeepGram transcription — `deepgram.ts` (the provider HTTP client), ' +
      '`audioMerge.ts` (mediabunny packet-copy concat of recorded audio segments), ' +
      '`transcriptRemap.ts` (timeline remap of words + enrichment onto the session’s SMPTE ' +
      'timeline), `transcriptGenerationLock.ts` (the process-wide generation lock), ' +
      '`generateTranscript.ts` (the orchestrating entry point both the HTTP generate route ' +
      'and sheets-log-import’s ensure-timed-transcript coordinator call), and ' +
      '`deepgramConfig.ts` (`deepgramConfigured`/`deepgramModel`, moved out of ' +
      '`server/src/env.ts` — design D5) — moved verbatim out of `server/src/node/`, plus the ' +
      'package barrel (`index.ts`, exporting `TRANSCRIPTION_FIXTURES_DIR`) and its own ' +
      'fixtures (`audio/`, `deepgram-enrichment-response.json`). Depends on `domain`, ' +
      '`ports`, and `session-core` (never `contract`, which no file here imports).',
    ['packages/transcription/src/**'],
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
      // cursorAdapters.repo.test.ts (cursor-agent-adapters) is the same shape
      // as the three repo-wide policy tests above — a root-level
      // `*.repo.test.ts` walking the whole repo tree from disk to assert a
      // property of the tree as a whole, not one module — and its own header
      // comment says it mirrors noAgentAuthoredMarkup.repo.test.ts's
      // vendor/generated-dir exclusion set for the same reason. It has no
      // application-code counterpart under web/src (it tests `.cursor/**`
      // adapter files, which live outside every mapped component), so it
      // belongs here on proximity-of-kind rather than proximity-of-subject.
      'web/src/cursorAdapters.repo.test.ts',
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
      'companion/src/variables.test.ts',
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
  {
    file: 'web/package.json',
    reason:
      'Workspace manifest, imported (as a named JSON import, web/src/shared/appVersion.ts) ' +
      'only for its `version` field to display the app version — not architecture. Not a ' +
      '.ts/.tsx file so it can never itself be a tracked/mapped component member; this entry ' +
      'exists purely to resolve the import edge rather than leave it unmapped.',
  },
];

// ---------------------------------------------------------------------------
// Declared non-import relationships (task 4.1; design.md D3/D4; spec
// "Declared non-import relationships carry mechanical evidence"). Every
// evidence file/pattern pair below was located by reading the real call
// site, not guessed from a filename — see task-4.1-4.2-report.md.
// ---------------------------------------------------------------------------

const relationships: Relationship[] = [
  {
    id: 'web-api-to-routers',
    from: 'web-api',
    to: 'routers',
    label: 'HTTP fetch + WebSocket calls to the server API',
    evidence: [
      { file: 'web/src/api/client.ts', mustContain: ['fetch('] },
      { file: 'web/src/api/hooks/useSessionSocket.ts', mustContain: ['new WebSocket('] },
    ],
  },
  {
    id: 'companion-api-to-routers',
    from: 'companion-api',
    to: 'routers',
    label: 'HTTP fetch to the server API against a configured base URL',
    evidence: [{ file: 'companion/src/api.ts', mustContain: ['fetch(', 'this.base'] }],
  },
  {
    id: 'server-bootstrap-to-web-app',
    from: 'server-bootstrap',
    to: 'web-app',
    label: 'Serves the built web SPA (web/dist) as static files',
    evidence: [{ file: 'server/src/app.ts', mustContain: ['serveStatic'] }],
  },
  {
    id: 'e2e-to-server-bootstrap',
    from: 'e2e',
    to: 'server-bootstrap',
    label: "Playwright's webServer spawns the server process",
    evidence: [{ file: 'playwright.config.ts', mustContain: ['npm run start -w server'] }],
  },
  {
    id: 'e2e-to-companion-core',
    from: 'e2e',
    to: 'companion-core',
    label: 'The e2e harness spawns a real headless Companion process',
    evidence: [{ file: 'e2e/companion-harness.ts', mustContain: ['spawn(', 'COMPANION_LAUNCHER'] }],
  },
  {
    id: 'e2e-to-web-app',
    from: 'e2e',
    to: 'web-app',
    label:
      'Playwright drives the SPA in-browser over the same webServer-spawned ' +
      'server that serves web/dist statically',
    evidence: [{ file: 'playwright.config.ts', mustContain: ['baseURL'] }],
  },
  {
    id: 'node-infra-to-catalog-database',
    from: 'node-infra',
    to: 'catalog-database',
    label: 'Opens and migrates the catalog SQLite file at startup',
    evidence: [{ file: 'server/src/node/config.ts', mustContain: ['openCatalogDb', 'catalog.db'] }],
  },
  {
    id: 'node-infra-to-blob-store',
    from: 'node-infra',
    to: 'blob-store',
    label: 'Owns the filesystem blob store root at startup',
    evidence: [{ file: 'server/src/node/config.ts', mustContain: ['new BlobStore', 'blobs'] }],
  },
  {
    id: 'session-core-to-session-databases',
    from: 'session-core',
    to: 'session-databases',
    label: 'Opens the per-session SQLite database file',
    evidence: [
      { file: 'packages/session-core/src/SessionHub.ts', mustContain: ['new Database(dbPath)'] },
    ],
  },
  {
    // Renamed from `node-infra-to-deepgram` (feature-service-packages task
    // 4.9): the DeepGram client moved to `@autologger/transcription` in
    // task 4.1, so the component that actually sends the request is
    // `transcription`, not the composition root — `checkRelationshipEvidence`
    // never checks that the evidence file belongs to the `from` component,
    // so re-anchoring the evidence path alone would pass green while this
    // relationship kept asserting `node-infra` talks to DeepGram.
    id: 'transcription-to-deepgram',
    from: 'transcription',
    to: 'deepgram',
    label: 'Sends recorded audio to DeepGram for transcription',
    gated: 'DEEPGRAM_API_KEY',
    evidence: [{ file: 'packages/transcription/src/deepgram.ts', mustContain: ['fetch('] }],
  },
  {
    // Renamed from `routers-to-claude-cli` (router-directory-decomposition
    // D8): the CLI spawn lives in the AI runtime, not the router layer. The
    // id appeared only here and in the git-ignored generated atlas — no
    // nav-id or authored diagram referenced the old id — so the rename is
    // pure, no other file needs updating.
    id: 'ai-runtime-to-claude-cli',
    from: 'ai-runtime',
    to: 'claude-cli',
    label: 'Spawns the claude CLI for AI chat, topics/generate, and events/generate',
    gated: 'CLAUDE_CLI_PATH',
    // ai-runtime-package task 3.6: the evidence file moves with the module
    // into `@autologger/ai-runtime`. The `from` endpoint is UNCHANGED here —
    // unlike the transcription/media-import renames above, the component that
    // spawns the CLI kept both its id and its identity across this move; only
    // its glob narrowed from `server/src/ai-runtime/**` to the package.
    evidence: [
      { file: 'packages/ai-runtime/src/aiChatRunner.ts', mustContain: ['spawn(', 'cliPath'] },
    ],
  },
  {
    // Renamed from `node-infra-to-yt-dlp` (feature-service-packages task 3.4):
    // the yt-dlp spawn moved to @autologger/media-import in task 3.1, and the
    // `from` endpoint moves with it — checkRelationshipEvidence only verifies
    // the evidence file exists and contains the literals, never that it
    // belongs to the `from` component, so re-anchoring the evidence alone
    // would have left the model asserting the composition root spawns
    // yt-dlp. The id appeared only here (and in the git-ignored generated
    // atlas) — no nav-id or authored diagram referenced the old id — so the
    // rename is pure.
    id: 'media-import-to-yt-dlp',
    from: 'media-import',
    to: 'yt-dlp',
    label: 'Spawns the operator-provided yt-dlp binary to download video audio',
    gated: 'yt-dlp binary configured or resolvable on PATH',
    evidence: [
      { file: 'packages/media-import/src/ytdlp.ts', mustContain: ['spawn(', 'binaryPath'] },
    ],
  },
  {
    id: 'auth-to-google-jwks',
    from: 'auth',
    to: 'google-jwks',
    label: "Fetches Google's JWKS to verify ID tokens",
    gated: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (OAuth config)',
    evidence: [{ file: 'server/src/auth/oauth_google.ts', mustContain: ['createLocalJWKSet'] }],
  },
];

// ---------------------------------------------------------------------------
// Capability accounting (task 4.2; design.md D3/D4/D6; spec "Baseline
// capabilities map to components; new capabilities get pending-grace"). Every
// one of the 17 baseline `openspec/specs/*` directories (verified live via
// `docs:check`) is accounted for here as exactly one of component /
// cross-cutting / process — this array IS the accounting registry the gate
// walks. `component.capabilities` (below, via `attachCapabilities`) is
// derived from this array, never hand-duplicated, so the two can't drift.
// Capabilities that exist only as an active change's delta spec (not yet
// archived to openspec/specs/, e.g. this very change's own `web-docs-site`)
// are deliberately NOT listed here — they resolve as pending by omission
// (model/capabilities.ts's `pendingCapabilities`).
// ---------------------------------------------------------------------------

const capabilityScopes: CapabilityScope[] = [
  // Cross-cutting (design.md D6: "an explicit component set", no L0 tinting).
  {
    type: 'cross-cutting',
    capability: 'api-contract-freeze',
    components: ['routers', 'web-api', 'companion-api', 'contract-fixtures', 'e2e'],
  },
  {
    type: 'cross-cutting',
    capability: 'web-api-response-conformance',
    components: ['web-api', 'web-app', 'web-admin', 'contract-fixtures'],
  },
  {
    type: 'cross-cutting',
    capability: 'web-ui-system',
    components: ['web-shared', 'web-app', 'web-admin'],
  },
  {
    type: 'cross-cutting',
    capability: 'package-architecture',
    // package-split-foundation (archived 2026-08-07): the workspace-package
    // layout/layering rules — the three L0 packages it establishes, the
    // boundary/acyclicity repo test (server-test-harness, where
    // packageBoundaries.repo.test.ts and the cross-package error-identity
    // pin live), and server-bootstrap whose error mapping the
    // nominal-identity (zod-dedup) requirement protects.
    components: ['domain', 'contract', 'ports', 'server-test-harness', 'server-bootstrap'],
  },
  {
    type: 'cross-cutting',
    capability: 'core-ports-architecture',
    // package-split-foundation D3 (modified capability): the injectable port
    // types now live as interfaces in `ports`, composed into the app-level
    // `AppEnv` by `server-core`'s appEnv.ts.
    components: [
      'server-bootstrap',
      'server-core',
      'node-infra',
      'session-core',
      'catalog',
      'auth',
      'ports',
    ],
  },
  // Process (attached to no component; listed on the About page).
  { type: 'process', capability: 'sdlc-process' },
  // cursor-agent-adapters governs the `.cursor/**` + AGENTS.md pointer-adapter
  // surface (per its spec, "the sdlc-process capability's bounded pointer-
  // adapter allowance"): those files are not `.ts`/`.tsx` sources, so no
  // component's globs can ever cover them, and its only in-repo TS artifact
  // is the CI drift guard (web/src/cursorAdapters.repo.test.ts, itself placed
  // in web-test-harness as a repo-wide policy test, not as this capability's
  // "home"). Declared `process`, alongside sdlc-process, rather than
  // attached to web-test-harness or invented a `tooling`/`process` component
  // for one guard test — it is a process/SDLC convention capability, not a
  // runtime feature owned by any component.
  { type: 'process', capability: 'cursor-agent-adapters' },
  // Component-scoped.
  {
    type: 'component',
    capability: 'ai-topics-chat',
    // router-directory-decomposition: the chat HTTP/WS surface is routers
    // (ai.ts); driving the CLI turn (aiChatRunner/aiTurn/aiChatRegistry/
    // aiMcpServer) is ai-runtime — this capability genuinely spans both.
    components: ['routers', 'ai-runtime', 'web-app'],
  },
  {
    type: 'component',
    capability: 'ai-v2-dashboards',
    // router-directory-decomposition: aiV2.ts (routers) drives the design
    // turn via aiV2SdkSpawn/aiV2PendingQuestions/aiChatRegistry (ai-runtime).
    // ai-runtime-package task 3.6: the `aiV2` component is dropped from this
    // scope because the component itself is deleted — its `aggregates.ts` and
    // `mcpTools.ts` moved into `@autologger/ai-runtime`, already named here.
    components: ['routers', 'ai-runtime', 'web-app'],
  },
  {
    type: 'component',
    capability: 'auto-event-generation',
    // router-directory-decomposition: events.ts (routers) drives the
    // orchestrator turn via aiTurn/aiMcpServer/eventGeneratePrompt
    // (ai-runtime).
    components: ['routers', 'ai-runtime', 'web-app'],
  },
  {
    type: 'component',
    capability: 'batch-audio-import',
    // Rail control, folder discovery/grouping, client-side stitch, and
    // progress UI are web-app (BatchImportModal, pages/index/batchImport/**).
    // The server side is the local-audio-import HTTP surface (routers) plus
    // the seam-parts/audio-take persistence it drives on the session spine
    // (session-core: audioSeamParts.ts, audioStore.ts). transcription's
    // transcript machinery is reused unmodified (spec: "remains
    // transcribable via the existing generate route") rather than extended
    // for this capability, so transcription is deliberately NOT listed here —
    // that reuse is transcript-generation's scope, not batch-audio-import's.
    components: ['routers', 'session-core', 'web-app'],
  },
  {
    type: 'component',
    capability: 'session-title-suffix',
    // catalog: showsStore.ts/sessionIndexStore.ts persistence + the
    // migration (persistence-package-extraction: moved out of server/src/db/
    // into @autologger/catalog). routers: profile.ts (read/write) and
    // sessions.ts (deck-title derivation at create time). web-app: the
    // Settings General Suffix control (HomeSettingsModal) and
    // NewSessionModal's session-meta wiring.
    components: ['routers', 'catalog', 'web-app'],
  },
  {
    type: 'component',
    capability: 'sheets-log-import',
    // log-import: the domain logic (categoryMatch, jobStore, sheetsFetch,
    // sheetTimecode, syncScore, runSessionLogImport). routers: logImport.ts.
    // web-app: BatchImportModal's Import Logs control +
    // batchImport/logImportClient.ts.
    //
    // transcription (feature-service-packages task 4.9, phase-3 fix-wave
    // Pattern decision 2) is deliberately NOT listed: routers/logImport.ts's
    // ensureTimedTranscript coordinator (relocated there from
    // runSessionLogImport.ts by task 5.1) reuses the existing DeepGram
    // generate path unmodified when a matched session has no timed
    // transcript yet (spec "Transcript required before sync") rather than
    // extending it for this capability — the same reused-machinery case
    // batch-audio-import's scope already omits transcription for. A
    // capabilityScope names the components that IMPLEMENT a capability's
    // requirements, never one that merely supplies machinery the capability
    // reuses unmodified, so the prior node-infra entry (with the same
    // "reuses the existing DeepGram generate path" comment) is dropped here
    // rather than re-pointed to transcription.
    components: ['routers', 'log-import', 'web-app'],
  },
  {
    type: 'component',
    capability: 'team-management',
    components: ['routers', 'catalog', 'web-app'],
  },
  {
    type: 'component',
    capability: 'topic-generation',
    // router-directory-decomposition: transcribe.ts's topics/generate route
    // (routers) drives the one-shot turn via topicGenerate.ts (ai-runtime).
    components: ['routers', 'ai-runtime', 'session-core', 'web-app'],
  },
  {
    type: 'component',
    capability: 'transcript-generation',
    // feature-service-packages task 4.9: DeepGram transcription moved to
    // @autologger/transcription in task 4.1, so the implementing component
    // is transcription, not node-infra — capabilities.ts only checks the
    // named component exists, never that it contains the implementing code,
    // so this must be corrected by hand (same class of drift task 3.4 fixed
    // for youtube-audio-import).
    components: ['routers', 'transcription', 'session-core', 'web-app'],
  },
  {
    type: 'component',
    capability: 'web-admin-users',
    components: ['routers', 'catalog', 'web-admin'],
  },
  {
    type: 'component',
    capability: 'web-docs-site',
    // The workspace this capability specs is itself: the component model,
    // extraction pipeline, drift gates, and static site all live under
    // web-docs/** (the sole `web-docs` component, toolingComponent above).
    // No other component implements any part of this capability's
    // requirements, so it is single-component-scoped rather than
    // cross-cutting.
    components: ['web-docs'],
  },
  { type: 'component', capability: 'web-home-launch', components: ['web-app'] },
  { type: 'component', capability: 'web-login-experience', components: ['web-app', 'auth'] },
  { type: 'component', capability: 'web-session-console', components: ['web-app'] },
  { type: 'component', capability: 'web-session-routing', components: ['web-app'] },
  {
    type: 'component',
    capability: 'youtube-audio-import',
    // feature-service-packages task 3.4: the yt-dlp spawn + guard/scratch
    // handling moved to @autologger/media-import in task 3.1, so the
    // implementing component is media-import, not node-infra —
    // capabilities.ts only checks the named component exists, never that it
    // contains the implementing code, so this must be corrected by hand.
    // node-infra is deliberately NOT re-added alongside it even though
    // `server/src/node/config.ts` still boot-wires `YTDLP_RESOLVED_PATH` at
    // startup: boot-wiring is hosting, not implementing, the same
    // distinction `batch-audio-import`'s scope below draws for its own
    // node-infra omission (that entry's reused-machinery case; this one's
    // reused-host case) — a capabilityScope names the components that
    // implement the capability, not every component that merely wires or
    // hosts it.
    components: ['routers', 'media-import', 'web-app'],
  },
];

/**
 * Derives each component's `capabilities` field from `capabilityScopes`
 * (`component`/`cross-cutting` entries only — `process` attaches to no
 * component) rather than hand-listing capability names twice. Sorted for
 * determinism.
 */
function attachCapabilities(components: Component[], scopes: CapabilityScope[]): Component[] {
  const byComponent = new Map<string, string[]>();
  for (const scope of scopes) {
    if (scope.type === 'process') continue;
    for (const componentName of scope.components) {
      const list = byComponent.get(componentName) ?? [];
      list.push(scope.capability);
      byComponent.set(componentName, list);
    }
  }
  return components.map((component) => ({
    ...component,
    capabilities: [...(byComponent.get(component.name) ?? [])].sort(),
  }));
}

const allComponents: Component[] = [
  ...serverComponents,
  ...packageComponents,
  ...webComponents,
  ...companionComponents,
  ...otherComponents,
  ...datastoreComponents,
  ...externalComponents,
];

export const model: ComponentModel = {
  components: attachCapabilities(allComponents, capabilityScopes),
  relationships,
  capabilityScopes,
  exclusions,
};
