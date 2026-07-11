export interface PollerOptions<T> {
  intervalMs: number;
  maxBackoffMs?: number;
  fetchState: (signal: AbortSignal) => Promise<T>;
  onState: (s: T) => void;
  onError: (err: unknown) => void;
}

export class Poller<T> {
  private readonly opts: Required<Pick<PollerOptions<T>, 'maxBackoffMs'>> & PollerOptions<T>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private seq = 0;
  private applied = -1;
  private consecutiveErrors = 0;
  private stopped = true;
  private controller: AbortController | null = null;

  constructor(opts: PollerOptions<T>) {
    this.opts = { maxBackoffMs: 30000, ...opts };
  }

  start(): void {
    this.stopped = false;
    void this.pollOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
  }

  refreshNow(): void {
    if (this.stopped) return;
    if (this.inFlight) return; // coalesce: the in-flight fetch will deliver fresh state
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.pollOnce();
  }

  private schedule(): void {
    if (this.stopped) return;
    const backoff = Math.min(
      this.opts.maxBackoffMs,
      this.opts.intervalMs * 2 ** Math.min(this.consecutiveErrors, 6),
    );
    const delay = this.consecutiveErrors > 0 ? backoff : this.opts.intervalMs;
    this.timer = setTimeout(() => void this.pollOnce(), delay);
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    const mySeq = ++this.seq;
    this.controller = new AbortController();
    try {
      const state = await this.opts.fetchState(this.controller.signal);
      if (!this.stopped && mySeq > this.applied) {
        this.applied = mySeq;
        this.consecutiveErrors = 0;
        this.opts.onState(state);
      }
    } catch (err) {
      if (!this.stopped) {
        this.consecutiveErrors++;
        this.opts.onError(err);
      }
    } finally {
      this.inFlight = false;
      this.controller = null;
      this.schedule();
    }
  }
}
