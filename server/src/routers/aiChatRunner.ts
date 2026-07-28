// ai-topics-chat (design D4–D5, task 3.2) — the CLI turn runner's SPAWN +
// SUBPROCESS LOCKDOWN builder. This is the "ai router module" shared home the
// apply ledger preassigns for the argv/lockdown builder — task 3.3 (stream
// relay) and task 3.4 (spend/lifecycle) both import `spawnAiChatTurn` from
// here and extend it; they own JSONL→SSE parsing and the timeout/kill ladder
// respectively. THIS module's job stops at: build the exact locked-down argv
// (spec "Subprocess security lockdown"), spawn it with `shell:false` against
// a minimal env and a stable per-session cwd, deliver the message on stdin
// (never argv), and hand back the raw child process for the caller to read.
//
// Lockdown flag set (design D4, EMPIRICALLY PROVEN by the 2026-07-14 spike —
// design.md "Resolved by the 2026-07-14 spike" — trust it, do not re-derive):
//   -p --output-format stream-json --include-partial-messages --verbose
//   --setting-sources ""          — loads NO user/project/local settings, so
//                                    operator hooks (which run shell
//                                    unconditionally on lifecycle events,
//                                    ungoverned by tool allow/deny lists),
//                                    plugins, and user-level CLAUDE.md never
//                                    load in the child. Spike-confirmed this
//                                    does NOT break `claude login` credentials
//                                    or our own --mcp-config.
//   --tools ""                    — spike-confirmed: strips every built-in
//                                    tool while leaving MCP tools untouched.
//                                    Positive denial, not a name-keyed
//                                    denylist that drifts as the CLI's
//                                    built-in inventory grows.
//   --strict-mcp-config --mcp-config <generated file>
//                                  — only the generated autologger MCP config
//                                    loads; operator MCP servers are ignored.
//   --allowedTools mcp__autologger__{get_transcript_words,list_topics,
//   create_topic}                 — the explicit allowlist paired with the
//                                    positive built-in denial above.
//   --append-system-prompt <D7 brief>
//   --max-budget-usd <configured> — per-turn spend ceiling (spec "Spend and
//                                    concurrency bounds").
//   --resume <id>                 — ONLY on a follow-up turn, and only for an
//                                    id this runner is given (task 3.3 owns
//                                    validating the id was issued for THIS
//                                    autologger :sessionId before it ever
//                                    reaches this function).
//   NO --fork-session              — its absence is deliberate: --resume must
//                                    reuse the same id so multi-turn
//                                    continuity holds (spec "Multi-turn
//                                    continuity bound to the autologger
//                                    session").
//
// Delivery mechanics (spec "Subprocess security lockdown" + "Multi-turn
// continuity"): `shell:false` with an argument array (never a shell string),
// the user message written to the child's STDIN and never placed in argv —
// so a message beginning with `-` (e.g. `--dangerously-skip-permissions`)
// can never be parsed as a CLI flag. `cwd` is a STABLE per-autologger-session
// directory outside the repo and outside DATA_DIR — NOT fresh per turn: the
// CLI stores session state per-cwd, so a fresh cwd per turn would break
// `--resume` on turn two (spike (d) confirms resume works across two spawns
// sharing one stable cwd). `env` is a minimal whitelist: HOME (credentials)
// + PATH, plus proxy/TLS vars only when the parent process actually has them
// — nothing else from the server's own environment reaches the child.

import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiChatRelayOutcome, AiChatSseEvent } from './aiChatRelay';
import { relayAiChatTurn } from './aiChatRelay';
import { AI_MCP_TOOL_NAMES, type AiMcpToolName } from './aiMcpServer';
import { runOuterAiTurn } from './aiTurnOrchestrator';
import { DEFAULT_PROCESS_GROUP_KILL_GRACE_MS, killProcessGroup } from './processGroupKill';

/** D7 system prompt brief — guidance, not a security boundary (the boundary
 * is the lockdown flags above); prompt injection via transcript content is
 * contained to "junk topics on this session" by construction (design D7). */
export const AI_CHAT_SYSTEM_PROMPT_BRIEF =
  "You are AutoLogger's topics assistant for exactly one recording session. " +
  'Use get_transcript_words to read the session transcript, list_topics to ' +
  'see what topics already exist (check this before creating, to avoid ' +
  'duplicates), and create_topic to add a new topic (session_time as an ' +
  'HH:MM:SS-style timecode, topic_level 1-10, a concise summary). Stay ' +
  'focused on this one session and this one task.';

/** Env vars whitelisted onto the child, beyond the always-included HOME/PATH
 * (design D4: "proxy/TLS vars added where the deployment needs them"). Only
 * forwarded when actually present in the parent's env — never fabricated. */
const OPTIONAL_ENV_PASSTHROUGH = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
] as const;

/** The wire-name allowlist for `--allowedTools`, derived from the single
 * source of truth (`aiMcpServer.ts`) rather than re-listed here. */
const ALLOWED_TOOLS = AI_MCP_TOOL_NAMES.map((name) => `mcp__autologger__${name}`).join(',');

export interface BuildAiChatArgvInput {
  /** Path to the generated `--mcp-config` file (written 0600 by the caller). */
  mcpConfigPath: string;
  /** Per-turn CLI cost ceiling in USD (`aiChatMaxBudgetUsd(config)`). */
  maxBudgetUsd: number;
  /** A `claude_session_id` already issued for THIS autologger :sessionId —
   * omit for a fresh CLI session. Callers (task 3.3) are responsible for
   * validating ownership before passing this; this builder does not. */
  resumeSessionId?: string;
  /** Wire-format `--allowedTools` value (comma-joined `mcp__autologger__*`
   * names) — omit for the default full allowlist (`ai/chat`'s current,
   * unchanged behavior). `topics/generate` (topic-generation design D7)
   * passes a narrower set that withholds `list_topics`. */
  allowedTools?: string;
  /** `--append-system-prompt` value — omit for `AI_CHAT_SYSTEM_PROMPT_BRIEF`
   * (`ai/chat`'s current, unchanged behavior). `topics/generate` passes a
   * dedicated one-shot generate prompt (no `list_topics` dedup instruction,
   * since that tool is withheld — the reused chat prompt otherwise makes the
   * model create too few/no topics). */
  systemPrompt?: string;
}

/**
 * Pure builder for the locked-down argv (everything after the `claude`
 * executable itself). No I/O, no process spawn — exists so the
 * characterization test can assert the exact flag set independent of the
 * spawn plumbing, and so 3.3/3.4 can reuse it without re-deriving the
 * lockdown. Order matches the 2026-07-14 spike's proven invocation verbatim,
 * with `--max-budget-usd` and the optional `--resume` appended after.
 */
export function buildAiChatArgv(input: BuildAiChatArgvInput): string[] {
  const argv = [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--setting-sources',
    '',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    input.mcpConfigPath,
    '--allowedTools',
    input.allowedTools ?? ALLOWED_TOOLS,
    '--append-system-prompt',
    input.systemPrompt ?? AI_CHAT_SYSTEM_PROMPT_BRIEF,
    '--max-budget-usd',
    String(input.maxBudgetUsd),
  ];
  if (input.resumeSessionId) {
    argv.push('--resume', input.resumeSessionId);
  }
  return argv;
}

/**
 * Build the minimal child environment (design D4): HOME + PATH when present
 * in `procEnv`, plus any of the proxy/TLS vars that are ALSO present — never
 * fabricating a var the parent doesn't have, and never forwarding anything
 * else (credentials, test secrets, unrelated config) from the server's own
 * environment into the spawned CLI.
 */
export function buildAiChatChildEnv(procEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  if (procEnv.HOME) env.HOME = procEnv.HOME;
  if (procEnv.PATH) env.PATH = procEnv.PATH;
  for (const key of OPTIONAL_ENV_PASSTHROUGH) {
    const value = procEnv[key];
    if (value) env[key] = value;
  }
  return env;
}

const CWD_ROOT = join(tmpdir(), 'autologger-ai-chat-cwd');

/**
 * The stable, per-autologger-session working directory (design D4/D5): NOT
 * fresh per turn — the CLI keys its own session store by cwd, so a fresh cwd
 * per turn would break `--resume` on the second turn (spike (d)). Rooted
 * under the OS tmp dir, which is neither inside this repo checkout nor
 * inside `DATA_DIR` (whose default, `./data`, resolves under the repo) — a
 * sibling location the CLI's own bookkeeping can use freely without ever
 * touching autologger-managed storage.
 */
export function stableSessionCwd(sessionId: string): string {
  return join(CWD_ROOT, sessionId);
}

function writeMcpConfigFile(path: string, mcpTurn: { url: string; token: string }): void {
  const contents = JSON.stringify({
    mcpServers: {
      autologger: {
        type: 'http',
        url: mcpTurn.url,
        headers: { Authorization: `Bearer ${mcpTurn.token}` },
      },
    },
  });
  // Write then chmod (rather than relying on a mode passed to writeFileSync)
  // so the 0600 permission is unaffected by the process umask.
  writeFileSync(path, contents, { encoding: 'utf8' });
  chmodSync(path, 0o600);
}

export interface AiChatSpawnOptions {
  /** `CLAUDE_CLI_PATH` — absolute path or a PATH-resolvable name. */
  cliPath: string;
  sessionId: string;
  /** The already-trimmed user message; delivered on stdin, never argv. */
  message: string;
  /** This turn's MCP coordinates (`AiMcpListener#registerTurn`'s return) —
   * builds the generated `--mcp-config` file content. */
  mcpTurn: { url: string; token: string };
  maxBudgetUsd: number;
  /** A `claude_session_id` already validated (by the caller) as issued for
   * THIS :sessionId — omitted for a fresh CLI session. */
  resumeSessionId?: string;
  /** Restrict the `--allowedTools` set to these short tool names; omit for
   * the default full allowlist (`ai/chat`'s current, unchanged behavior). */
  allowedTools?: readonly AiMcpToolName[];
  /** Dedicated `--append-system-prompt`; omit for `ai/chat`'s reused brief. */
  systemPrompt?: string;
  /** Override for tests; defaults to the real `process.env`. */
  procEnv?: NodeJS.ProcessEnv;
}

export interface AiChatSpawnResult {
  child: ChildProcess;
  /** The stable per-session cwd this turn ran in (design D4/D5). */
  cwd: string;
  /** The generated `--mcp-config` file's path (written 0600). */
  configPath: string;
  /** Remove the generated config file (idempotent — safe to call even if the
   * file is already gone). Does NOT remove `cwd` itself, which persists
   * across turns on the same session for `--resume`. Call in the turn's
   * `finally`, alongside `mcpTurn`'s own `dispose()`. */
  cleanupConfig: () => void;
}

/**
 * Spawn one locked-down `claude` turn (design D4). Builds the argv via
 * `buildAiChatArgv`, writes the generated MCP config (0600) into the stable
 * per-session cwd, spawns with `shell:false` and the minimal env, and
 * delivers `message` on stdin (ending it immediately — this is a
 * single-message, non-interactive turn).
 *
 * Scope (task 3.2): spawn + lockdown only. The caller (task 3.3) reads
 * `child.stdout` and parses the JSONL→SSE relay; the caller (task 3.4) owns
 * the timeout/kill ladder and process-group signaling — see
 * `killAiChatProcessGroup`/`runAiChatTurn` below. Spawned with
 * `detached: true` (task 3.4) so the child is its OWN process-group leader:
 * `process.kill(-child.pid, signal)` then signals the whole group (the CLI
 * and any MCP/helper children it spawns), not just the one pid, matching
 * spec "Subprocess lifecycle" ("terminate it (and its MCP child)").
 */
export function spawnAiChatTurn(opts: AiChatSpawnOptions): AiChatSpawnResult {
  const cwd = stableSessionCwd(opts.sessionId);
  mkdirSync(cwd, { recursive: true });
  const configPath = join(cwd, 'mcp-config.json');
  writeMcpConfigFile(configPath, opts.mcpTurn);

  const argv = buildAiChatArgv({
    mcpConfigPath: configPath,
    maxBudgetUsd: opts.maxBudgetUsd,
    resumeSessionId: opts.resumeSessionId,
    allowedTools: opts.allowedTools
      ? opts.allowedTools.map((name) => `mcp__autologger__${name}`).join(',')
      : undefined,
    systemPrompt: opts.systemPrompt,
  });

  const child = spawn(opts.cliPath, argv, {
    shell: false,
    cwd,
    env: buildAiChatChildEnv(opts.procEnv ?? process.env),
    detached: true,
  });

  // Message on stdin, never argv (spec: "Message cannot smuggle a CLI
  // flag") — a single write then end, since this is one turn's prompt.
  // A dead/misbehaving CLI (bad CLAUDE_CLI_PATH, or a binary that exits
  // before draining stdin) can make this write land against an
  // already-closed pipe (EPIPE); an unlistened 'error' on a stream throws
  // and crashes the whole single Node process (D8). Swallow it here — the
  // real failure is already surfaced as a scrubbed terminal `error` event via
  // the ChildProcess-level `error`/nonzero-exit path in `relayAiChatTurn`.
  child.stdin.on('error', () => {});
  child.stdin.write(opts.message);
  child.stdin.end();

  let configRemoved = false;
  const cleanupConfig = (): void => {
    if (configRemoved) return;
    configRemoved = true;
    rmSync(configPath, { force: true });
  };

  return { child, cwd, configPath, cleanupConfig };
}

// ── Task 3.4 — process-group kill ladder + turn lifecycle orchestration ────
// (design D5 "Turn lifecycle, single-flight, and spend bounds"; spec
// "Subprocess lifecycle"). The child is spawned above with `detached: true`,
// so it is its own process-group leader; `-child.pid` addresses the whole
// group (POSIX only — this deployment target is Linux, matching every other
// process-spawning path in this change).

/** Grace window between SIGTERM and the uncatchable SIGKILL escalation.
 * Exported so tests can pass a short override; production callers rely on
 * the default (the shared ladder's own). */
export const DEFAULT_KILL_GRACE_MS = DEFAULT_PROCESS_GROUP_KILL_GRACE_MS;

/**
 * Terminate `child`'s entire process group via the SHARED group-liveness kill
 * ladder (design D2, `processGroupKill.ts`): SIGTERM the group, escalate to
 * SIGKILL only if any GROUP member is still alive after `graceMs`. Gating on
 * group liveness (`process.kill(-pgid, 0)`) rather than the tracked leader's
 * exit status closes the orphan this path used to have (review finding 1.1):
 * a leader that exits while an MCP/helper member survives no longer skips the
 * kill. A no-op — resolves immediately, no signal sent — if the child has no
 * pid or its whole group is already gone (the common case: on normal
 * completion `relayAiChatTurn` only resolves once the child has genuinely
 * exited, so this call is a fast confirmation, not a real kill). Resolves
 * once the process group is confirmed gone. Never throws.
 */
export async function killAiChatProcessGroup(child: ChildProcess, graceMs?: number): Promise<void> {
  // `detached: true` in spawnAiChatTurn makes child.pid the group's pgid.
  await killProcessGroup(child.pid, graceMs);
}

export type AiChatTurnOutcome = AiChatRelayOutcome | { ok: false; detail: 'timeout' | 'aborted' };

export interface RunAiChatTurnOptions {
  child: ChildProcess;
  /** Forwarded to the client as SSE events; NEVER called more than once with
   * a terminal (`done`/`error`) event — see the "exactly one terminal event"
   * guard below. */
  emit: (event: AiChatSseEvent) => Promise<void> | void;
  /** `aiChatTimeoutSec(config) * 1000` — the GUARANTEED backstop (spec
   * "Subprocess lifecycle"). */
  timeoutMs: number;
  /** The SSE request's abort signal — best-effort client-disconnect
   * detection (spec: "on a best-effort basis when the SSE client
   * disconnects"). Optional so unit tests can omit it entirely. */
  abortSignal?: AbortSignal;
  /** Override for tests; production callers use `killAiChatProcessGroup`'s
   * own default. */
  killGraceMs?: number;
}

/**
 * Orchestrate one turn's full lifecycle (design D5, spec "Subprocess
 * lifecycle"): race the JSONL→SSE relay against the guaranteed turn timeout
 * and a best-effort client-disconnect signal, and — on EVERY path, including
 * normal completion — terminate the child's process group before resolving,
 * so no `claude` (or MCP-helper) process ever survives a turn. Guarantees
 * exactly one terminal SSE event is ever emitted; on a best-effort
 * disconnect, no terminal event is emitted at all (spec: a stream the server
 * doesn't complete "MAY end with no terminal event").
 *
 * Since code-health-consolidation (design D3, task 4.2) this is a thin
 * adapter over the shared OUTER orchestrator (`runOuterAiTurn`), which owns
 * the race/terminal-once/emit-guard/kill/finally scaffolding for both AI
 * paths. This path's hook choices:
 * - `runRelay`: the JSONL→SSE relay over the child's stdout, with the
 *   `'await-settle'` drain policy — the relay's settle is awaited on every
 *   path before resolving, so its listeners settle and the child handle is
 *   reaped ("relay resolves only after child exit").
 * - `terminate`: the shared group-liveness kill ladder (design D2). On a
 *   normal relay outcome the child has already exited, so this is a fast
 *   no-op confirmation — the happy path pays no latency. No abort call:
 *   the relay reads raw stdout, which the group kill alone tears down.
 * - `scrub`: the IDENTITY — this relay emits fixed scrubbed literals
 *   (including `'not-logged-in'`) that v2's allow-list would mangle to
 *   `internal-error`; pinned by the task-1.3 frame-sequence tests.
 * - no `onFinally`: MCP/config cleanup lives in `driveAiTurn`'s own finally,
 *   and the concurrency slot release is ROUTER-owned (deliberate seam —
 *   see aiTurn.ts).
 */
export async function runAiChatTurn(opts: RunAiChatTurnOptions): Promise<AiChatTurnOutcome> {
  return runOuterAiTurn<AiChatSseEvent, AiChatRelayOutcome>({
    runRelay: (guardedEmit) => ({
      relay: relayAiChatTurn(opts.child, guardedEmit),
      drain: 'await-settle',
    }),
    terminate: () => killAiChatProcessGroup(opts.child, opts.killGraceMs),
    scrub: (event) => event,
    timeoutMs: opts.timeoutMs,
    emit: opts.emit,
    abortSignal: opts.abortSignal,
  });
}
