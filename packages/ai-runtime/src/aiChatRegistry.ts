// AI-chat turn registry (ai-topics-chat, design D5) — guards a turn slot before
// any subprocess is spawned: per-autologger-session single-flight (a second turn
// on the same session is rejected, so independent sessions can run concurrently).
// There is no process-wide ceiling: run-status-and-sweeper D2 removed the old
// AI_CHAT_MAX_CONCURRENT bound (owner decision 2).
// Module-level singleton, mirroring the DeepGram router's module-level flag. The
// turn runner acquires here, holds the slot for the turn, and releases in a
// `finally` when the child exits.

export type AiChatAcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'session-busy' };

export class AiChatTurnRegistry {
  private readonly inflightSessions = new Set<string>();

  /** Atomically claim a turn slot for `sessionId`. A repeat on a busy session
   * reads as `session-busy`. Returns an idempotent `release` on success. Spawns
   * nothing — the caller only proceeds to spawn when `ok` is true. */
  tryAcquire(sessionId: string): AiChatAcquireResult {
    if (this.inflightSessions.has(sessionId)) return { ok: false, reason: 'session-busy' };
    this.inflightSessions.add(sessionId);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inflightSessions.delete(sessionId);
    };
    return { ok: true, release };
  }

  /** In-flight turn count across all sessions (introspection / tests). */
  get activeCount(): number {
    return this.inflightSessions.size;
  }

  isSessionInFlight(sessionId: string): boolean {
    return this.inflightSessions.has(sessionId);
  }

  /** Test-only: drop all slots so a shared module singleton doesn't leak across
   * cases. Not used on any request path. */
  reset(): void {
    this.inflightSessions.clear();
  }
}

/** Process-wide singleton — the shared home the turn runners consume. */
export const aiChatTurns = new AiChatTurnRegistry();
