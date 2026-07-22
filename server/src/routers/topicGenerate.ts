// topic-generation (design D2/D3/D5/D6, task 2.3) — the one-shot,
// non-conversational generate turn. Wraps `driveAiTurn` (task 2.1) with the
// three properties that make it a *generate* rather than a chat message:
//
//   - `list_topics` is WITHHELD from `--allowedTools` (only
//     `get_transcript_words` + `create_topic` are exposed) so the model
//     cannot dedup against the pre-run topics it is about to replace — this
//     is what turns the reused topics-assistant system prompt (which
//     otherwise tells the model to check `list_topics` first) into a
//     "generate fresh" turn, per D5's coupling note. This file's argv-shape
//     assertion (the unit test) is the load-bearing proof that the withheld
//     tool never reaches the spawned CLI — the crash-safe swap (D3) in the
//     route handler (task 3.1) depends on the model never seeing the prior
//     set, not merely on the handler's own bookkeeping.
//   - the message is a FIXED one-shot user message (D5) — never the
//     multi-turn chat's caller-supplied text.
//   - NO `abortSignal` is wired (D2) — a synchronous POST runs to completion
//     server-side so success-replace vs failure-restore stays deterministic
//     even across a mid-run client/proxy disconnect.
//
// `emit` is a no-op: the route handler (task 3.1) reads the *returned*
// `AiChatTurnOutcome`, never a stream (there is no SSE surface on
// `topics/generate` — design D2).

import type { SessionHubRegistry } from '../session/SessionHub';
import type { AiChatTurnOutcome } from './aiChatRunner';
import { driveAiTurn } from './aiTurn';

/** D5's fixed one-shot user message. A plain user message, not a system
 * prompt — the reused `--append-system-prompt` lockdown is unchanged. */
export const TOPIC_GENERATE_MESSAGE =
  'Read the full session transcript and generate a fresh, complete set of topics for it. ' +
  'Create a topic for every distinct subject covered, in chronological order.';

/** D3's narrowed allowlist for the one-shot: `list_topics` withheld. */
const TOPIC_GENERATE_ALLOWED_TOOLS = ['get_transcript_words', 'create_topic'] as const;

export interface GenerateTopicsTurnOptions {
  registry: SessionHubRegistry;
  /** `CLAUDE_CLI_PATH`, already trimmed. */
  cliPath: string;
  sessionId: string;
  maxBudgetUsd: number;
  timeoutMs: number;
}

/**
 * Run the one-shot topic-generation CLI turn to completion and return its
 * outcome. Never throws (matches `driveAiTurn`'s own never-throws contract).
 */
export async function generateTopicsTurn(
  opts: GenerateTopicsTurnOptions,
): Promise<AiChatTurnOutcome> {
  return driveAiTurn({
    registry: opts.registry,
    cliPath: opts.cliPath,
    sessionId: opts.sessionId,
    message: TOPIC_GENERATE_MESSAGE,
    allowedTools: TOPIC_GENERATE_ALLOWED_TOOLS,
    maxBudgetUsd: opts.maxBudgetUsd,
    timeoutMs: opts.timeoutMs,
    emit: () => {},
    // No abortSignal — design D2: the one-shot always runs to completion.
  });
}
