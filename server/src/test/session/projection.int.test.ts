// The session live projection commits with the session write (session-tables design D8;
// catalog-database "The session live projection commits with the session write"). After each hub
// method that changes the events or the transport, the session's `catalog.sessions` row, read at
// once on another connection, equals the hub's `ensure()`; a write that fails after its insert
// leaves the events and the projection as they were; and a projection update that fails fails the
// whole write, with no frame sent.

import { UI_SNAPSHOT_LABEL_KEY } from '@autologger/domain';
import type { SessionProjection } from '@autologger/session-core/sessionCore';
import type { SessionHubRegistry } from '@autologger/session-core/SessionHub';
import { afterEach, describe, expect, it } from 'vitest';
import { type SlowStorage, slowStorage } from './slowStorage';
import {
  catalogRoot,
  createSessionRow,
  rawRows,
  type TestHub,
  testRegistry,
  testStorage,
} from './sessionRows';

const CTX = { frameRate: 24, startOffsetFrames: 0 };
const STARTED_AT = '2026-10-01T10:00:00.000Z';

const registries: SessionHubRegistry[] = [];
afterEach(async () => {
  for (const r of registries.splice(0)) await r.closeAll();
});

/** The session's catalog projection, read on its own connection, in `ensure()`'s shape. */
async function catalogProjection(sessionId: string): Promise<SessionProjection> {
  const [row] = await catalogRoot()
    .bindSystem('test')
    .all<Record<string, unknown>>(
      `SELECT event_count, max_timecode_total_frames, is_rolling, current_take,
              transport_elapsed_frames, roll_started_at_utc
         FROM sessions WHERE id = ?`,
      sessionId,
    );
  return {
    event_count: Number(row.event_count),
    max_timecode_total_frames:
      row.max_timecode_total_frames === null ? null : Number(row.max_timecode_total_frames),
    is_rolling: Boolean(Number(row.is_rolling)),
    current_take: Number(row.current_take),
    transport_elapsed_frames: Number(row.transport_elapsed_frames),
    roll_started_at_utc: (row.roll_started_at_utc as string | null) ?? null,
  };
}

async function openHub(
  wrap?: (s: SlowStorage) => void,
): Promise<{ id: string; hub: TestHub; frames: unknown[] }> {
  const id = await createSessionRow();
  const registry = testRegistry({
    wrap: wrap
      ? (storage) => {
          const slow = slowStorage(storage, { delayMs: 0 });
          wrap(slow);
          return slow;
        }
      : undefined,
  });
  registries.push(registry);
  const hub = await registry.get(id);
  const frames: unknown[] = [];
  hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
  return { id, hub, frames };
}

const add = (hub: TestHub, message: string, metadataJson = '{}', category = 'cam') =>
  hub.addEvent({ category, message, metadataJson, markedAtUtc: null, ctx: CTX });

async function expectCurrent(id: string, hub: TestHub): Promise<SessionProjection> {
  const projection = await catalogProjection(id);
  expect(projection).toEqual(await hub.ensure());
  return projection;
}

describe('the catalog projection is current after each projection-changing hub method', () => {
  it('addEvent', async () => {
    const { id, hub } = await openHub();
    await add(hub, 'one');
    expect((await expectCurrent(id, hub)).event_count).toBe(1);
  });

  it('updateEvent', async () => {
    const { id, hub } = await openHub();
    const { event } = await add(hub, 'one');
    await hub.updateEvent({
      eventId: event.event_id,
      category: 'cam',
      message: 'edited',
      wallTimeUtc: STARTED_AT,
      timecodeTotalFrames: 4_800,
      mergeMetadata: (m) => m,
    });
    expect((await expectCurrent(id, hub)).max_timecode_total_frames).toBe(4_800);
  });

  it('deleteEvent', async () => {
    const { id, hub } = await openHub();
    const { event } = await add(hub, 'one');
    await add(hub, 'two');
    await hub.deleteEvent(event.event_id);
    expect((await expectCurrent(id, hub)).event_count).toBe(1);
  });

  it('deleteEventsByIds', async () => {
    const { id, hub } = await openHub();
    const a = await add(hub, 'one');
    const b = await add(hub, 'two');
    await add(hub, 'three');
    expect(await hub.deleteEventsByIds([a.event.event_id, b.event.event_id])).toBe(2);
    expect((await expectCurrent(id, hub)).event_count).toBe(1);
  });

  it('maybeRelinkOrphans', async () => {
    const { id, hub } = await openHub();
    await add(hub, 'orphan', JSON.stringify({ [UI_SNAPSHOT_LABEL_KEY]: 'Camera' }), 'gone');
    expect(await hub.maybeRelinkOrphans({ validIds: ['cam'], labelToIds: { camera: ['cam'] } })).toBe(
      1,
    );
    expect((await expectCurrent(id, hub)).event_count).toBe(1);
  });

  it('startTake', async () => {
    const { id, hub } = await openHub();
    await hub.startTake(CTX);
    const p = await expectCurrent(id, hub);
    expect(p.is_rolling).toBe(true);
    expect(p.current_take).toBe(1);
  });

  it('stopTake', async () => {
    const { id, hub } = await openHub();
    await hub.startTake(CTX);
    await hub.stopTake(CTX);
    const p = await expectCurrent(id, hub);
    expect(p.is_rolling).toBe(false);
    expect(p.current_take).toBe(1);
  });

  it('toggleTake', async () => {
    const { id, hub } = await openHub();
    await hub.toggleTake(CTX);
    expect((await expectCurrent(id, hub)).is_rolling).toBe(true);
    await hub.toggleTake(CTX);
    expect((await expectCurrent(id, hub)).is_rolling).toBe(false);
  });

  it('anchorImportedTake', async () => {
    const { id, hub } = await openHub();
    await hub.anchorImportedTake({ recordingOrdinal: 1, durationS: 10, ctx: CTX });
    const p = await expectCurrent(id, hub);
    expect(p.event_count).toBe(2);
    expect(p.transport_elapsed_frames).toBe(240);
  });

  it('createAnchoredEvent', async () => {
    const { id, hub } = await openHub();
    await hub.createAnchoredEvent({
      category: 'cam',
      message: 'anchored',
      metadataJson: '{}',
      timecodeTotalFrames: 2_400,
      frameRate: 24,
      startOffsetFrames: 0,
      startedAtUtc: STARTED_AT,
    });
    const p = await expectCurrent(id, hub);
    expect(p.event_count).toBe(1);
    expect(p.max_timecode_total_frames).toBe(2_400);
  });

  it('addEventAtTotalFramesIfAbsent', async () => {
    const { id, hub } = await openHub();
    const result = await hub.addEventAtTotalFramesIfAbsent({
      category: 'cam',
      message: 'imported',
      metadataJson: '{}',
      timecodeTotalFrames: 1_200,
      ctx: CTX,
    });
    expect(result.created).toBe(true);
    const p = await expectCurrent(id, hub);
    expect(p.event_count).toBe(1);
    expect(p.max_timecode_total_frames).toBe(1_200);
  });
});

describe('the projection shares the write fate', () => {
  it('a write whose body fails after its insert leaves the events and the projection unchanged', async () => {
    let slow!: SlowStorage;
    const { id, hub, frames } = await openHub((s) => {
      slow = s;
    });
    await add(hub, 'kept');
    const before = await catalogProjection(id);
    frames.length = 0;

    slow.failAfterBody(1, new Error('fails after the insert'));
    await expect(add(hub, 'rolled back')).rejects.toThrow('fails after the insert');

    expect(
      (await rawRows(testStorage(id), 'session_events', { columns: 'message' })).map(
        (r) => r.message,
      ),
    ).toEqual(['kept']);
    expect(await catalogProjection(id)).toEqual(before);
    expect(before.event_count).toBe(1);
    expect(frames).toEqual([]);
  });

  it('a projection update that fails fails the write: no event, no frame, the projection unchanged', async () => {
    let failProjection = false;
    const { id, hub, frames } = await openHub((s) => {
      s.hooks.beforeStatement = (sql) => {
        if (failProjection && /^\s*UPDATE sessions\b/i.test(sql)) {
          throw new Error('projection update failed');
        }
      };
    });
    await add(hub, 'kept');
    const before = await catalogProjection(id);
    frames.length = 0;

    failProjection = true;
    await expect(add(hub, 'not saved')).rejects.toThrow('projection update failed');
    await expect(hub.startTake(CTX)).rejects.toThrow('projection update failed');
    failProjection = false;

    expect(
      (await rawRows(testStorage(id), 'session_events', { columns: 'message' })).map(
        (r) => r.message,
      ),
    ).toEqual(['kept']);
    expect((await hub.ensure()).is_rolling).toBe(false);
    expect(await catalogProjection(id)).toEqual(before);
    expect(before.event_count).toBe(1);
    expect(frames).toEqual([]);
  });
});
