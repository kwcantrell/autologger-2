// Process-wide single slot for transcript generation (transcript-gen-lock-status,
// design D1). At most one DeepGram run across every session; cleared in the
// route's `finally` so it cannot wedge true across requests.

export type TranscriptGenerationLockHolder = {
  sessionId: string;
  startedAtMs: number;
};

export class TranscriptGenerationLock {
  private holder: TranscriptGenerationLockHolder | null = null;

  /** Claim the slot for `sessionId`. Returns false when already held. */
  tryAcquire(sessionId: string, nowMs: number = Date.now()): boolean {
    if (this.holder !== null) return false;
    this.holder = { sessionId, startedAtMs: nowMs };
    return true;
  }

  getLock(): TranscriptGenerationLockHolder | null {
    return this.holder;
  }

  release(): void {
    this.holder = null;
  }

  /** Test-only: drop the slot so the module singleton does not leak across cases. */
  reset(): void {
    this.holder = null;
  }
}

/** Process-wide singleton — shared by generate and status routes. */
export const transcriptGenerationLock = new TranscriptGenerationLock();

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
