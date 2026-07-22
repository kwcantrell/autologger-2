// topic-generation (design D7, task 2.1) — the shared AI-turn orchestration
// helper. Extracted verbatim (behavior-preserving) from the inline block
// that used to live in `ai.ts`'s `ai/chat` handler: acquire the process-wide
// MCP listener, register a turn, spawn the locked-down CLI, run it to an
// outcome, and — in `finally`, on EVERY path (success, CLI error, timeout,
// abort, or a setup exception) — kill the child's process group, dispose the
// MCP registration, and remove the generated `--mcp-config` file. This is
// the correctness-critical no-orphan cleanup; `ai/chat` (ai-topics-chat) and
// `topics/generate` (topic-generation) both call this helper so there is
// exactly one copy, never two copies that can drift.
//
// Scope deliberately EXCLUDES the AI-turn concurrency SLOT
// (`aiChatTurns.tryAcquire`/`slot.release()`): callers' 409 responses differ
// (`ai/chat`'s "AI chat or AI v2" wording vs. a generate-specific message),
// so slot acquire/release stays with each router — this mirrors `ai/chat`'s
// pre-extraction structure exactly (the slot was already acquired outside
// the `streamSSE` callback and released in its own `finally`).
//
// Any exception during listener-start/register/spawn/run is caught here and
// turned into exactly one scrubbed `internal-error` emit + outcome — never
// the raw exception's text or paths (spec "Setup failures never leak the
// raw exception"; ai.int.test.ts "setup failures never leak the raw
// exception" pins this for `ai/chat` via a real, hermetic `mkdirSync` EEXIST
// failure).

import type { SessionHubRegistry } from '../session/SessionHub';
import type { AiChatSseEvent } from './aiChatRelay';
import {
  type AiChatSpawnResult,
  type AiChatTurnOutcome,
  killAiChatProcessGroup,
  runAiChatTurn,
  spawnAiChatTurn,
} from './aiChatRunner';
import { type AiMcpToolName, type AiMcpTurn, getAiMcpListener } from './aiMcpServer';

export interface DriveAiTurnOptions {
  /** The process-wide session registry — resolves the MCP listener singleton. */
  registry: SessionHubRegistry;
  /** `CLAUDE_CLI_PATH`, already trimmed. */
  cliPath: string;
  sessionId: string;
  /** The user message, delivered on the child's stdin (never argv). */
  message: string;
  /** Restrict the `--allowedTools` set for this turn; omit for the full
   * default allowlist (`ai/chat`'s current behavior — every
   * `AI_MCP_TOOL_NAMES` entry). `topics/generate` (task 2.3) withholds
   * `list_topics` here so the model cannot dedup against the topics it is
   * about to replace (design D3/D5). */
  allowedTools?: readonly AiMcpToolName[];
  /** Dedicated `--append-system-prompt`; omit for `ai/chat`'s reused brief.
   * `topics/generate` passes a generate-specific prompt (no `list_topics`
   * dedup instruction, since that tool is withheld). */
  systemPrompt?: string;
  maxBudgetUsd: number;
  timeoutMs: number;
  /** A `claude_session_id` already validated by the caller as issued for
   * THIS :sessionId — omit for a fresh CLI session (`ai/chat` multi-turn
   * continuity; `topics/generate` never passes this). */
  resumeSessionId?: string;
  /** Forwarded to the caller as SSE-shaped events. `ai/chat` writes these to
   * its SSE stream; `topics/generate` (task 2.3) passes a no-op — it reads
   * the returned `AiChatTurnOutcome` instead. */
  emit: (event: AiChatSseEvent) => Promise<void> | void;
  /** Best-effort client-disconnect signal — `ai/chat` passes
   * `c.req.raw.signal`; `topics/generate` omits it (design D2: a synchronous
   * POST runs to completion, deterministically). */
  abortSignal?: AbortSignal;
}

/**
 * Drive one AI turn's full lifecycle: MCP listener + registration → spawn →
 * run-to-outcome → the full no-orphan cleanup. Never throws — any setup or
 * run exception is caught, scrubbed to a single `internal-error` emit, and
 * returned as `{ ok: false, detail: 'internal-error' }`, matching `ai/chat`'s
 * pre-extraction catch-clause exactly.
 */
export async function driveAiTurn(opts: DriveAiTurnOptions): Promise<AiChatTurnOutcome> {
  let mcpTurn: AiMcpTurn | null = null;
  let spawned: AiChatSpawnResult | null = null;
  try {
    const listener = await getAiMcpListener(opts.registry);
    mcpTurn = listener.registerTurn(opts.sessionId);
    spawned = spawnAiChatTurn({
      cliPath: opts.cliPath,
      sessionId: opts.sessionId,
      message: opts.message,
      mcpTurn: { url: mcpTurn.url, token: mcpTurn.token },
      maxBudgetUsd: opts.maxBudgetUsd,
      resumeSessionId: opts.resumeSessionId,
      allowedTools: opts.allowedTools,
      systemPrompt: opts.systemPrompt,
    });
    return await runAiChatTurn({
      child: spawned.child,
      emit: opts.emit,
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    });
  } catch {
    // Any unexpected failure setting up or running the turn (e.g. the MCP
    // listener failing to start, or spawnAiChatTurn's cwd/config write
    // throwing) still owes the caller exactly one terminal event — never the
    // raw exception message (a secrecy leak the spec forbids).
    await opts.emit({ event: 'error', data: { detail: 'internal-error' } });
    return { ok: false, detail: 'internal-error' };
  } finally {
    // Defensive-in-depth: runAiChatTurn already kills the process group on
    // every path it controls, and this call is idempotent (a fast no-op once
    // the child has exited). It covers the case where the turn threw AFTER
    // spawnAiChatTurn returned but before/inside runAiChatTurn. (The narrow
    // window where spawnAiChatTurn itself throws after fork but before
    // returning — leaving `spawned` null — is not reachable to kill here; in
    // practice the only post-fork work is guarded stdin writes, so it does not
    // orphan.)
    if (spawned) await killAiChatProcessGroup(spawned.child);
    mcpTurn?.dispose();
    spawned?.cleanupConfig();
  }
}
