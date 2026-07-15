// AI-chat turn registry (ai-topics-chat, design D5) — the two-axis spend bound
// shared home. Guards a turn slot on two axes before any subprocess is spawned:
//   - per-autologger-session single-flight (a second turn on the same session is
//     rejected — the deliberately-looser scope than DeepGram's single global flag,
//     so independent sessions can chat concurrently), and
//   - a process-wide concurrency ceiling (AI_CHAT_MAX_CONCURRENT) so the operator's
//     Anthropic spend can't fan out unbounded.
// Module-level singleton, mirroring the DeepGram router's module-level flag; the
// per-request `maxConcurrent` is read from config and passed to tryAcquire so the
// registry stays config-agnostic. Phase 3's turn runner acquires here, holds the
// slot for the turn, and releases in a `finally` when the child exits.

export type AiChatAcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'session-busy' | 'at-capacity' };

export class AiChatTurnRegistry {
  private readonly inflightSessions = new Set<string>();
  private globalCount = 0;

  /** Atomically claim a turn slot for `sessionId`. Per-session single-flight is
   * checked before the global ceiling, so a repeat on a busy session always reads
   * as `session-busy`. Returns an idempotent `release` on success. Spawns nothing
   * — the caller only proceeds to spawn when `ok` is true. */
  tryAcquire(sessionId: string, maxConcurrent: number): AiChatAcquireResult {
    if (this.inflightSessions.has(sessionId)) return { ok: false, reason: 'session-busy' };
    if (this.globalCount >= maxConcurrent) return { ok: false, reason: 'at-capacity' };
    this.inflightSessions.add(sessionId);
    this.globalCount += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inflightSessions.delete(sessionId);
      this.globalCount -= 1;
    };
    return { ok: true, release };
  }

  /** In-flight turn count across all sessions (introspection / tests). */
  get activeCount(): number {
    return this.globalCount;
  }

  isSessionInFlight(sessionId: string): boolean {
    return this.inflightSessions.has(sessionId);
  }

  /** Test-only: drop all slots so a shared module singleton doesn't leak across
   * cases. Not used on any request path. */
  reset(): void {
    this.inflightSessions.clear();
    this.globalCount = 0;
  }
}

/** Process-wide singleton — the shared home Phase 3's turn runner consumes. */
export const aiChatTurns = new AiChatTurnRegistry();
