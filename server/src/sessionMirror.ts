// The session live projection's catalog mirror (catalog-concurrency-hazards D6; catalog-database
// "Session live projection is mirrored in order"). One promise chain per session: a call waits for
// a write that starts after it, and that write reads the hub's projection when it starts, so the
// latest committed state always lands last. A failed write only warns — the session change is
// already saved, and the next change rewrites all six columns. A write that timed out on the client
// may still run on the server, so the chain waits for it to settle before the next write.
import type { SessionProjection } from '@autologger/session-core';

export interface SessionMirrorDeps {
  snapshot: (sessionId: string) => SessionProjection;
  project: (sessionId: string, projection: SessionProjection) => Promise<void>;
  warn?: (line: string) => void;
}

export class SessionMirror {
  private readonly chains = new Map<string, { seq: number; tail: Promise<void> }>();
  private seq = 0;
  private closed = false;

  constructor(private readonly deps: SessionMirrorDeps) {}

  mirror(sessionId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const seq = ++this.seq;
    const prev = this.chains.get(sessionId)?.tail ?? Promise.resolve();
    const tail = prev.then(() => this.write(sessionId));
    this.chains.set(sessionId, { seq, tail });
    // Drop an idle chain; a later call has replaced the entry if one is queued.
    void tail.then(() => {
      if (this.chains.get(sessionId)?.seq === seq) this.chains.delete(sessionId);
    });
    return tail;
  }

  /** No write starts after this; resolves once the running ones finish. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.chains.values()].map((c) => c.tail));
  }

  private async write(sessionId: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.deps.project(sessionId, this.deps.snapshot(sessionId));
    } catch (e) {
      const err = e as { code?: unknown; name?: unknown; settled?: Promise<unknown> };
      const kind = typeof err?.code === 'string' ? err.code : String(err?.name ?? 'error');
      (this.deps.warn ?? console.warn)(
        `[mirror] session ${sessionId} live projection not written (${kind}); the next change rewrites it`,
      );
      if (err?.settled instanceof Promise) await err.settled.catch(() => {});
    }
  }
}
