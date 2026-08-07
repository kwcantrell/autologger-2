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
// (each endpoint's detail phrases its own next action, though all now name
// the full holder set — AI chat, AI v2, topic generation, event generation),
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

import type { SessionHubRegistryFacade } from '@autologger/session-core';
import type { AiChatSseEvent } from './aiChatRelay';
import {
  type AiChatSpawnResult,
  type AiChatTurnOutcome,
  killAiChatProcessGroup,
  runAiChatTurn,
  spawnAiChatTurn,
} from './aiChatRunner';
import {
  type AiMcpPageCoverage,
  type AiMcpToolName,
  type AiMcpTurn,
  type AiMcpTurnContext,
  getAiMcpListener,
} from './aiMcpServer';

/** What a turn reports when its registration never carried a transcript word
 * snapshot — and what a turn that failed BEFORE registering reports: no
 * snapshot, no pages, hence no coverage claim to fail (D6). */
const NO_PAGE_COVERAGE: AiMcpPageCoverage = { totalPages: 0, servedPages: 0 };

export interface DriveAiTurnOptions {
  /** The process-wide session registry — resolves the MCP listener singleton. */
  registry: SessionHubRegistryFacade;
  /** `CLAUDE_CLI_PATH`, already trimmed. */
  cliPath: string;
  sessionId: string;
  /** The user message, delivered on the child's stdin (never argv). */
  message: string;
  /** Restrict the `--allowedTools` set for this turn. As of
   * auto-generate-event-logs task 3.4 EVERY caller passes this explicitly —
   * `ai/chat` passes `AI_CHAT_ALLOWED_TOOLS` (the three chat tools) and
   * `topics/generate` withholds `list_topics` so the model cannot dedup
   * against the topics it is about to replace (topic-generation D3/D5). The
   * omit path still exists and falls back to the CHAT default pinned in
   * `aiChatRunner.ts` (deliberately narrower than `AI_MCP_TOOL_NAMES` now
   * that the registry also carries `create_event`; D7). */
  allowedTools?: readonly AiMcpToolName[];
  /** Per-turn MCP registration context, passed VERBATIM to
   * `AiMcpListener#registerTurn` (auto-generate-event-logs D6/D7): the turn's
   * server-side tool set, plus — on event-generation turns (task 4.3) — the
   * run snapshot, or — on the topic one-shot — its `pagedWords` word snapshot
   * (topic-generate-paged-transcript D1/D2), the field that keys paged
   * transcript delivery and the `pageCoverage` below.
   * `ai/chat` and `topics/generate` both pass an explicit
   * `{tools}` matching their argv allowlist (task 3.4), so the server-side
   * registration is belt to the argv's braces; omit ⇒ `registerTurn`'s pinned
   * context-less default (the three chat tools). */
  mcpContext?: AiMcpTurnContext;
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

/** `driveAiTurn`'s outcome (auto-generate-event-logs task 4.3): the turn
 * outcome PLUS the turn's `createdEvents` count, read from the MCP turn
 * registration before it is disposed. This return-widening is the deliberate
 * smallest seam for the generate route's `{created, cap_hit}` response —
 * chosen over surfacing the whole `AiMcpTurn` handle, whose other fields
 * (url/token/dispose) are lifecycle state this helper alone must own. The
 * union is distributed so `outcome.ok` narrowing keeps working at callers.
 * Always 0 on chat/topic turns (their registrations never expose
 * `create_event`).
 *
 * `pageCoverage` rides the SAME seam (topic-generate-paged-transcript D6): how
 * many pages of the turn's transcript word snapshot were served, against the
 * snapshot's total. `topics/generate` gates its crash-safe swap on complete
 * coverage; a turn whose registration carried no snapshot reports
 * `{totalPages: 0, servedPages: 0}` and makes no claim. */
type WithTurnBookkeeping<T> = T & {
  createdEvents: number;
  pageCoverage: AiMcpPageCoverage;
};
export type DriveAiTurnResult =
  | WithTurnBookkeeping<Extract<AiChatTurnOutcome, { ok: true }>>
  | WithTurnBookkeeping<Extract<AiChatTurnOutcome, { ok: false }>>;

/**
 * Drive one AI turn's full lifecycle: MCP listener + registration → spawn →
 * run-to-outcome → the full no-orphan cleanup. Never throws — any setup or
 * run exception is caught, scrubbed to a single `internal-error` emit, and
 * returned as `{ ok: false, detail: 'internal-error' }`, matching `ai/chat`'s
 * pre-extraction catch-clause exactly.
 */
export async function driveAiTurn(opts: DriveAiTurnOptions): Promise<DriveAiTurnResult> {
  let mcpTurn: AiMcpTurn | null = null;
  let spawned: AiChatSpawnResult | null = null;
  try {
    const listener = await getAiMcpListener(opts.registry);
    const turn = listener.registerTurn(opts.sessionId, opts.mcpContext);
    mcpTurn = turn;
    spawned = spawnAiChatTurn({
      cliPath: opts.cliPath,
      sessionId: opts.sessionId,
      message: opts.message,
      mcpTurn: { url: turn.url, token: turn.token },
      maxBudgetUsd: opts.maxBudgetUsd,
      resumeSessionId: opts.resumeSessionId,
      allowedTools: opts.allowedTools,
      systemPrompt: opts.systemPrompt,
    });
    const outcome = await runAiChatTurn({
      child: spawned.child,
      emit: opts.emit,
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    });
    // Read the counters BEFORE the finally's dispose runs (they would read
    // correctly after dispose too — they live on closures the registration
    // drop doesn't clear — but reading here keeps the contract independent of
    // that detail).
    return {
      ...outcome,
      createdEvents: turn.createdEvents(),
      pageCoverage: turn.pageCoverage(),
    };
  } catch {
    // Any unexpected failure setting up or running the turn (e.g. the MCP
    // listener failing to start, or spawnAiChatTurn's cwd/config write
    // throwing) still owes the caller exactly one terminal event — never the
    // raw exception message (a secrecy leak the spec forbids).
    await opts.emit({ event: 'error', data: { detail: 'internal-error' } });
    return {
      ok: false,
      detail: 'internal-error',
      createdEvents: mcpTurn?.createdEvents() ?? 0,
      pageCoverage: mcpTurn?.pageCoverage() ?? NO_PAGE_COVERAGE,
    };
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
