/**
 * Screen Wake Lock while recording (media-worker design D17; spec live-recording-chunks
 * "Recording keeps the screen awake and warns when hidden"). Best effort: a missing API or a
 * refused request (spike 0.3: headless Chromium and WebKit answer `NotAllowedError`) is logged
 * once and never an error. The browser drops the lock when the page is hidden, so it is
 * requested again when the document becomes visible while recording.
 */

export interface WakeLockSentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
}

export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface VisibilityDocumentLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface WakeLockDeps {
  wakeLock: WakeLockLike | null | undefined;
  doc: VisibilityDocumentLike;
  log: (message: string) => void;
}

export interface WakeLockController {
  /** Start holding the lock (recording started). Never rejects. */
  acquire(): Promise<void>;
  /** Stop holding it (recording stopped). Never rejects. */
  release(): Promise<void>;
  isHeld(): boolean;
}

export function createWakeLockController(deps: WakeLockDeps): WakeLockController {
  let active = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let logged = false;
  let listening = false;

  const logOnce = (message: string) => {
    if (logged) return;
    logged = true;
    deps.log(message);
  };

  async function request(): Promise<void> {
    if (!deps.wakeLock) {
      logOnce('Screen wake lock unavailable in this browser; recording continues without it.');
      return;
    }
    try {
      const s = await deps.wakeLock.request('screen');
      if (!active) {
        await s.release().catch(() => {});
        return;
      }
      sentinel = s;
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      const message = err instanceof Error ? err.message : String(err);
      logOnce(`Screen wake lock refused (${name}: ${message}); recording continues without it.`);
    }
  }

  const onVisibility = () => {
    if (!active || deps.doc.visibilityState !== 'visible') return;
    if (sentinel && !sentinel.released) return;
    sentinel = null;
    void request();
  };

  return {
    async acquire() {
      active = true;
      if (!listening) {
        listening = true;
        deps.doc.addEventListener('visibilitychange', onVisibility);
      }
      await request();
    },
    async release() {
      active = false;
      if (listening) {
        listening = false;
        deps.doc.removeEventListener('visibilitychange', onVisibility);
      }
      const s = sentinel;
      sentinel = null;
      if (s && !s.released) await s.release().catch(() => {});
    },
    isHeld() {
      return active && !!sentinel && !sentinel.released;
    },
  };
}

/** `navigator.wakeLock` when the browser has it. */
export function browserWakeLock(): WakeLockLike | null {
  const nav = (globalThis as { navigator?: { wakeLock?: WakeLockLike } }).navigator;
  return nav?.wakeLock && typeof nav.wakeLock.request === 'function' ? nav.wakeLock : null;
}
