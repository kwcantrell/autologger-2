// ai-v2-dashboards (design D7/D8, task 0.9) — the ONE call site that reaches
// the Agent SDK's `query()`, and therefore the one place a design turn can
// spawn a subprocess. This module exists so the spec's "Design turn
// contract" requirement — "No guard path SHALL spawn a subprocess" — is
// TESTABLE against the SDK transport, which the CLI transport's
// `fake-claude` argv-recording fixture (ai-topics-chat) does not reach (see
// tasks.md's "Test-infra note").
//
// Task 2.5 (turn runner + SSE relay) and 2.6 (lifecycle: timeout backstop,
// orphan-safe kill ladder per task 0.5's spike) OWN the real implementation
// and will extend `attemptDesignTurnSpawn` in place — build guard
// evaluation, streaming/relay, and lifecycle around this call, not a
// competing one. This file's job stops at: accept an already-resolved
// `Options` object (2.3 owns building the closed-world lockdown set) and
// call the SDK exactly once.
//
// THE CONTRACT CALLERS MUST HONOR: call `attemptDesignTurnSpawn` only after
// every guard in the design endpoint's order (spec: authentication → session
// resolution/scoping `404` → configuration/open-network `503` → body
// validation `422`/`400` → turn slot `409`) has already passed. A
// guard-rejected request must return BEFORE this function is ever called —
// that is what makes "no guard path spawns" observable: nothing upstream of
// this module touches the SDK, so a no-spawn test only has to prove this
// function was never invoked (see `aiV2SdkSpawn.test.ts`'s recorder-fixture
// seam), never introspect what the SDK itself decided to do.
//
// `query()` spawns the child SYNCHRONOUSLY as part of construction —
// confirmed by reading the pinned SDK's bundled transport (`sdk.mjs`):
// `initialize()` (which builds argv and calls `child_process.spawn`, or the
// `spawnClaudeCodeProcess` override when one is supplied) runs directly in
// the transport's constructor unless `deferSpawn` is set, which only the
// SDK's own `resume`-with-`sessionStore` path passes — this design's fresh,
// non-resumed turns never take that path. So by the time `query()` returns,
// the spawn attempt has already happened, whether or not any message is
// ever read from the returned `Query`.

import { type ChildProcess, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Clock } from '@autologger/ports';
import { runOuterAiTurn } from './aiTurnOrchestrator';
import { AGGREGATE_MCP_SERVER_NAME } from './mcpTools';
import { killProcessGroup } from './processGroupKill';

/**
 * Start a design turn against the Agent SDK. This is the spawn boundary:
 * calling it is calling `query()`, which spawns the child synchronously
 * (see module docstring). Deliberately does not drain or await the turn —
 * 2.5 owns SSE relay and message handling; 2.6 owns lifecycle/timeout. A
 * caller that only cares about the spawn/no-spawn boundary (this module's
 * own tests) may drop the returned `Query` without ever reading from it.
 */
export function attemptDesignTurnSpawn(prompt: string, options: Options): Query {
  return query({ prompt, options });
}

// ── Task 2.3 — the closed-world SDK option set (the security boundary) ──────
// design D8/D8a, "Resolved by the spike" (0.4/0.5), spec "Subprocess security
// lockdown". This builder is the SINGLE SOURCE OF TRUTH for the locked-down
// `Options` the runner passes to `query()`: 2.3's closed-world characterization
// test asserts the SAME object this function returns, so a value change is
// caught by the pinned-value assertions and an ADDITION (a widening option) is
// caught by the absence assertions. Every value below is spike-confirmed
// (0.4: `tools: ['AskUserQuestion']` + `permissionMode: 'plan'` works end to
// end; `tools: []` and `'dontAsk'` each independently kill the interaction).

/** The one built-in tool a design turn may reach (D8a): a CLOSED set of one,
 * established by the base-tool-set option — NOT by an auto-approve allowlist.
 * `tools: []` would strip it (spike 0.4) and kill the interactive question. */
const DESIGN_TURN_BUILTIN_TOOLS = ['AskUserQuestion'] as const;

/** Belt-and-braces (D8a/D8b): name the built-in write/exec set explicitly.
 * `disallowedTools` is the only option documented as overriding an allow, so
 * it re-states the denial `tools` already implies by omission. */
const DESIGN_TURN_DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'Read',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
] as const;

/** MCP-tool-call duration bound (D8b re-instated `MCP_TOOL_TIMEOUT`): a hung
 * in-process aggregate tool must not wedge a turn indefinitely. */
export const DESIGN_TURN_MCP_TOOL_TIMEOUT_MS = '30000';

/** Idle-question auto-continue bound. Set via the top-level `settings` option,
 * NEVER `managedSettings` — 0.4/0.8 confirmed the restrictive-only filter drops
 * it there. A native complement to the server-side abandonment backstop (D7),
 * not a replacement. */
const DESIGN_TURN_ASK_TIMEOUT = '60s' as const;

/** Always-forwarded minimal env beyond HOME/PATH. Proxy/TLS vars are forwarded
 * only when the parent actually has them (never fabricated), mirroring the AI
 * chat's precedent. */
const DESIGN_TURN_OPTIONAL_ENV_PASSTHROUGH = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
] as const;

/** The complete set of env keys a design-turn subprocess may carry. The
 * closed-world test asserts `options.env`'s keys are a subset of this set
 * (an addition is a widening that must be caught), and that the required keys
 * are present. `ANTHROPIC_API_KEY` appears only when a workspace key is
 * configured (D9); the proxy/TLS keys only when the parent has them. */
export const DESIGN_TURN_ALLOWED_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'MCP_TOOL_TIMEOUT',
  'ANTHROPIC_API_KEY',
  ...DESIGN_TURN_OPTIONAL_ENV_PASSTHROUGH,
];

/** Pinned system prompt (spec: "an explicit pinned system prompt"). Guidance,
 * not a security boundary — the boundary is the option set above. A plain
 * string REPLACES the claude_code coding-agent preset entirely, so the design
 * agent inherits none of it. */
export const DESIGN_TURN_SYSTEM_PROMPT =
  "You are AutoLogger's dashboard design assistant for exactly one recording session. " +
  "Read that session's aggregate statistics through the provided tools (speaker_stats, " +
  'utterance_stats, topic_timeline, event_stats, transcript_excerpt), then propose a ' +
  'starting dashboard the user can edit directly. Compose it only from the fixed widget ' +
  'catalog you are given. When a tool reports its data as unavailable, say so plainly — ' +
  'never invent zeros or placeholder measurements. You may ask the user one clarifying ' +
  'question. Stay focused on this one session and this one task.';

export interface BuildDesignTurnOptionsParams {
  /** Pinned working directory — OUTSIDE the repo checkout and DATA_DIR
   * (spec). Created by `createDesignTurnWorkspace`. */
  cwd: string;
  /** Isolated `CLAUDE_CONFIG_DIR`, separate from the operator's `~/.claude`. */
  configDir: string;
  /** Workspace-scoped Anthropic key (D9). When present it is passed as
   * `ANTHROPIC_API_KEY` and the interactive login is NOT used. */
  apiKey?: string;
  maxBudgetUsd: number;
  /** The per-turn aggregate MCP server (`buildAggregateMcpServer`). */
  mcpServer: McpServerConfig;
  /** The permission callback — its identity is out of scope for the value
   * pins, but it must be PRESENT (a design turn runs in `'plan'` mode, which
   * routes tool use through this callback). */
  canUseTool: CanUseTool;
  /** The turn's abort controller — the timeout backstop and client-disconnect
   * path call `.abort()` on it. */
  abortController: AbortController;
  /** The group-kill spawn override (`createDesignTurnSpawner`) — the ONLY way
   * to obtain the child pid/pgid (spike 0.5); required for no-orphan. */
  spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess;
  /** Test seam: point the SDK at an on-disk recorder instead of the real CLI.
   * Never set in production. */
  pathToClaudeCodeExecutable?: string;
  /** Override for tests; defaults to the real `process.env`. */
  procEnv?: NodeJS.ProcessEnv;
}

/**
 * Build the closed-world locked-down `Options` for a design turn. Pure — no
 * I/O, no spawn — so the closed-world test asserts exactly what the runner
 * passes to `query()`. Only the keys set here reach the SDK; every widening
 * option (`hooks`/`plugins`/`agents`/`extraArgs`/`additionalDirectories`/
 * `allowDangerouslySkipPermissions`/`permissionPromptToolName`) is left unset
 * and therefore absent — which the closed-world absence assertions enforce.
 */
export function buildDesignTurnOptions(params: BuildDesignTurnOptionsParams): Options {
  const procEnv = params.procEnv ?? process.env;

  const env: Record<string, string> = {
    // Isolated config dir (separate from the operator's ~/.claude); the CLI
    // reads credentials and settings from here.
    CLAUDE_CONFIG_DIR: params.configDir,
    // MCP tool-call duration bound (D8b).
    MCP_TOOL_TIMEOUT: DESIGN_TURN_MCP_TOOL_TIMEOUT_MS,
  };
  if (procEnv.PATH) env.PATH = procEnv.PATH;
  if (procEnv.HOME) env.HOME = procEnv.HOME;
  for (const key of DESIGN_TURN_OPTIONAL_ENV_PASSTHROUGH) {
    const value = procEnv[key];
    if (value) env[key] = value;
  }
  // D9: a configured workspace key is preferred over the interactive login,
  // and the login is not used while a key is configured.
  if (params.apiKey) env.ANTHROPIC_API_KEY = params.apiKey;

  const options: Options = {
    // D8a: the built-in tool set is a closed set of exactly one.
    tools: [...DESIGN_TURN_BUILTIN_TOOLS],
    // D8b: explicit denial of the write/exec built-ins (overrides an allow).
    disallowedTools: [...DESIGN_TURN_DISALLOWED_TOOLS],
    // `allowedTools` does not restrict; it auto-approves. Pin it empty so
    // nothing is ever auto-approved without the `canUseTool` callback running.
    allowedTools: [],
    // 0.4: 'plan' both advertises AskUserQuestion AND routes through
    // canUseTool. 'dontAsk' auto-denies before the callback ever runs.
    permissionMode: 'plan',
    // Disable the filesystem settings tiers — closes the non-interactive
    // trust-skip hook hole (0.3), independent of cwd.
    settingSources: [],
    // Suppress the repo's checked-in .mcp.json (CodeGraph) from loading.
    strictMcpConfig: true,
    // Session forking disabled explicitly rather than left to a default.
    forkSession: false,
    // Pinned cwd, outside the repo and DATA_DIR (defense-in-depth for the
    // server/.env exposure; the hook hole itself is closed by settingSources).
    cwd: params.cwd,
    systemPrompt: DESIGN_TURN_SYSTEM_PROMPT,
    maxBudgetUsd: params.maxBudgetUsd,
    // D6a/D3: pin previewFormat at its 'markdown' default; never opt into
    // 'html'. Catalog previews render through real React components.
    toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
    // Idle-question bound via `settings` (NOT managedSettings — 0.4/0.8).
    settings: { askUserQuestionTimeout: DESIGN_TURN_ASK_TIMEOUT },
    // Account-level cloud connectors disabled (survives the restrictive-only
    // filter — 0.4/0.8).
    managedSettings: { disableClaudeAiConnectors: true },
    mcpServers: { [AGGREGATE_MCP_SERVER_NAME]: params.mcpServer },
    canUseTool: params.canUseTool,
    abortController: params.abortController,
    spawnClaudeCodeProcess: params.spawnClaudeCodeProcess,
    env,
  };
  if (params.pathToClaudeCodeExecutable) {
    options.pathToClaudeCodeExecutable = params.pathToClaudeCodeExecutable;
  }
  return options;
}

// ── Task 2.3 — the permission callback (canUseTool) ────────────────────────
// design D7. In `'plan'` mode every tool use routes through this callback.
// The aggregate MCP tools are allowed; the write/exec built-ins are absent
// from `tools` and additionally denied here by default-deny. AskUserQuestion
// is delegated to an injected handler — Phase 3 (2.7/3.x) supplies the real
// pending-question relay that BLOCKS the turn on an answer; until then it is
// denied. `ToolSearch`/`ExitPlanMode` are passed through as a NAMED allowance
// (never a wildcard); spike 0.4 found they don't request passage in minimal
// turns, so this branch is defensive, not load-bearing.

const AGGREGATE_TOOL_WIRE_PREFIX = `mcp__${AGGREGATE_MCP_SERVER_NAME}__`;
const NAMED_INFRA_PASSTHROUGH = new Set(['ToolSearch', 'ExitPlanMode']);

export interface DesignTurnCanUseToolDeps {
  /** Phase-3 seam: the pending-question relay. When absent, AskUserQuestion is
   * denied (the turn cannot ask a question until Phase 3 wires this). */
  onQuestion?: (
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ) => Promise<PermissionResult>;
}

export function buildDesignTurnCanUseTool(deps: DesignTurnCanUseToolDeps = {}): CanUseTool {
  return async (toolName, input, options) => {
    if (toolName.startsWith(AGGREGATE_TOOL_WIRE_PREFIX)) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (NAMED_INFRA_PASSTHROUGH.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (toolName === 'AskUserQuestion') {
      if (deps.onQuestion) return deps.onQuestion(input, options);
      return {
        behavior: 'deny',
        message: 'Interactive questions are not available in this turn.',
      };
    }
    return { behavior: 'deny', message: `The ${toolName} tool is not permitted in a design turn.` };
  };
}

// ── Task 2.6 — process-group kill ladder (no orphan on ANY exit path) ───────
// design D8/"Resolved by the spike" 0.5, spec "Subprocess and turn lifecycle".
// This path's group-liveness-gated ladder (escalation gated on
// `process.kill(-pgid, 0)`, NOT the tracked leader's exit status — spike 0.5
// Turn 2 proved a leader-exit-gated ladder leaves a SIGTERM-ignoring group
// member orphaned; Turn 3's group-liveness gating closed it) was the PROVEN
// implementation, so code-health-consolidation task 4.1 (design D2) extracted
// it verbatim into the shared `processGroupKill.ts`, now consumed by BOTH this
// path and `killAiChatProcessGroup`. The names below are stable re-exports for
// this path's callers/tests. The child is spawned `detached: true` (via
// `createDesignTurnSpawner`) so its pid IS its pgid, and `-pid` addresses the
// whole group (POSIX/Linux — this deployment target, matching every other
// process-spawning path in the repo).

export {
  DEFAULT_PROCESS_GROUP_KILL_GRACE_MS as DEFAULT_DESIGN_TURN_KILL_GRACE_MS,
  killProcessGroup as killDesignTurnProcessGroup,
  processGroupAlive as designTurnGroupAlive,
} from './processGroupKill';

export interface DesignTurnSpawner {
  /** Pass as `Options.spawnClaudeCodeProcess`. Spawns the real CLI
   * `detached: true` and captures its pgid. */
  spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess;
  /** Terminate the captured group via the ladder. Idempotent; a no-op if
   * nothing was spawned or the group is already gone. Call on EVERY exit
   * path. */
  terminate: (graceMs?: number) => Promise<void>;
  /** The captured pgid (pid of the detached leader), or null if not yet
   * spawned. */
  getPgid: () => number | null;
}

/**
 * A `spawnClaudeCodeProcess` override that owns the child as its own
 * process-group leader (`detached: true`) and exposes a group-kill `terminate`
 * — the no-orphan guarantee (spike 0.5). The SDK exposes no pid anywhere, so
 * this override is the ONLY way to obtain the pgid the ladder needs.
 *
 * `clock` is required and leading (design D3, ruling E3): it is captured by
 * this closure and threaded into every `terminate()` call's kill ladder.
 * Production callers (`routers/aiV2.ts`) pass `c.env.ports.clock`; never a
 * freshly constructed clock. `terminate`'s own signature is unchanged — the
 * clock is baked in at construction, not passed per-call.
 */
export function createDesignTurnSpawner(clock: Clock): DesignTurnSpawner {
  let child: ChildProcess | null = null;
  let terminated = false;

  const spawnClaudeCodeProcess = (options: SpawnOptions): SpawnedProcess => {
    const spawned = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true, // fresh process-group leader; pgid === spawned.pid
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = spawned;
    return spawned as unknown as SpawnedProcess;
  };

  const terminate = async (graceMs?: number): Promise<void> => {
    if (terminated) return;
    terminated = true;
    await killProcessGroup(clock, child?.pid ?? null, graceMs);
  };

  return { spawnClaudeCodeProcess, terminate, getPgid: () => child?.pid ?? null };
}

// ── Task 2.5 — turn runner + SSE relay ─────────────────────────────────────
// spec "Design turn contract" (SSE streaming) + "Subprocess and turn
// lifecycle". Relays ONLY assistant text (never reasoning/thinking, never
// tool_use blocks) as `delta` events, and emits EXACTLY ONE terminal event
// (`done` XOR `error`) per completed stream — enforced by the `guardedEmit`
// choke point (mirroring `runAiChatTurn`'s pattern). A client abort emits NO
// terminal event. The turn timeout is INDEPENDENT of the agent iterator (a
// turn that never yields still ends), and the child group is terminated on
// EVERY exit path. The iterator THROWS on abort in every arm (spike 0.5) —
// caught here, never relied upon to return cleanly.

export type DesignTurnSseEvent = {
  event: 'delta' | 'done' | 'error';
  data: Record<string, unknown>;
};

/** The fixed, scrubbed error details a terminal `error` event may carry.
 * Raw exception text / subprocess stderr / agent error arrays NEVER flow into
 * `{ detail }` — `guardedEmit` is the single choke point (task 2.8's
 * `scrubDesignTurnEvent`) that ENFORCES this, not merely an artifact of
 * today's call sites happening to only ever pass one of these four literals. */
export type DesignTurnErrorDetail = 'timeout' | 'upstream-failed' | 'internal-error' | 'aborted';

export type DesignTurnOutcome = { ok: true } | { ok: false; detail: DesignTurnErrorDetail };

export interface RunDesignTurnOptions {
  /** The SDK turn (result of `attemptDesignTurnSpawn`), or any async iterable
   * of `SDKMessage` for hermetic tests. */
  query: AsyncIterable<SDKMessage>;
  /** Forwarded to the client as SSE events; NEVER invoked more than once with
   * a terminal event (`guardedEmit` guard). */
  emit: (event: DesignTurnSseEvent) => Promise<void> | void;
  /** The GUARANTEED backstop, independent of the iterator (spec). */
  timeoutMs: number;
  /** The turn's abort controller — `.abort()` is called on the timeout and
   * client-disconnect paths so the SDK tears the child down and the iterator
   * throws. */
  abortController: AbortController;
  /** Terminate the child process group (the no-orphan ladder). Called on
   * every exit path. */
  terminate: (graceMs?: number) => Promise<void>;
  /** Slot-release cleanup — invoked in a `finally` on EVERY exit path
   * (completion/error/timeout/abort). A spy in 2.6's tests; Unit D (2.7)
   * passes the real `AiChatTurnRegistry` release. */
  release: () => void;
  /** Abandon any pending `AskUserQuestion` for this turn (task 3.3, design
   * D7 — "not hygiene": an unanswered question parked on the pending-
   * question registry holds this turn's concurrency slot open, the
   * predecessor's slot-leak hazard). Invoked in the SAME `finally` as
   * `terminate`/`release`, on EVERY exit path — including a clean
   * completion, where it is a harmless no-op — so a pending entry can never
   * survive the turn it belongs to and a late answer has nothing left to
   * resolve. Optional so callers that don't wire the Phase-3 registry
   * (e.g. 2.5/2.6's own tests) are unaffected. */
  abandonPendingQuestions?: () => void;
  /** Turn workspace (cwd + config-dir) removal — code-health-consolidation
   * design D3: rides in the shared orchestrator's `onFinally` alongside
   * `abandonPendingQuestions` + `release`, so it too runs on EVERY exit path
   * the orchestrator controls. Optional (idempotent at the source —
   * `createDesignTurnWorkspace`); the router keeps its own defense-in-depth
   * call for setup failures before this function ever runs. */
  cleanupWorkspace?: () => void;
  /** Best-effort client-disconnect signal (the SSE request's abort signal). */
  abortSignal?: AbortSignal;
  killGraceMs?: number;
}

function isAssistantTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string' &&
    (block as { text: string }).text.length > 0
  );
}

// ── Task 2.8 — terminal-error scrubbing (the confidentiality choke point) ──
// spec "Design turn contract" ({ detail } shape) + design Risks (error
// scrubbing). Raw exception text, subprocess stderr, and an agent's own
// `errors: string[]` array (SDKResultError, sdk.d.ts) can all carry file
// paths, env fragments, or credential-adjacent text — none of that may ever
// reach the client. `DESIGN_TURN_ERROR_DETAILS` is the fixed allow-list;
// `scrubDesignTurnEvent` is the enforcement `guardedEmit` calls on EVERY
// event, so an `error` event's `data` is rebuilt from scratch as exactly
// `{ detail }`, and `detail` itself is validated against the allow-list —
// anything else (a raw string, an array, undefined, an accidental extra
// field riding alongside a valid detail) becomes `'internal-error'`. This is
// a structural guarantee, not a hope that every call site stays careful:
// today's call sites already only ever construct one of these four literals,
// but a future one that slips and forwards `err.message` or `result.errors`
// is caught here rather than reaching the client.
const DESIGN_TURN_ERROR_DETAILS: ReadonlySet<string> = new Set<DesignTurnErrorDetail>([
  'timeout',
  'upstream-failed',
  'internal-error',
  'aborted',
]);

export function scrubDesignTurnEvent(event: DesignTurnSseEvent): DesignTurnSseEvent {
  if (event.event !== 'error') return event;
  const candidate = (event.data as { detail?: unknown } | null | undefined)?.detail;
  const detail: DesignTurnErrorDetail =
    typeof candidate === 'string' && DESIGN_TURN_ERROR_DETAILS.has(candidate)
      ? (candidate as DesignTurnErrorDetail)
      : 'internal-error';
  // Rebuilt wholesale — any extra field on `data` (e.g. a stray `stderr` or
  // `raw` key some future caller might add alongside a valid detail) is
  // dropped, not merely the invalid detail replaced.
  return { event: 'error', data: { detail } };
}

/** The per-path relay (design D3: the relay/message-translation is NOT
 * symmetric across the two AI paths and stays per-path — this one translates
 * an `AsyncIterable<SDKMessage>` inline; chat's reads a `ChildProcess`'s
 * stdout JSONL in `aiChatRelay.ts`). Emits only through the shared guarded
 * emitter; never rejects — the iterator throwing (our own abort/timeout
 * per spike 0.5, or a genuine SDK error) resolves to a scrubbed
 * `internal-error` outcome instead. */
function relayDesignTurnMessages(
  query: AsyncIterable<SDKMessage>,
  guardedEmit: (event: DesignTurnSseEvent) => Promise<void>,
): Promise<DesignTurnOutcome> {
  return (async (): Promise<DesignTurnOutcome> => {
    try {
      for await (const message of query) {
        if (message.type === 'assistant') {
          const content = (message.message as { content?: unknown } | undefined)?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (isAssistantTextBlock(block)) {
                await guardedEmit({ event: 'delta', data: { text: block.text } });
              }
              // thinking / signature / tool_use / anything else: never relayed
              // (spec: assistant text only, no reasoning reaches the client).
            }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success' && message.is_error !== true) {
            await guardedEmit({ event: 'done', data: {} });
            return { ok: true };
          }
          await guardedEmit({ event: 'error', data: { detail: 'upstream-failed' } });
          return { ok: false, detail: 'upstream-failed' };
        }
      }
      // Stream ended with no `result` — unusable; scrubbed failure.
      await guardedEmit({ event: 'error', data: { detail: 'internal-error' } });
      return { ok: false, detail: 'internal-error' };
    } catch {
      // The iterator threw — our own abort/timeout (spike 0.5: throws in every
      // arm), or a genuine SDK error. Attempt a scrubbed terminal; guardedEmit
      // no-ops if the timeout/abort branch already claimed the terminal slot.
      await guardedEmit({ event: 'error', data: { detail: 'internal-error' } });
      return { ok: false, detail: 'internal-error' };
    }
  })();
}

/**
 * Orchestrate one design turn's lifecycle: relay the SDK message stream as SSE
 * `delta`/`done`/`error` events, race the relay against the guaranteed timeout
 * and a best-effort client-disconnect signal, terminate the child group on
 * every path, and run the cleanup closures in a `finally`. Guarantees exactly
 * one terminal event; a client disconnect emits none.
 *
 * Since code-health-consolidation (design D3, task 4.2) this is a thin
 * adapter over the shared OUTER orchestrator (`runOuterAiTurn`), which owns
 * the race/terminal-once/emit-guard/kill/finally scaffolding for both AI
 * paths. This path's hook choices:
 * - `runRelay`: `relayDesignTurnMessages` over the SDK iterator, with the
 *   `'detach'` drain policy — the relay is NEVER awaited after the race: an
 *   aborted SDK iterator may never yield/settle, and the turn must still end
 *   and release its slot.
 * - `terminate`: owns this path's `abortController.abort()` (killing the
 *   pgid alone does not stop the SDK's iterator) plus the spawner's shared
 *   group-liveness kill ladder (design D2); the grace override is baked into
 *   the closure.
 * - `scrub`: `scrubDesignTurnEvent` (task 2.8) — the four-literal allow-list
 *   rebuild, applied by the shared guard to EVERY event (the structural
 *   confidentiality chokepoint).
 * - `onFinally`: `abandonPendingQuestions` (task 3.3 — the every-exit-path
 *   abandon guarantee is load-bearing) + slot `release` + workspace cleanup,
 *   in that order, on EVERY exit path.
 */
export async function runDesignTurn(opts: RunDesignTurnOptions): Promise<DesignTurnOutcome> {
  return runOuterAiTurn<DesignTurnSseEvent, DesignTurnOutcome>({
    runRelay: (guardedEmit) => ({
      relay: relayDesignTurnMessages(opts.query, guardedEmit),
      drain: 'detach',
    }),
    terminate: async () => {
      opts.abortController.abort();
      await opts.terminate(opts.killGraceMs);
    },
    scrub: scrubDesignTurnEvent,
    timeoutMs: opts.timeoutMs,
    emit: opts.emit,
    abortSignal: opts.abortSignal,
    onFinally: () => {
      opts.abandonPendingQuestions?.();
      opts.release();
      opts.cleanupWorkspace?.();
    },
  });
}

// ── Turn workspace + credentials (runtime file I/O, kept out of the pure
// option builder so the closed-world test asserts a pure object) ────────────

const DESIGN_TURN_CWD_PREFIX = 'autologger-ai-v2-cwd-';
const DESIGN_TURN_CONFIG_PREFIX = 'autologger-ai-v2-config-';

export interface DesignTurnWorkspace {
  /** Pinned cwd for this turn — a fresh OS-tmp subdir, outside the repo and
   * DATA_DIR. */
  cwd: string;
  /** Isolated CLAUDE_CONFIG_DIR for this turn — a fresh OS-tmp subdir. */
  configDir: string;
  /** Remove both dirs. Idempotent; safe on every exit path. */
  cleanup: () => void;
}

/**
 * Create a fresh, per-turn cwd and isolated config dir under the OS tmp dir —
 * neither inside the repo checkout nor DATA_DIR (whose default `./data`
 * resolves under the repo). Fresh per turn: a design turn never resumes an SDK
 * session store, so there is nothing to preserve across turns and full
 * isolation is the safest choice.
 */
export function createDesignTurnWorkspace(): DesignTurnWorkspace {
  const cwd = mkdtempSync(join(tmpdir(), DESIGN_TURN_CWD_PREFIX));
  const configDir = mkdtempSync(join(tmpdir(), DESIGN_TURN_CONFIG_PREFIX));
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  };
  return { cwd, configDir, cleanup };
}

/**
 * When no workspace key is configured (D9 login fallback, permitted only on a
 * loopback bind — already gated upstream), seed the isolated config dir with
 * the operator's `claude login` credentials so the subprocess can authenticate
 * without inheriting the rest of the operator's `~/.claude`. A no-op when a key
 * is configured (the key authenticates via `ANTHROPIC_API_KEY`) or when no
 * credential file exists (the turn then fails with a scrubbed auth error).
 *
 * `credentialSourcePath` is resolved ONCE by the composition root
 * (`node/config.ts`'s `Config.AI_V2_CREDENTIAL_SOURCE_PATH`) and passed in —
 * this function no longer discovers it itself (ai-runtime-package task 2.5,
 * spec "Host-environment discovery belongs to the composition root"). The
 * composition root decides *where*; this decides *what to do with it*.
 */
export function prepareDesignTurnCredentials(
  configDir: string,
  credentialSourcePath: string,
  apiKey?: string,
): void {
  if (apiKey) return;
  if (existsSync(credentialSourcePath)) {
    copyFileSync(credentialSourcePath, join(configDir, '.credentials.json'));
  }
}
