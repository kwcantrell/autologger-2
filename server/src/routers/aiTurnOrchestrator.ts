// code-health-consolidation (design D3, task 4.2) — THE shared OUTER turn
// orchestrator for both AI turn paths (`runAiChatTurn` in aiChatRunner.ts and
// `runDesignTurn` in aiV2SdkSpawn.ts). This is the genuinely shared clone the
// 2026-07-27 review found drifting twice (emit-throw handling,
// terminal-detail scrubbing): the timeout/abort/`Promise.race`/kill/finally
// scaffolding ONLY. The relay/message-translation is NOT symmetric (chat
// externalizes it over a `ChildProcess`'s stdout JSONL; v2 embeds
// SDK-message translation over an `AsyncIterable<SDKMessage>`) and stays
// per-path, injected through `runRelay`.
//
// The hook surface is CAPPED at FIVE injection points (design D3; the panel
// rejected a wider config framework for exactly two call sites as
// over-articulation): `runRelay`, `terminate`, `scrub`, `timeoutMs`,
// `onFinally`. `emit` and `abortSignal` are per-request I/O handed in by the
// route, not per-path policy — they are deliberately NOT counted as hooks,
// and nothing else may be added: a change that needs a sixth policy knob is a
// design change, not a parameter.
//
// Shared (NOT hook-injectable) semantics, common to both paths:
// - Exactly ONE terminal event (`done` XOR `error`) is ever emitted; a
//   best-effort client disconnect (abort) emits NO terminal event at all —
//   nobody is listening — but still claims the terminal slot so a late relay
//   emit is a no-op.
// - The emit guard applies `scrub` to EVERY event before it can reach the
//   client (the structural guard/scrub composition — v2's confidentiality
//   chokepoint) and swallows transport throws for both paths: an emit throw
//   must never skip the kill/cleanup below (the chat path's old propagation
//   pierced `driveAiTurn`'s "never throws" contract and could orphan the
//   child; convergence decided by the 2026-07-27 panel, not wire-observable).
// - `terminate` runs on EVERY exit path — including normal completion, where
//   it is a fast no-op confirmation — via the try/finally hardening (v2's,
//   adopted for both paths), and at most once.
// - The guaranteed `timeoutMs` backstop is INDEPENDENT of the relay (a relay
//   that never settles still ends the turn).

/** The structural shape both paths' SSE event unions satisfy. */
export interface AiTurnSseEventBase {
  event: string;
  data: Record<string, unknown>;
}

/** What `runRelay` hands back: the per-path relay promise plus this path's
 * DRAIN POLICY — a stated part of the hook contract (design D3), never an
 * implicit spine behavior:
 * - `'await-settle'` (chat): the scaffolding awaits the relay's settle on
 *   every path before resolving, which also guarantees the child handle is
 *   reaped — the "relay resolves only after child exit" property.
 * - `'detach'` (v2): the scaffolding must NOT await it — an aborted SDK
 *   iterator may never yield/settle; a late rejection is suppressed so the
 *   turn still ends and its cleanup runs. */
export interface AiTurnRelay<TOutcome> {
  relay: Promise<TOutcome>;
  drain: 'await-settle' | 'detach';
}

export interface RunOuterAiTurnOptions<
  TEvent extends AiTurnSseEventBase,
  TOutcome extends { ok: boolean },
> {
  // ── The five hooks (design D3 — the hard cap) ────────────────────────────
  /** Hook 1: start the per-path relay against the shared guarded emitter and
   * declare its drain policy (see `AiTurnRelay`). Called exactly once, before
   * the timeout starts racing. */
  runRelay: (guardedEmit: (event: TEvent) => Promise<void>) => AiTurnRelay<TOutcome>;
  /** Hook 2: terminate the turn's subprocess side. Chat wraps the shared
   * group-liveness kill ladder (design D2); v2 has no pid — its closure owns
   * the `abortController.abort()` calls (killing the pgid alone does not stop
   * the SDK's iterator) plus its spawner's group kill. Invoked at most once,
   * on EVERY exit path; any grace-window override is baked into the closure,
   * never a separate knob. */
  terminate: () => Promise<void>;
  /** Hook 3: applied BY the shared emit guard to EVERY event — the
   * guard/scrub composition is structural, not a per-call-site habit. Chat's
   * is the identity (its relay emits fixed literals, including
   * `'not-logged-in'`, that an allow-list would mangle); v2's stays its
   * four-literal allow-list rebuild (`scrubDesignTurnEvent`). */
  scrub: (event: TEvent) => TEvent;
  /** Hook 4: the GUARANTEED turn backstop in milliseconds. */
  timeoutMs: number;
  /** Hook 5: per-path cleanup run in the `finally`, on EVERY exit path,
   * after `terminate`. v2 carries its slot release +
   * `abandonPendingQuestions` (the every-exit-path abandon guarantee is
   * load-bearing — a pending AskUserQuestion must not survive its turn) +
   * config-dir cleanup; chat passes nothing (its slot release is
   * ROUTER-owned by deliberate seam, and its MCP/config cleanup lives in
   * `driveAiTurn`'s own finally). */
  onFinally?: () => void;

  // ── Per-request I/O (not hooks — see the module docstring) ───────────────
  /** The route's SSE writer. Only ever called through the emit guard. */
  emit: (event: TEvent) => Promise<void> | void;
  /** Best-effort client-disconnect signal (the SSE request's abort signal). */
  abortSignal?: AbortSignal;
}

/**
 * Orchestrate one AI turn's OUTER lifecycle: race the injected relay against
 * the guaranteed timeout and a best-effort client-disconnect signal, emit at
 * most one terminal event (scrubbed, transport-throw-safe), terminate the
 * subprocess side on every path, honor the relay's drain policy, and run the
 * per-path `onFinally` cleanup last. Returns the relay's own outcome when the
 * relay wins, or the scaffolding's `timeout`/`aborted` outcome otherwise.
 */
export async function runOuterAiTurn<
  TEvent extends AiTurnSseEventBase,
  TOutcome extends { ok: boolean },
>(
  opts: RunOuterAiTurnOptions<TEvent, TOutcome>,
): Promise<TOutcome | { ok: false; detail: 'timeout' | 'aborted' }> {
  let terminalSent = false;
  const guardedEmit = async (event: TEvent): Promise<void> => {
    if (terminalSent) return;
    // Every event — not just the ones call sites happen to construct
    // carefully — passes through the per-path scrub before it can reach the
    // client (a no-op for chat's identity scrub, and for v2's delta/done/
    // already-valid-error events).
    const safeEvent = opts.scrub(event);
    if (safeEvent.event === 'done' || safeEvent.event === 'error') terminalSent = true;
    try {
      await opts.emit(safeEvent);
    } catch {
      // The client transport is gone; the kill/cleanup paths below still run.
    }
  };

  const { relay, drain } = opts.runRelay(guardedEmit);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('timeout'), opts.timeoutMs);
  });
  const abortPromise = new Promise<'abort'>((resolve) => {
    const signal = opts.abortSignal;
    if (!signal) return; // never resolves — Promise.race simply never picks it.
    if (signal.aborted) {
      resolve('abort');
      return;
    }
    signal.addEventListener('abort', () => resolve('abort'), { once: true });
  });

  let terminated = false;
  const terminateOnce = async (): Promise<void> => {
    if (terminated) return;
    terminated = true;
    await opts.terminate();
  };

  try {
    const winner = await Promise.race([
      relay.then((outcome) => ({ kind: 'relay' as const, outcome })),
      timeoutPromise.then(() => ({ kind: 'timeout' as const })),
      abortPromise.then(() => ({ kind: 'abort' as const })),
    ]);
    clearTimeout(timeoutHandle);
    // Suppress a late relay rejection on the paths where the relay may
    // outlive the race (defensive — both paths' relays never reject by their
    // own contracts); `settled` is what the 'await-settle' drain awaits.
    const settled = relay.then(
      () => undefined,
      () => undefined,
    );

    if (winner.kind === 'timeout') {
      // Emit the timeout terminal BEFORE terminating — the terminal slot is
      // now claimed, so the relay's own eventual (post-kill) terminal emit
      // attempt is a guaranteed no-op. Downcast via the constraint: both
      // paths' event unions structurally include this exact frame
      // ({event:'error'} with Record data), which their scrubs pass through
      // unchanged (pinned by the task-1.3 timeout frame-sequence tests).
      const timeoutFrame: AiTurnSseEventBase = { event: 'error', data: { detail: 'timeout' } };
      await guardedEmit(timeoutFrame as TEvent);
    } else if (winner.kind === 'abort') {
      // Best-effort disconnect: emit nothing (a stream the server doesn't
      // complete MAY end with no terminal event — nobody's listening) but
      // still claim the terminal slot.
      terminalSent = true;
    }

    await terminateOnce();

    if (drain === 'await-settle') await settled;

    if (winner.kind === 'relay') return winner.outcome;
    if (winner.kind === 'timeout') return { ok: false, detail: 'timeout' };
    return { ok: false, detail: 'aborted' };
  } finally {
    clearTimeout(timeoutHandle);
    // No orphan on ANY exit path — including an unexpected throw above.
    await terminateOnce();
    opts.onFinally?.();
  }
}
