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
import { driveAiTurn, type DriveAiTurnResult } from './aiTurn';

/** D5's fixed one-shot user message. A plain user message, not a system
 * prompt. */
export const TOPIC_GENERATE_MESSAGE =
  'Read the full session transcript and generate a fresh, complete set of topics for it. ' +
  'Create a topic for every distinct subject covered, in chronological order.';

/** Dedicated one-shot generate system prompt (replaces the reused chat brief
 * for this turn). CRITICAL: it must NOT tell the model to check `list_topics`
 * before creating — that tool is withheld from the one-shot (D3), and the
 * reused chat brief's "check list_topics to avoid duplicates" instruction made
 * the real model create too few or ZERO topics (it tried the denied tool, then
 * declined to create). This prompt instead directs an unconditional, per-subject
 * generate. Verified against the real CLI by `topicGenerate.real.test.ts`. */
export const TOPIC_GENERATE_SYSTEM_PROMPT =
  "You are AutoLogger's topic generator for exactly one recording session. " +
  'Use get_transcript_words to read the ENTIRE session transcript, then use ' +
  'create_topic to add ONE topic for EACH distinct subject or segment discussed, ' +
  'in chronological order — an episode covering several subjects gets several ' +
  'topics, not a single overview. For each topic set session_time to an ' +
  'HH:MM:SS-style timecode where that subject begins, topic_level 1-10 for its ' +
  'importance, and a concise summary. Do NOT look up or check existing topics — ' +
  'generate a complete fresh set. Always create at least one topic. Stay focused ' +
  'on this one session and this one task.';

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
 * The outcome's `createdEvents` (auto-generate-event-logs task 4.3 widening)
 * is always 0 here — this turn's registration never exposes `create_event`.
 */
export async function generateTopicsTurn(
  opts: GenerateTopicsTurnOptions,
): Promise<DriveAiTurnResult> {
  return driveAiTurn({
    registry: opts.registry,
    cliPath: opts.cliPath,
    sessionId: opts.sessionId,
    message: TOPIC_GENERATE_MESSAGE,
    systemPrompt: TOPIC_GENERATE_SYSTEM_PROMPT,
    allowedTools: TOPIC_GENERATE_ALLOWED_TOOLS,
    // Explicit server-side registration mirroring the argv allowlist
    // (auto-generate-event-logs D7, task 3.4): the one-shot's MCP server now
    // also declines to REGISTER `list_topics`, so the withheld tool is denied
    // at the server — not only by CLI flags — and the registration no longer
    // rides the context-less default.
    mcpContext: { tools: TOPIC_GENERATE_ALLOWED_TOOLS },
    maxBudgetUsd: opts.maxBudgetUsd,
    timeoutMs: opts.timeoutMs,
    emit: () => {},
    // No abortSignal — design D2: the one-shot always runs to completion.
  });
}
