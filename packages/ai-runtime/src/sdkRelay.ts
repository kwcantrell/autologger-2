// The AI SDK turn's stream mapping (ai-sdk-agent-harness design D3, "Stream mapping"):
//
// | Part                                                       | Emitted          |
// | ---------------------------------------------------------- | ---------------- |
// | `text-delta`                                               | `delta {text}`   |
// | `tool-call`, not `invalid`, with a name in the turn's set  | `tool {name}`    |
// | `tool-call` otherwise (an undefined or invented name, A28) | nothing          |
// | `error`                                                    | recorded         |
// | everything else, `reasoning-*` included                    | nothing          |
//
// The terminal event (`done` / `error`) is not emitted here: the turn decides its ending from its
// own step records (`decideSdkEnding`), after the stream ends. The iteration is wrapped, because a
// provider stream dropped mid-response throws from `fullStream` instead of emitting an `error`
// part (A27); a throw is recorded as an error. Neither the part's error nor the thrown value is
// kept, logged or forwarded (D5).

import type { AiChatSseEvent } from './aiChatRelay';

/** The fields of a stream part this relay reads (a structural subset of the SDK's `TextStreamPart`). */
export interface SdkStreamPart {
  type: string;
  text?: string;
  toolName?: string;
  invalid?: boolean;
}

export interface SdkRelayOptions {
  emit: (event: AiChatSseEvent) => Promise<void>;
  /** The turn's tool names: only these are relayed as `tool`. */
  toolNames: ReadonlySet<string>;
}

/** Relay one turn's `fullStream`. Never throws; resolves with whether the stream errored. */
export async function relaySdkStream(
  stream: AsyncIterable<SdkStreamPart>,
  opts: SdkRelayOptions,
): Promise<{ errored: boolean }> {
  let errored = false;
  try {
    for await (const part of stream) {
      if (part.type === 'text-delta') {
        if (typeof part.text === 'string' && part.text.length > 0) {
          await opts.emit({ event: 'delta', data: { text: part.text } });
        }
      } else if (part.type === 'tool-call') {
        if (
          part.invalid !== true &&
          typeof part.toolName === 'string' &&
          opts.toolNames.has(part.toolName)
        ) {
          await opts.emit({ event: 'tool', data: { name: part.toolName } });
        }
      } else if (part.type === 'error') {
        errored = true;
      }
    }
  } catch {
    errored = true;
  }
  return { errored };
}

/** How a turn ended (design D3 ending table). */
export type SdkTurnEnding = 'breach' | 'abort' | 'error' | 'capped' | 'incomplete' | 'natural';

/** One finished step, as the turn records it. */
export interface SdkStepRecord {
  toolCalls: number;
  toolResults: number;
  finishReason: string;
}

export interface SdkEndingInput {
  /** A tool-call cap or a guarded-fetch cap was passed. */
  breach: boolean;
  /** The turn's internal signal was aborted (the route's abort or timeout, when not a breach). */
  aborted: boolean;
  /** An `error` part arrived, or `fullStream` threw. */
  errored: boolean;
  /** The step cap stopped the loop. */
  stepCapFired: boolean;
  /** The token budget stopped the loop. */
  budgetFired: boolean;
  steps: readonly SdkStepRecord[];
}

const INCOMPLETE_REASONS = new Set(['length', 'content-filter', 'error', 'other']);

/**
 * The ending, checked in the design's order: breach, abort, error, capped, incomplete, natural.
 * "Capped" is the step cap or the budget stopping the loop (the SDK evaluates stop conditions only
 * after a step whose tool calls all ran), or a last step that still had tool calls. A last step
 * whose finish reason is `length`, `content-filter`, `error` or `other` is incomplete even when it
 * carried a call the SDK never ran; both endings fail a generation turn and end a chat turn `done`.
 */
export function decideSdkEnding(i: SdkEndingInput): SdkTurnEnding {
  if (i.breach) return 'breach';
  if (i.aborted) return 'abort';
  if (i.errored) return 'error';
  if (i.stepCapFired || i.budgetFired) return 'capped';
  const last = i.steps.at(-1);
  if (last === undefined) return 'error';
  if (INCOMPLETE_REASONS.has(last.finishReason)) return 'incomplete';
  if (last.toolCalls > 0) return 'capped';
  return 'natural';
}
