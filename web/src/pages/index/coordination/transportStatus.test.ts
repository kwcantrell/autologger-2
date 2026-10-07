import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearTransportStatus,
  getTransportStatus,
  publishTransportStatus,
  resetTransportStatus,
  STOPPED_TRANSPORT_STATUS,
  subscribeTransportStatus,
} from './transportStatus';

// The shell-level transport-status store (redesign-show-ignition D2). Module
// singleton state, so every test resets it.
afterEach(() => {
  resetTransportStatus();
});

describe('transportStatus store', () => {
  it('reads stopped with no session before anything publishes', () => {
    expect(getTransportStatus()).toEqual({ state: 'stopped', sessionId: null, title: null });
    expect(getTransportStatus()).toBe(STOPPED_TRANSPORT_STATUS);
  });

  it('publish then read', () => {
    const owner = {};
    publishTransportStatus(owner, { state: 'recording', sessionId: 's1', title: 'Ep 1' });
    expect(getTransportStatus()).toEqual({ state: 'recording', sessionId: 's1', title: 'Ep 1' });
  });

  it("a stale owner's clear does not clear a newer publish", () => {
    const stale = {};
    const fresh = {};
    publishTransportStatus(stale, { state: 'rolling', sessionId: 's1', title: 'A' });
    publishTransportStatus(fresh, { state: 'recording', sessionId: 's2', title: 'B' });
    clearTransportStatus(stale);
    expect(getTransportStatus()).toEqual({ state: 'recording', sessionId: 's2', title: 'B' });
  });

  it('a clear by the current owner resets to stopped', () => {
    const owner = {};
    publishTransportStatus(owner, { state: 'playback', sessionId: 's1', title: 'A' });
    clearTransportStatus(owner);
    expect(getTransportStatus()).toBe(STOPPED_TRANSPORT_STATUS);
  });

  it('notifies subscribers on a change and stops after unsubscribe', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeTransportStatus(cb);
    const owner = {};
    publishTransportStatus(owner, { state: 'rolling', sessionId: 's1', title: 'A' });
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    clearTransportStatus(owner);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // The tick fence (web-ui-system "The playback tick is fenced at named memo
  // boundaries"): an identical re-publish keeps the snapshot identity and
  // notifies nobody, so useSyncExternalStore readers do not re-render.
  it('an identical re-publish keeps the snapshot and does not notify', () => {
    const cb = vi.fn();
    subscribeTransportStatus(cb);
    publishTransportStatus({}, { state: 'rolling', sessionId: 's1', title: 'A' });
    const snap = getTransportStatus();
    publishTransportStatus({}, { state: 'rolling', sessionId: 's1', title: 'A' });
    expect(getTransportStatus()).toBe(snap);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
