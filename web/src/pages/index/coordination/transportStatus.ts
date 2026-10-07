/**
 * The shell-level transport-status store (redesign-show-ignition D2).
 *
 * `SessionWorkspace` publishes the open session's transport state here; the
 * shell (`AppShell`'s `data-transport` attribute, and later the top bar's
 * status) reads it through `useSyncExternalStore`. Lifting the state into
 * AppShell instead would re-render the shell on workspace state changes and
 * invert ownership; writing `document.documentElement.dataset` from the
 * workspace would echo the retired `body.dataset.sessionId` spine.
 *
 * **Identity-scoped teardown**, as in `registry.ts` (web-coordination-seam
 * "Handler ownership is identity-scoped at teardown"): every publish names its
 * owner token, and `clearTransportStatus(owner)` resets to stopped only if
 * that owner is still the latest publisher. A stale owner's clear is a no-op.
 * There is deliberately no unconditional clear outside tests.
 *
 * **Transitions only.** A publish whose content equals the current snapshot
 * keeps the snapshot identity and notifies nobody, so readers re-render only
 * on a real state, session or title change — never on the playback tick
 * (web-ui-system "The playback tick is fenced at named memo boundaries").
 *
 * Import-free, like the registry.
 */

export type ShellTransportState = 'stopped' | 'rolling' | 'recording' | 'playback';

export interface TransportStatus {
  readonly state: ShellTransportState;
  readonly sessionId: string | null;
  readonly title: string | null;
}

/**
 * The status label for each state (web-session-console "Transport state tints the shell"). One
 * map, read by the top bar and the transport card's pill, so the two always say the same word.
 */
export const TRANSPORT_STATUS_LABEL: Readonly<Record<ShellTransportState, string>> = Object.freeze({
  stopped: 'STOPPED',
  rolling: 'ROLLING',
  recording: 'REC',
  playback: 'PLAY',
});

/** The snapshot with no session open, or after the current owner clears. */
export const STOPPED_TRANSPORT_STATUS: TransportStatus = Object.freeze({
  state: 'stopped',
  sessionId: null,
  title: null,
});

let snapshot: TransportStatus = STOPPED_TRANSPORT_STATUS;
let currentOwner: object | null = null;
const listeners = new Set<() => void>();

function setSnapshot(next: TransportStatus): void {
  if (
    next.state === snapshot.state &&
    next.sessionId === snapshot.sessionId &&
    next.title === snapshot.title
  ) {
    return;
  }
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/** Publish `status` as `owner`, which becomes the store's current owner. */
export function publishTransportStatus(owner: object, status: TransportStatus): void {
  currentOwner = owner;
  setSnapshot({ state: status.state, sessionId: status.sessionId, title: status.title });
}

/**
 * Reset to stopped, but only if `owner` is still the latest publisher
 * (identity-scoped teardown). A stale owner's clear does nothing.
 */
export function clearTransportStatus(owner: object): void {
  if (currentOwner !== owner) return;
  currentOwner = null;
  setSnapshot(STOPPED_TRANSPORT_STATUS);
}

/** `useSyncExternalStore` subscribe. */
export function subscribeTransportStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `useSyncExternalStore` snapshot: stable identity between transitions. */
export function getTransportStatus(): TransportStatus {
  return snapshot;
}

/** Tests only (`web/src/test/setup.ts` calls it in `afterEach`). */
export function resetTransportStatus(): void {
  currentOwner = null;
  snapshot = STOPPED_TRANSPORT_STATUS;
  listeners.clear();
}
