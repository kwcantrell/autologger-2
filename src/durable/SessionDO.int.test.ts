import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { SessionDO } from './SessionDO';

function stubFor(name: string) {
  const id = env.SESSION_DO.idFromName(name);
  return env.SESSION_DO.get(id);
}
const CTX = { frameRate: 30, startOffsetFrames: 0 };

describe('SessionDO real storage', () => {
  it('addEvent persists and bumps the events_stream_revision', async () => {
    const stub = stubFor('do-events');
    await runInDurableObject(stub, async (instance: SessionDO) => {
      const before = instance.statusLive(CTX).events_stream_revision;
      instance.addEvent({
        category: 'cam',
        message: 'hi',
        metadataJson: '{}',
        markedAtUtc: null,
        ctx: CTX,
      });
      const live = instance.statusLive(CTX);
      expect(live.events_stream_revision).toBeGreaterThan(before);
      expect(live.event_count).toBe(1);
    });
  });

  it('transport start then stop flips rolling state', async () => {
    const stub = stubFor('do-transport');
    await runInDurableObject(stub, async (instance: SessionDO) => {
      expect(instance.startTake(CTX).state.started).toBe(true);
      expect(instance.statusLive(CTX).is_rolling).toBe(true);
      expect(instance.stopTake(CTX).state.stopped).toBe(true);
      expect(instance.statusLive(CTX).is_rolling).toBe(false);
    });
  });

  it('audio: add → list → delete against real storage', async () => {
    const stub = stubFor('do-audio');
    await runInDurableObject(stub, async (instance: SessionDO) => {
      const seg = instance.addAudioSegment({
        sessionId: 'sess-1',
        mimeType: 'audio/webm',
        startedAtUtc: null,
        endedAtUtc: null,
        recordingOrdinal: null,
      });
      expect(instance.listAudioSegments()).toHaveLength(1);
      instance.deleteAudioSegment(seg.id);
      expect(instance.listAudioSegments()).toHaveLength(0);
    });
  });

  it('lease: claim arms a real alarm and records the holder', async () => {
    const stub = stubFor('do-lease');
    await runInDurableObject(stub, async (instance: SessionDO, state) => {
      expect(instance.claimLease('c1')).toBe(true);
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(instance.leaseStatus().holder_client_id).toBe('c1');
      expect(instance.claimLease('c2')).toBe(false); // held by c1
      instance.releaseLease('c1');
      expect(instance.leaseStatus().holder_client_id).toBeNull();
    });
  });
});
