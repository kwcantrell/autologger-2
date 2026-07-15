import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHub, SessionHubRegistry } from './SessionHub';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autologger-hub-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CTX = { frameRate: 24, startOffsetFrames: 0 };

describe('SessionHub', () => {
  it('ensure() initializes the schema and returns an empty projection', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    expect(hub.ensure()).toMatchObject({ event_count: 0, is_rolling: false, current_take: 0 });
    hub.close();
  });

  it('addEvent persists atomically with its revision bump', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const { event, projection } = hub.addEvent({
      category: 'cam',
      message: 'hello',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
    });
    expect(event.message).toBe('hello');
    expect(projection.event_count).toBe(1);
    // Revision bumped in the same transaction as the insert.
    expect(hub.statusLive(CTX).events_stream_revision).toBe(1);
    hub.close();
  });

  it('state survives close + reopen (persisted on disk)', () => {
    const p = join(dir, 's1.db');
    const hub = new SessionHub(p);
    hub.addEvent({ category: 'cam', message: 'x', metadataJson: '{}', markedAtUtc: null, ctx: CTX });
    hub.close();
    const hub2 = new SessionHub(p);
    expect(hub2.ensure().event_count).toBe(1);
    hub2.close();
  });

  it('broadcasts to attached sockets and counts presence by role', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const got: string[] = [];
    const ws = { send: (d: string) => void got.push(d) };
    hub.attachSocket(ws, 'browser');
    hub.attachSocket({ send: () => {} }, 'companion');
    expect(hub.presence()).toEqual({ browsers: 1, companions: 1 });
    hub.broadcastCommand('record-start');
    expect(JSON.parse(got[0])).toMatchObject({ type: 'command', command: 'record-start' });
    hub.detachSocket(ws);
    expect(hub.presence()).toEqual({ browsers: 0, companions: 1 });
    hub.close();
  });

  it('handleSocketMessage re-broadcasts client commands and ignores garbage', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const got: string[] = [];
    hub.attachSocket({ send: (d: string) => void got.push(d) }, 'browser');
    hub.handleSocketMessage('not json');
    hub.handleSocketMessage(JSON.stringify({ type: 'ping' }));
    hub.handleSocketMessage(JSON.stringify({ type: 'command', command: 'play-toggle' }));
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0])).toMatchObject({ type: 'command', command: 'play-toggle' });
    hub.close();
  });

  describe('lease timer (single-slot, fake time)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('expires a stale lease via the timer 40s after the last heartbeat', () => {
      const hub = new SessionHub(join(dir, 's1.db'));
      expect(hub.claimLease('client-a')).toBe(true);
      expect(hub.leaseStatus().lease_alive).toBe(true);
      vi.advanceTimersByTime(41_000);
      expect(hub.leaseStatus().lease_alive).toBe(false);
      expect(hub.leaseStatus().holder_client_id).toBeNull();
      hub.close();
    });

    it('heartbeats re-arm the single slot instead of stacking timers', () => {
      const hub = new SessionHub(join(dir, 's1.db'));
      hub.claimLease('client-a');
      vi.advanceTimersByTime(30_000);
      hub.heartbeatLease('client-a');
      vi.advanceTimersByTime(30_000); // 60s after claim, 30s after heartbeat
      expect(hub.leaseStatus().lease_alive).toBe(true); // old timer must not have fired a kill
      vi.advanceTimersByTime(11_000);
      expect(hub.leaseStatus().lease_alive).toBe(false);
      hub.close();
    });

    it('a lease already stale at instantiation is cleaned up (expireIfStale on open)', () => {
      const p = join(dir, 's1.db');
      const hub = new SessionHub(p);
      hub.claimLease('client-a');
      hub.close(); // process "dies" holding the lease
      vi.advanceTimersByTime(60_000);
      const hub2 = new SessionHub(p);
      expect(hub2.leaseStatus().holder_client_id).toBeNull(); // meta rows purged, not just lazily masked
      hub2.close();
    });
  });
});

describe('SessionHub.replaceTranscriptWords', () => {
  it('inserts words with start_sec/end_sec and contiguous ordinals from 0', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const result = hub.replaceTranscriptWords([
      { session_time: '00:00:01:00', speaker: '0', word: 'hello', start_sec: 1, end_sec: 1.4 },
      { session_time: '00:00:02:00', speaker: '1', word: 'world', start_sec: 2, end_sec: 2.5 },
    ]);
    expect(result.map((w) => ({ ...w, id: undefined, created_at_utc: undefined }))).toEqual([
      {
        id: undefined,
        session_time: '00:00:01:00',
        speaker: '0',
        word: 'hello',
        start_sec: 1,
        end_sec: 1.4,
        ordinal: 0,
        created_at_utc: undefined,
      },
      {
        id: undefined,
        session_time: '00:00:02:00',
        speaker: '1',
        word: 'world',
        start_sec: 2,
        end_sec: 2.5,
        ordinal: 1,
        created_at_utc: undefined,
      },
    ]);
    expect(hub.listTranscriptWords()).toEqual(result);
    hub.close();
  });

  it('deletes the prior word set atomically (delete-then-insert replaces, not merges)', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    hub.insertTranscriptWord({ session_time: '00:00:00:00', speaker: '0', word: 'stale' });
    const result = hub.replaceTranscriptWords([
      { session_time: '00:00:05:00', speaker: '0', word: 'fresh', start_sec: 5, end_sec: 5.5 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe('fresh');
    expect(result[0].ordinal).toBe(0);
    expect(hub.listTranscriptWords().map((w) => w.word)).toEqual(['fresh']);
    hub.close();
  });

  it('replacing with an empty list clears all existing words', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    hub.insertTranscriptWord({ session_time: '00:00:00:00', speaker: '0', word: 'gone' });
    const result = hub.replaceTranscriptWords([]);
    expect(result).toEqual([]);
    expect(hub.listTranscriptWords()).toEqual([]);
    hub.close();
  });
});

describe('SessionHubRegistry', () => {
  it('returns the same hub per session id and isolates sessions', () => {
    const reg = new SessionHubRegistry(dir);
    const a = reg.get('sess-a');
    expect(reg.get('sess-a')).toBe(a);
    a.addEvent({ category: 'cam', message: 'x', metadataJson: '{}', markedAtUtc: null, ctx: CTX });
    expect(reg.get('sess-b').ensure().event_count).toBe(0);
    reg.closeAll();
  });

  it('rejects path-hostile session ids', () => {
    const reg = new SessionHubRegistry(dir);
    expect(() => reg.get('../escape')).toThrow();
    expect(() => reg.get('a/b')).toThrow();
    reg.closeAll();
  });

  it('evictIdle closes idle hubs (no sockets, no alarm) and they reopen lazily', () => {
    vi.useFakeTimers();
    const reg = new SessionHubRegistry(dir);
    const a = reg.get('sess-a');
    a.addEvent({ category: 'cam', message: 'x', metadataJson: '{}', markedAtUtc: null, ctx: CTX });
    vi.advanceTimersByTime(11 * 60_000);
    reg.evictIdle();
    const reopened = reg.get('sess-a');
    expect(reopened).not.toBe(a);
    expect(reopened.ensure().event_count).toBe(1);
    reg.closeAll();
    vi.useRealTimers();
  });

  it('does not evict a hub with a live socket or an armed lease', () => {
    vi.useFakeTimers();
    const reg = new SessionHubRegistry(dir);
    const withSocket = reg.get('sess-a');
    withSocket.attachSocket({ send: () => {} }, 'browser');
    const withLease = reg.get('sess-b');
    withLease.claimLease('c1');
    vi.advanceTimersByTime(11 * 60_000);
    reg.evictIdle();
    expect(reg.get('sess-a')).toBe(withSocket);
    // sess-b's lease expired at 40s (timer fired), so by 11min it MAY be evictable;
    // re-arm it and check within the armed window instead:
    const armed = reg.get('sess-c');
    armed.claimLease('c2');
    vi.advanceTimersByTime(20_000);
    reg.evictIdle(1); // idleMs=1 → everything idle is evictable, but armed alarm blocks
    expect(reg.get('sess-c')).toBe(armed);
    reg.closeAll();
    vi.useRealTimers();
  });
});
