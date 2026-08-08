// ai-v2-dashboards (design D7, spec "Design question round trip") — the
// pending-question registry: the server-side half of the `canUseTool` round
// trip for `AskUserQuestion`. Keyed by (sessionId, turnId, requestId) —
// NEVER a bare request id — and additionally binding the PRINCIPAL that
// initiated the turn, not merely the session, per the panel's post-gate
// correction: an answer determines what gets built and stored, so access to
// the session alone must not authorize answering another user's question
// (the predecessor's resume-id hole, carried forward and fixed here).
//
// Turn/request ids are ≥128-bit CSPRNG, matching the `aiMcpServer.ts`
// bearer-token precedent (`randomBytes(...).toString('hex')`) — guessing is
// not the operative defense; the principal binding is.
//
// Lifecycle:
//   - `register` is called from the design turn's `onQuestion` handler
//     (wired in aiV2.ts) when `AskUserQuestion` fires. It returns the
//     Promise `canUseTool` blocks on.
//   - `resolveAnswer` is called from `POST …/ai/v2/answer` on a validated,
//     principal-correct answer.
//   - `abandonTurn` is called from `runDesignTurn`'s lifecycle `finally` on
//     EVERY exit path (completion, timeout, client disconnect) so an
//     unanswered question never wedges the turn's concurrency slot open
//     (the predecessor's slot-leak hazard, D7: "not hygiene") and a pending
//     entry cannot be resolved late.

import { randomBytes } from 'node:crypto';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AiV2AnswerItem } from '@autologger/contract';

/** 16 bytes = 128 bits — the spec's stated floor ("at least 128 bits of
 * entropy"). Mirrors `aiMcpServer.ts`'s bearer-token construction
 * (`randomBytes(TOKEN_BYTES).toString('hex')`), which uses 32 bytes for
 * comfortable headroom on a longer-lived token; a request/turn id here is
 * single-use and short-lived, so 16 bytes (exactly the spec's floor) is
 * sufficient and keeps ids shorter on the wire. */
const ID_BYTES = 16;

/** A ≥128-bit CSPRNG id for a turn or a pending question request — the
 * SAME construction for both, since both are named explicitly in the spec's
 * entropy requirement ("Turn and request identifiers SHALL be generated
 * with at least 128 bits of entropy"). */
export function generatePendingQuestionId(): string {
  return randomBytes(ID_BYTES).toString('hex');
}

export interface PendingQuestionKey {
  sessionId: string;
  turnId: string;
  requestId: string;
}

interface PendingQuestionEntry {
  readonly sessionId: string;
  readonly turnId: string;
  /** The user id of the principal that INITIATED the turn (D7). `null` for
   * a turn initiated over a principal-less auth mechanism (the API_TOKEN
   * device-token path — `requireSession` skips the studio check there
   * because there is no individual to scope it to; see aiV2.ts). `null`
   * can never equal an answering `user.id` (always a non-empty string), so
   * such a turn's questions are structurally unanswerable by anyone and
   * simply abandon on timeout — a safe degraded state, not a bypass. */
  readonly principalUserId: string | null;
  /** The raw `AskUserQuestion` tool input, kept so `resolveAnswer` can
   * rebuild a same-shape `updatedInput` (question text -> answer) without
   * the answer route needing to resend the original question text. */
  readonly originalInput: Record<string, unknown>;
  readonly resolve: (result: PermissionResult) => void;
}

/** `JSON.stringify` of the 3-tuple — collision-free regardless of what
 * characters `sessionId` (an attacker-controlled route param) contains. A
 * hand-picked string delimiter would let a crafted `sessionId` embedding
 * the delimiter collide two DIFFERENT (session, turn, request) triples onto
 * the same map key; JSON array encoding has no such ambiguity. */
function keyOf(key: PendingQuestionKey): string {
  return JSON.stringify([key.sessionId, key.turnId, key.requestId]);
}

/**
 * Build the `AskUserQuestion` `updatedInput` an `'allow'` `PermissionResult`
 * carries, from the caller's validated per-question answers. Shaped after
 * the SDK's own `AskUserQuestionOutput` (`sdk-tools.d.ts`): `answers` maps
 * each question's text to its answer string, and free text additionally
 * rides the top-level `response` field — NOT independently verified against
 * a live turn (no live SDK turn is in scope for these hermetic tests; see
 * the task report's residuals).
 *
 * A catalog-option answer's value is the catalog widget-type id itself,
 * already validated against the closed catalog by `aiV2AnswerRequestSchema`
 * before this ever runs (spec "Previews reflect the rendered result":
 * "resolving an option to its component is an exact lookup", never an
 * inference from agent-authored display text) — a free-text answer is a
 * DIFFERENT shape (`kind: 'text'`), never silently coerced into one.
 */
export function buildAnswerPermissionResult(
  originalInput: Record<string, unknown>,
  answers: readonly AiV2AnswerItem[],
): PermissionResult {
  const rawQuestions = (originalInput as { questions?: unknown }).questions;
  const questions = Array.isArray(rawQuestions) ? rawQuestions : [];
  const answerMap: Record<string, string> = {};
  let freeTextResponse: string | undefined;
  answers.forEach((answer, i) => {
    const q = questions[i] as { question?: unknown } | undefined;
    const questionText = typeof q?.question === 'string' ? q.question : `question_${i}`;
    if (answer.kind === 'option') {
      answerMap[questionText] = answer.widgetType;
    } else {
      answerMap[questionText] = answer.text;
      freeTextResponse = answer.text;
    }
  });
  return {
    behavior: 'allow',
    updatedInput: {
      ...originalInput,
      answers: answerMap,
      ...(freeTextResponse !== undefined ? { response: freeTextResponse } : {}),
    },
  };
}

/** The single flattened question shape `stripPreviewForRelay` produces —
 * the SAME shape `DesignQuestionEmitPayload.questions` carries over the wire
 * (Phase-3 fix wave: the payload used to double-nest this array one level
 * deeper than necessary; flattened here so there is exactly one `questions`
 * key between the SDK's raw tool input and the relayed SSE payload). */
export interface RelayedQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<Record<string, unknown>>;
}

/**
 * Strip any agent-supplied `preview` content from `AskUserQuestion` options
 * before relaying to a client (spec "Subprocess security lockdown": "any
 * preview content supplied by the agent on a question option SHALL be
 * discarded before the question is relayed to a client" — previews are
 * produced by this application's own components, D3, never agent markup).
 * Returns the flattened array of questions directly (not wrapped in another
 * `{ questions }` object — callers that need the wrapper, e.g. the wire
 * payload, add it themselves). Defensive against a malformed/unexpected
 * input shape; never throws.
 */
export function stripPreviewForRelay(input: Record<string, unknown>): RelayedQuestion[] {
  const rawQuestions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions.map((q) => {
    const question = (q ?? {}) as Record<string, unknown>;
    const rawOptions = question.options;
    const options = Array.isArray(rawOptions)
      ? rawOptions.map((o) => {
          const { preview: _preview, ...rest } = (o ?? {}) as Record<string, unknown>;
          return rest;
        })
      : [];
    return {
      question: typeof question.question === 'string' ? question.question : '',
      header: typeof question.header === 'string' ? question.header : '',
      multiSelect: Boolean(question.multiSelect),
      options,
    };
  });
}

export class AiV2PendingQuestionRegistry {
  private readonly pending = new Map<string, PendingQuestionEntry>();

  /**
   * Register a pending question. Returns the Promise the `onQuestion`
   * handler awaits — it resolves ONLY via `resolveAnswer` (a matching,
   * principal-correct answer) or `abandonTurn` (disconnect/timeout); never
   * on its own, so an answer that never arrives blocks the turn until the
   * timeout backstop (spec "Subprocess and turn lifecycle") aborts it.
   */
  register(
    key: PendingQuestionKey,
    principalUserId: string | null,
    originalInput: Record<string, unknown>,
  ): Promise<PermissionResult> {
    return new Promise((resolve) => {
      this.pending.set(keyOf(key), {
        sessionId: key.sessionId,
        turnId: key.turnId,
        principalUserId,
        originalInput,
        resolve,
      });
    });
  }

  /** True iff a matching pending entry exists — test/introspection only. */
  has(key: PendingQuestionKey): boolean {
    return this.pending.has(keyOf(key));
  }

  /** In-flight pending-question count across all turns (introspection / tests). */
  size(): number {
    return this.pending.size;
  }

  /**
   * Resolve a pending question with a validated answer. Returns `'ok'` on
   * success. Returns `'not-found'` — deliberately the SAME outcome — for
   * every failure mode: no entry at all for this (sessionId, turnId,
   * requestId) — a foreign/garbage id, or a late answer after the turn
   * already ended and the entry was abandoned — OR a real entry whose
   * recorded principal does not match `answeringPrincipalUserId` (D7's
   * post-gate correction: a co-member with session access must not learn,
   * from the response, whether they merely guessed a wrong id or are
   * answering someone else's pending question — anti-enumeration).
   *
   * Also returns `'not-found'` — the SAME invalid-answer rejection path,
   * NOT resolving the question — when the submitted answer count does not
   * match the number of questions actually pending for this entry (Phase-3
   * fix wave, defensive): `buildAnswerPermissionResult` zips `answers[i]` to
   * `questions[i]` positionally, so a mismatched count would otherwise
   * either fabricate a `question_${i}` key for an extra answer or silently
   * leave a trailing question unanswered.
   */
  resolveAnswer(
    key: PendingQuestionKey,
    answeringPrincipalUserId: string,
    answers: readonly AiV2AnswerItem[],
  ): 'ok' | 'not-found' {
    const k = keyOf(key);
    const entry = this.pending.get(k);
    if (!entry || entry.principalUserId !== answeringPrincipalUserId) return 'not-found';
    const rawQuestions = (entry.originalInput as { questions?: unknown }).questions;
    const pendingQuestionCount = Array.isArray(rawQuestions) ? rawQuestions.length : 0;
    if (answers.length !== pendingQuestionCount) return 'not-found';
    this.pending.delete(k);
    entry.resolve(buildAnswerPermissionResult(entry.originalInput, answers));
    return 'ok';
  }

  /**
   * Abandon every pending question registered for one turn — called from
   * `runDesignTurn`'s lifecycle `finally` on EVERY exit path (spec: "the
   * pending entry SHALL be deleted when its turn ends by any path, so it
   * cannot be resolved late"). Resolves each with a `deny` (never left
   * hanging indefinitely) and deletes the entry BEFORE resolving, so a
   * concurrently-arriving answer for the same id sees `resolveAnswer`
   * return `'not-found'`, never a race against this cleanup.
   */
  abandonTurn(sessionId: string, turnId: string): void {
    for (const [k, entry] of this.pending) {
      if (entry.sessionId !== sessionId || entry.turnId !== turnId) continue;
      this.pending.delete(k);
      entry.resolve({
        behavior: 'deny',
        message: 'The design turn ended before this question was answered.',
      });
    }
  }

  /** Test-only: drop all pending entries so the shared singleton doesn't
   * leak state across cases. Not used on any request path. */
  reset(): void {
    this.pending.clear();
  }
}

/** Process-wide singleton — the shared home the design-turn route and the
 * answer route both consume (single Node process invariant). */
export const aiV2PendingQuestions = new AiV2PendingQuestionRegistry();

export interface DesignQuestionEmitPayload {
  requestId: string;
  turnId: string;
  /** The flattened, preview-stripped question array — `stripPreviewForRelay`'s
   * direct return, ONE `questions` level below the payload (Phase-3 fix
   * wave: no longer double-nested as `questions: { questions: [...] }`). */
  questions: RelayedQuestion[];
}

export interface BuildPendingQuestionOnQuestionParams {
  sessionId: string;
  turnId: string;
  /** The user id of the principal that initiated this turn, or `null` for a
   * principal-less auth mechanism (see `PendingQuestionEntry.principalUserId`). */
  principalUserId: string | null;
  /** Relay the sanitized question to the ONE client that initiated this turn
   * — this turn's own SSE stream, never the session's WS fan-out (design
   * D6: a question SHALL NOT be broadcast to other clients attached to the
   * session — that fan-out reaches every browser tab AND Companion).
   * Errors are swallowed (a dead client stream); the abandonment path
   * (disconnect/timeout) still resolves and deletes the pending entry. */
  emitQuestion: (payload: DesignQuestionEmitPayload) => Promise<void> | void;
  /** Defaults to the process-wide singleton; injectable for hermetic tests. */
  registry?: AiV2PendingQuestionRegistry;
}

/**
 * Build the Phase-3 `onQuestion` handler `buildDesignTurnCanUseTool`
 * delegates to for `AskUserQuestion` (aiV2SdkSpawn.ts). Mints a fresh
 * ≥128-bit request id, registers the pending question bound to the
 * initiating principal, relays the preview-stripped question over this
 * turn's own SSE stream, and returns the Promise the `canUseTool` callback
 * blocks on until an answer or an abandonment condition resolves it.
 */
export function buildPendingQuestionOnQuestion(
  params: BuildPendingQuestionOnQuestionParams,
): (input: Record<string, unknown>) => Promise<PermissionResult> {
  const registry = params.registry ?? aiV2PendingQuestions;
  return async (input: Record<string, unknown>) => {
    const requestId = generatePendingQuestionId();
    const promise = registry.register(
      { sessionId: params.sessionId, turnId: params.turnId, requestId },
      params.principalUserId,
      input,
    );
    await params.emitQuestion({
      requestId,
      turnId: params.turnId,
      questions: stripPreviewForRelay(input),
    });
    return promise;
  };
}
