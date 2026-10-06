// Version checks (session-row-versions design D4, D5; core-ports-architecture "Version checks are
// atomic with the session write"): the six update and delete operations for events, transcript
// words and topics take an optional expected version. A stale one is refused with the stored row
// and writes, advances and broadcasts nothing; a missing row keeps the not-found result. With
// `overwrite`, a passing check also records one audit row in the same transaction, as the user; a
// system caller's overwrite is refused before any statement.

import { userCaller, systemCaller } from '@autologger/session-core/sessionCaller';
import { SessionTxMisuseError } from '@autologger/session-core/asyncSessionSql';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultUser } from '../harness';
import { seededSession } from '../helpers';
import { catalogRoot, harnessHub } from './sessionRows';

const CTX = { frameRate: 24, startOffsetFrames: 0 };
const closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

const sys = () => catalogRoot().bindSystem('test-seed');
async function revision(id: string): Promise<number> {
  const rows = await sys().all<{ revision: number }>('SELECT revision FROM sessions WHERE id = ?', id);
  return Number(rows[0]?.revision);
}
async function audits(id: string) {
  return sys().all<Record<string, unknown>>(
    'SELECT table_name, row_id, user_id, replaced_version, before_json, after_json FROM session_overwrites WHERE session_id = ? ORDER BY at_utc, id',
    id,
  );
}

/** A seeded session the default user can reach, its hub, a view as that user, and its frames. */
async function setup() {
  const { sessionId } = await seededSession();
  const user = (await defaultUser()).id;
  const hub = await harnessHub(sessionId);
  const view = hub.as(userCaller(user));
  const frames: Array<Record<string, unknown>> = [];
  const socket = { send: (d: string) => void frames.push(JSON.parse(d)) };
  hub.attachSocket(socket, 'browser');
  closers.push(() => hub.detachSocket(socket));
  return { sessionId, user, hub, view, frames };
}

const update = (eventId: string, message: string) => ({
  eventId,
  category: 'cam',
  message,
  wallTimeUtc: '2026-10-10T00:00:00.000Z',
  timecodeTotalFrames: 0,
  mergeMetadata: (m: string) => m,
});

describe('version checks on the six operations (design D4)', () => {
  it('updateEvent: a matching version writes; a stale one returns the stored row and changes nothing', async () => {
    const { sessionId, view, frames } = await setup();
    const { event } = await view.addEvent({
      category: 'cam',
      message: 'one',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
    });
    const ok = await view.updateEvent({ ...update(event.event_id, 'two'), expect: { version: 1, overwrite: false } });
    expect(ok && 'event' in ok ? ok.event.version : null).toBe(2);
    const r = await revision(sessionId);
    const framesBefore = frames.length;
    const stale = await view.updateEvent({ ...update(event.event_id, 'three'), expect: { version: 1, overwrite: false } });
    expect(stale).toEqual({ conflict: expect.objectContaining({ event_id: event.event_id, message: 'two', version: 2 }) });
    expect((await view.exportEvents()).find((e) => e.event_id === event.event_id)?.message).toBe('two');
    expect(await revision(sessionId)).toBe(r);
    expect(frames.length).toBe(framesBefore);
    expect(await view.updateEvent({ ...update('missing', 'x'), expect: { version: 1, overwrite: false } })).toBeNull();
  });

  it('deleteEvent: a stale version is refused with the stored row; a matching one deletes; a missing row is not found', async () => {
    const { view } = await setup();
    const { event } = await view.addEvent({ category: 'cam', message: 'm', metadataJson: '{}', markedAtUtc: null, ctx: CTX });
    await view.updateEvent(update(event.event_id, 'n'));
    const stale = await view.deleteEvent(event.event_id, { version: 1, overwrite: false });
    expect(stale).toEqual({ conflict: expect.objectContaining({ event_id: event.event_id, version: 2 }) });
    expect((await view.exportEvents()).some((e) => e.event_id === event.event_id)).toBe(true);
    const ok = await view.deleteEvent(event.event_id, { version: 2, overwrite: false });
    expect(ok).toMatchObject({ ok: true });
    expect(await view.deleteEvent(event.event_id, { version: 2, overwrite: false })).toMatchObject({ ok: false });
  });

  it('transcript words: patch and delete check the version; an empty patch with a matching version writes nothing', async () => {
    const { view } = await setup();
    const word = await view.insertTranscriptWord({ session_time: '', speaker: 'a', word: 'x' });
    expect(await view.updateTranscriptWord(word.id, { word: 'y' }, { version: 1, overwrite: false })).toMatchObject({ version: 2, word: 'y' });
    expect(await view.updateTranscriptWord(word.id, { word: 'z' }, { version: 1, overwrite: false })).toEqual({
      conflict: expect.objectContaining({ id: word.id, word: 'y', version: 2 }),
    });
    expect(await view.updateTranscriptWord(word.id, {}, { version: 2, overwrite: true })).toMatchObject({ version: 2, word: 'y' });
    expect(await view.deleteTranscriptWord(word.id, { version: 1, overwrite: false })).toEqual({
      conflict: expect.objectContaining({ id: word.id, version: 2 }),
    });
    expect(await view.deleteTranscriptWord(word.id, { version: 2, overwrite: false })).toBe(true);
    expect(await view.deleteTranscriptWord(word.id, { version: 2, overwrite: false })).toBe(false);
    expect(await view.updateTranscriptWord(word.id, { word: 'q' }, { version: 2, overwrite: false })).toBeNull();
  });

  it('topics: patch and delete check the version', async () => {
    const { view } = await setup();
    const topic = await view.insertTopic({ session_time: '', duration_sec: 0, topic_level: 1, summary: 's' });
    expect(await view.updateTopic(topic.id, { summary: 't' }, { version: 1, overwrite: false })).toMatchObject({ version: 2 });
    expect(await view.updateTopic(topic.id, { summary: 'u' }, { version: 1, overwrite: false })).toEqual({
      conflict: expect.objectContaining({ id: topic.id, summary: 't', version: 2 }),
    });
    expect(await view.deleteTopic(topic.id, { version: 1, overwrite: false })).toEqual({
      conflict: expect.objectContaining({ id: topic.id, version: 2 }),
    });
    expect(await view.deleteTopic(topic.id, { version: 2, overwrite: false })).toBe(true);
    expect(await view.updateTopic(topic.id, { summary: 'v' }, { version: 2, overwrite: false })).toBeNull();
  });
});

describe('audited overwrites (design D5)', () => {
  it('an overwrite with the matching version records the user, row, replaced version, before and after', async () => {
    const { sessionId, user, view } = await setup();
    const topic = await view.insertTopic({ session_time: '', duration_sec: 0, topic_level: 1, summary: 'mine' });
    await view.updateTopic(topic.id, { summary: 'theirs' });
    const over = await view.updateTopic(topic.id, { summary: 'mine again' }, { version: 2, overwrite: true });
    expect(over).toMatchObject({ summary: 'mine again', version: 3 });
    const [row, ...rest] = await audits(sessionId);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ table_name: 'session_topics', row_id: topic.id, user_id: user, replaced_version: 2 });
    expect(JSON.parse(String(row?.before_json))).toMatchObject({ summary: 'theirs', version: 2 });
    expect(JSON.parse(String(row?.after_json))).toMatchObject({ summary: 'mine again', version: 3 });
  });

  it('an overwriting delete records the row with no after; a stale overwrite records nothing', async () => {
    const { sessionId, view } = await setup();
    const { event } = await view.addEvent({ category: 'cam', message: 'm', metadataJson: '{}', markedAtUtc: null, ctx: CTX });
    await view.updateEvent(update(event.event_id, 'n'));
    expect(await view.deleteEvent(event.event_id, { version: 1, overwrite: true })).toMatchObject({ conflict: expect.anything() });
    expect(await audits(sessionId)).toEqual([]);
    expect(await view.deleteEvent(event.event_id, { version: 2, overwrite: true })).toMatchObject({ ok: true });
    const rows = await audits(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ table_name: 'session_events', row_id: event.event_id, replaced_version: 2, after_json: null });
  });

  it('a transaction that fails after the overwrite leaves neither the write nor the record', async () => {
    const { sessionId, view } = await setup();
    const word = await view.insertTranscriptWord({ session_time: '', speaker: 'a', word: 'x' });
    type TxView = { inTxn<R>(fn: (s: { transcript: { updateTranscriptWord: typeof view.updateTranscriptWord } }) => Promise<R>): Promise<R> };
    await expect(
      (view as unknown as TxView).inTxn(async (s) => {
        await s.transcript.updateTranscriptWord(word.id, { word: 'gone' }, { version: 1, overwrite: true });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await view.listTranscriptWords())[0]).toMatchObject({ word: 'x', version: 1 });
    expect(await audits(sessionId)).toEqual([]);
  });

  it('a system caller cannot overwrite: refused before any statement', async () => {
    const { sessionId, hub } = await setup();
    const sysView = hub.as(systemCaller('test-harness'));
    const word = await sysView.insertTranscriptWord({ session_time: '', speaker: 'a', word: 'x' });
    const r = await revision(sessionId);
    await expect(
      sysView.updateTranscriptWord(word.id, { word: 'y' }, { version: 1, overwrite: true }),
    ).rejects.toBeInstanceOf(SessionTxMisuseError);
    expect(await revision(sessionId)).toBe(r);
    expect((await sysView.listTranscriptWords())[0]).toMatchObject({ word: 'x', version: 1 });
    // A system caller's check without overwrite is allowed.
    expect(await sysView.updateTranscriptWord(word.id, { word: 'y' }, { version: 1, overwrite: false })).toMatchObject({ version: 2 });
  });
});
