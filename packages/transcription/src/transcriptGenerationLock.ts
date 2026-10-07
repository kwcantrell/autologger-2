// Per-session transcript generation runs (run-status-and-sweeper D3; was the process-wide single
// slot of transcript-gen-lock-status D1). At most one run per session in this process, any number
// of sessions at once; the session's `transcript-generation` run lease excludes other processes.
// Cleared in the route's `finally` so a session cannot wedge busy across requests.

export class TranscriptGenerationRuns {
  private readonly runs = new Map<string, number>();

  /** Claim the run of `sessionId`. Returns false when that session already runs here. */
  tryAcquire(sessionId: string, nowMs: number = Date.now()): boolean {
    if (this.runs.has(sessionId)) return false;
    this.runs.set(sessionId, nowMs);
    return true;
  }

  /** When this process started the run of `sessionId`, or null when it runs none. */
  startedAt(sessionId: string): number | null {
    return this.runs.get(sessionId) ?? null;
  }

  /** Free the run of `sessionId`; a no-op when it runs none. */
  release(sessionId: string): void {
    this.runs.delete(sessionId);
  }

  /** Test-only: drop every run so the module singleton does not leak across cases. */
  reset(): void {
    this.runs.clear();
  }
}

/** Process singleton, shared by the generate route and log-import. The name is kept from the
 * single-slot lock so imports don't churn (run-status-and-sweeper D3). */
export const transcriptGenerationLock = new TranscriptGenerationRuns();

/** Build the frozen `{detail}` string for a concurrent generate (design D6). */
export function generationInFlightDetail(
  sessionId: string,
  sessionTitle: string | null,
  startedAtMs: number,
): string {
  const name = sessionTitle?.trim() ? sessionTitle.trim() : sessionId;
  const started = new Date(startedAtMs).toISOString();
  return (
    `A transcript generation run is already in progress for session "${name}" ` +
    `(started ${started}); try again once it completes.`
  );
}
