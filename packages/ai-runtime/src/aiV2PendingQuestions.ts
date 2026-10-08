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
//
// shared-request-state D2 (ADR 0021 slice 9b): each question is also a kv row
// (`ai-v2-question:` + the JSON key, `{v:1, state, principalUserId,
// questionCount}`), so `resolveAnswer` works on any server process with one
// compare-and-swap; the turn's own process polls its rows every 500 ms and
// resolves the local promise. The registry is built per server binding.

import { randomBytes } from 'node:crypto';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AiV2AnswerItem } from '@autologger/contract';
import type { Clock, KvStore } from '@autologger/ports';

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
  /** The kv row's key (shared-request-state D2). */
  readonly rowKey: string;
  /** The raw `AskUserQuestion` tool input, kept so the poll that picks up an
   * answer can rebuild a same-shape `updatedInput` (question text -> answer)
   * without the answer route needing to resend the original question text. */
  readonly originalInput: Record<string, unknown>;
  readonly resolve: (result: PermissionResult) => void;
}

/** The kv row of one pending question (shared-request-state D2). `principalUserId` is the user id
 * of the principal that INITIATED the turn (D7). `null` would mean a turn initiated over a
 * principal-less auth mechanism. None remains: the retired API_TOKEN path was the only one, and
 * companion-devices (ADR 0021 slice 9d) removed it — a Companion device call has a user and never
 * reaches AI v2. The type keeps `null` as a safe default: `null` can never equal an answering
 * `user.id` (always a non-empty string), so such a turn's questions would be structurally
 * unanswerable by anyone and simply abandon on timeout — a safe degraded state, not a bypass. */
type QuestionRow =
  | { v: 1; state: 'pending'; principalUserId: string | null; questionCount: number }
  | {
      v: 1;
      state: 'answered';
      principalUserId: string | null;
      questionCount: number;
      answers: AiV2AnswerItem[];
    };

/** `JSON.stringify` of the 3-tuple — collision-free regardless of what
 * characters `sessionId` (an attacker-controlled route param) contains. A
 * hand-picked string delimiter would let a crafted `sessionId` embedding
 * the delimiter collide two DIFFERENT (session, turn, request) triples onto
 * the same key; JSON array encoding has no such ambiguity. The kv row key is
 * this with the `ai-v2-question:` prefix (shared-request-state D2). */
function keyOf(key: PendingQuestionKey): string {
  return JSON.stringify([key.sessionId, key.turnId, key.requestId]);
}

const ROW_PREFIX = 'ai-v2-question:';
/** How often the turn's process reads its pending rows (shared-request-state D2). */
export const AI_V2_QUESTION_POLL_MS = 500;
/** A row outlives its turn's deadline by this much, then expires on its own. */
const ROW_GRACE_MS = 5_000;
/** How long an abandoned turn is remembered, so a register still storing its row deletes it. */
const ABANDONED_MEMORY_MS = 60_000;
const ABANDONED_MESSAGE = 'The design turn ended before this question was answered.';

function rowKeyOf(key: PendingQuestionKey): string {
  return ROW_PREFIX + keyOf(key);
}

function turnKeyOf(sessionId: string, turnId: string): string {
  return JSON.stringify([sessionId, turnId]);
}

function parseRow(raw: string): QuestionRow | null {
  try {
    const row = JSON.parse(raw) as QuestionRow | null;
    return row?.v === 1 ? row : null;
  } catch {
    return null;
  }
}

function questionCountOf(input: Record<string, unknown>): number {
  const rawQuestions = (input as { questions?: unknown }).questions;
  return Array.isArray(rawQuestions) ? rawQuestions.length : 0;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/**
 * The pending-question registry over the KvStore port, built per server binding (shared-request-state
 * D2; the former process-wide singleton is gone). Each question is a kv row any process can answer;
 * the process running the turn holds the local resolver and polls its rows every 500 ms.
 */
export class AiV2PendingQuestionRegistry {
  private readonly pending = new Map<string, PendingQuestionEntry>();
  /** One poller per turn with pending questions (keyed by `turnKeyOf`). */
  private readonly pollers = new Map<
    string,
    { timer: ReturnType<typeof setInterval>; busy: boolean }
  >();
  /** Recently abandoned turns (turn key -> when to forget it), so a `register` still storing its
   * row when its turn ends deletes the row instead of arming it (shared-request-state D2,
   * consistency read). A store takes milliseconds; a minute of memory is ample. */
  private readonly abandoned = new Map<string, number>();

  constructor(
    private readonly kv: KvStore,
    private readonly clock: Clock,
    private readonly pollMs: number = AI_V2_QUESTION_POLL_MS,
  ) {}

  /**
   * Register a pending question: store its kv row first (expiring at the turn's deadline plus
   * 5 s), and only then add the local entry and start or extend the turn's poller. Throws if the
   * row cannot be stored, before anything local exists (the caller denies without emitting).
   * The returned `result` resolves ONLY when a poll picks up an accepted answer, the row vanishes,
   * or `abandonTurn` runs (disconnect/timeout); never on its own, so an answer that never arrives
   * blocks the turn until the timeout backstop (spec "Subprocess and turn lifecycle") aborts it.
   */
  async register(
    key: PendingQuestionKey,
    principalUserId: string | null,
    originalInput: Record<string, unknown>,
    turnDeadlineMs: number,
  ): Promise<{ result: Promise<PermissionResult> }> {
    const rowKey = rowKeyOf(key);
    const row: QuestionRow = {
      v: 1,
      state: 'pending',
      principalUserId,
      questionCount: questionCountOf(originalInput),
    };
    const ttlS = Math.max(1, Math.ceil((turnDeadlineMs + ROW_GRACE_MS - this.clock.now()) / 1000));
    const turnKey = turnKeyOf(key.sessionId, key.turnId);
    this.pruneAbandoned();
    if (this.abandoned.has(turnKey)) throw new Error('the design turn already ended');
    await this.kv.put(rowKey, JSON.stringify(row), { expirationTtl: ttlS });
    if (this.abandoned.has(turnKey)) {
      // The turn ended while the row was being stored: delete it and arm nothing.
      void this.kv.delete(rowKey).catch((err: unknown) => {
        console.warn(`[ai-v2] could not delete an abandoned question row (${errText(err)})`);
      });
      throw new Error('the design turn ended while its question was being stored');
    }
    const result = new Promise<PermissionResult>((resolve) => {
      this.pending.set(keyOf(key), {
        sessionId: key.sessionId,
        turnId: key.turnId,
        rowKey,
        originalInput,
        resolve,
      });
    });
    this.startPoller(key.sessionId, key.turnId);
    return { result };
  }

  /** True iff a matching LOCAL pending entry exists — test/introspection only. */
  has(key: PendingQuestionKey): boolean {
    return this.pending.has(keyOf(key));
  }

  /** In-flight local pending-question count across all turns (introspection / tests). */
  size(): number {
    return this.pending.size;
  }

  /** The kv row's state, or null if it is gone — test/introspection only. */
  async rowState(key: PendingQuestionKey): Promise<QuestionRow['state'] | null> {
    const raw = await this.kv.get(rowKeyOf(key));
    return raw === null ? null : (parseRow(raw)?.state ?? null);
  }

  /**
   * Record a validated answer, on any process. Returns `'accepted'` once the row was swapped from
   * pending to answered (the turn's process picks it up on its next poll). Returns `'not-found'` —
   * deliberately the SAME outcome — for every failure mode: no row for this (sessionId, turnId,
   * requestId) — a foreign/garbage id, or a late answer after the turn ended and its row was
   * deleted — a row no longer pending, a row whose recorded principal does not match
   * `answeringPrincipalUserId` (D7's post-gate correction: a co-member with session access must
   * not learn whether they guessed a wrong id or are answering someone else's question —
   * anti-enumeration), an answer count that does not match the question count
   * (`buildAnswerPermissionResult` zips answers to questions positionally), or a lost race
   * against a concurrent answer (the compare-and-swap). A kv error rejects (the route's 500).
   */
  async resolveAnswer(
    key: PendingQuestionKey,
    answeringPrincipalUserId: string,
    answers: readonly AiV2AnswerItem[],
  ): Promise<'accepted' | 'not-found'> {
    const rowKey = rowKeyOf(key);
    const raw = await this.kv.get(rowKey);
    if (raw === null) return 'not-found';
    const row = parseRow(raw);
    if (row?.state !== 'pending') return 'not-found';
    if (row.principalUserId === null || row.principalUserId !== answeringPrincipalUserId) {
      return 'not-found';
    }
    if (answers.length !== row.questionCount) return 'not-found';
    const answered: QuestionRow = { ...row, state: 'answered', answers: [...answers] };
    const swapped = await this.kv.replaceIf(rowKey, raw, JSON.stringify(answered));
    return swapped ? 'accepted' : 'not-found';
  }

  /**
   * Abandon every pending question registered for one turn — called from
   * `runDesignTurn`'s lifecycle `finally` on EVERY exit path (spec: "the
   * pending entry SHALL be deleted when its turn ends by any path, so it
   * cannot be resolved late"). Denies each local entry at once (never left
   * hanging), stops the turn's poller, and deletes the rows fire-and-forget;
   * a failed delete is logged and the row expires at the turn's deadline.
   */
  abandonTurn(sessionId: string, turnId: string): void {
    this.pruneAbandoned();
    this.abandoned.set(turnKeyOf(sessionId, turnId), this.clock.now() + ABANDONED_MEMORY_MS);
    this.stopPoller(sessionId, turnId);
    for (const [k, entry] of this.pending) {
      if (entry.sessionId !== sessionId || entry.turnId !== turnId) continue;
      this.pending.delete(k);
      entry.resolve({ behavior: 'deny', message: ABANDONED_MESSAGE });
      void this.kv.delete(entry.rowKey).catch((err: unknown) => {
        console.warn(`[ai-v2] could not delete an abandoned question row (${errText(err)})`);
      });
    }
  }

  private pruneAbandoned(): void {
    const now = this.clock.now();
    for (const [turnKey, forgetAt] of this.abandoned) {
      if (forgetAt <= now) this.abandoned.delete(turnKey);
    }
  }

  private entriesOf(turnKey: string): Array<[string, PendingQuestionEntry]> {
    return [...this.pending].filter(([, e]) => turnKeyOf(e.sessionId, e.turnId) === turnKey);
  }

  private startPoller(sessionId: string, turnId: string): void {
    const turnKey = turnKeyOf(sessionId, turnId);
    if (this.pollers.has(turnKey)) return;
    const poller = {
      timer: setInterval(() => {
        void this.tick(turnKey);
      }, this.pollMs),
      busy: false,
    };
    poller.timer.unref?.();
    this.pollers.set(turnKey, poller);
  }

  private stopPoller(sessionId: string, turnId: string): void {
    const turnKey = turnKeyOf(sessionId, turnId);
    const poller = this.pollers.get(turnKey);
    if (!poller) return;
    clearInterval(poller.timer);
    this.pollers.delete(turnKey);
  }

  /** One poll of a turn's rows: an answered row is taken and resolves its question; a missing
   * row denies it, as abandoned; a read that throws is logged and retried next tick. Never
   * rejects; skips a tick while the previous one still runs. */
  private async tick(turnKey: string): Promise<void> {
    const poller = this.pollers.get(turnKey);
    if (!poller || poller.busy) return;
    poller.busy = true;
    try {
      for (const [k, entry] of this.entriesOf(turnKey)) {
        try {
          const raw = await this.kv.get(entry.rowKey);
          if (this.pending.get(k) !== entry) continue; // abandoned meanwhile
          if (raw === null) {
            this.settle(k, entry, { behavior: 'deny', message: ABANDONED_MESSAGE });
            continue;
          }
          if (parseRow(raw)?.state !== 'answered') continue;
          const taken = await this.kv.take(entry.rowKey);
          if (this.pending.get(k) !== entry) continue;
          const row = taken === null ? null : parseRow(taken);
          this.settle(
            k,
            entry,
            row?.state === 'answered'
              ? buildAnswerPermissionResult(entry.originalInput, row.answers)
              : { behavior: 'deny', message: ABANDONED_MESSAGE },
          );
        } catch (err) {
          console.warn(`[ai-v2] question poll failed; retrying (${errText(err)})`);
        }
      }
    } finally {
      poller.busy = false;
      if (this.entriesOf(turnKey).length === 0 && this.pollers.get(turnKey) === poller) {
        clearInterval(poller.timer);
        this.pollers.delete(turnKey);
      }
    }
  }

  private settle(k: string, entry: PendingQuestionEntry, result: PermissionResult): void {
    this.pending.delete(k);
    entry.resolve(result);
  }
}

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
  /** The turn's deadline (its start plus its timeout): the kv row expires 5 s after it. */
  turnDeadlineMs: number;
  /** The binding's registry (`c.env.ports.aiV2Questions`, shared-request-state D2). */
  registry: AiV2PendingQuestionRegistry;
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
  const { registry } = params;
  return async (input: Record<string, unknown>) => {
    const requestId = generatePendingQuestionId();
    let pending: { result: Promise<PermissionResult> };
    try {
      // The row is stored before the question goes out (shared-request-state D2), so a fast
      // answer on any process finds it.
      pending = await registry.register(
        { sessionId: params.sessionId, turnId: params.turnId, requestId },
        params.principalUserId,
        input,
        params.turnDeadlineMs,
      );
    } catch (err) {
      console.warn(`[ai-v2] could not record a design question; denying it (${errText(err)})`);
      return { behavior: 'deny', message: 'The question could not be recorded.' };
    }
    await params.emitQuestion({
      requestId,
      turnId: params.turnId,
      questions: stripPreviewForRelay(input),
    });
    return pending.result;
  };
}
