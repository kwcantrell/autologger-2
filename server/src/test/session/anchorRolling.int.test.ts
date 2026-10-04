// The imported take's anchor refuses a rolling transport (session-tables design D7, D12, owner
// decision 1; core-ports-architecture "A take started before an import's anchor is not
// clobbered"; youtube-audio-import "A take started during the import is not clobbered"). A take
// starts through a second request after the route's post-blob rolling check and before
// `anchorImportedTake`: the hub's storage is wrapped so that, while that check's snapshot holds the
// hub, the second request is sent and queued behind it. The route answers its existing 409, writes
// no `Recording N` event, rolls the segment back as its post-blob refusal does, and the take is
// left rolling.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_IMPORT_FIXTURES_DIR, youtubeImportGuard } from '@autologger/media-import';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bindings } from '../../appEnv';
import { app, env, envWith } from '../harness';
import { seededSession } from '../helpers';
import { slowStorage } from './slowStorage';
import { type TestHub, type TestRegistry, testRegistry } from './sessionRows';

const LOCAL_ROLLING_DETAIL =
  'Local audio import is refused while this session is actively recording; stop the recording and try again.';
const YOUTUBE_ROLLING_DETAIL =
  'YouTube import is refused while this session is actively recording; stop the recording and try again.';
const FAKE_AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00]);

const scratch: string[] = [];
afterEach(() => {
  youtubeImportGuard.reset();
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A `yt-dlp` launcher over the hermetic fixture (sessions.youtubeImport.int.test.ts's idiom). */
function fakeYtDlp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-rolling-ytdlp-'));
  scratch.push(dir);
  const binPath = join(dir, 'yt-dlp');
  writeFileSync(
    binPath,
    '#!/bin/sh\n' +
      "echo '{}' > .ytdlp-stub.json\n" +
      `exec "${process.execPath}" "${join(MEDIA_IMPORT_FIXTURES_DIR, 'fake-ytdlp.mjs')}" "$@"\n`,
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

/** A registry whose second snapshot (the route's post-blob rolling check) first sends
 * `POST …/transport/start` and waits until that request is queued on the hub. */
function startTakeAtPostBlobCheck(sessionId: string, overrides: Record<string, unknown>) {
  let bindings!: Bindings;
  let registry!: TestRegistry;
  const started: { response: Response | Promise<Response> | null } = { response: null };
  registry = testRegistry({
    wrap: (storage) =>
      slowStorage(storage, {
        delayMs: 0,
        hooks: {
          async beforeSnapshot(n) {
            if (n !== 2) return;
            const hub = (await registry.get(sessionId)) as TestHub;
            const queued = hub.inFlightCount + 1;
            started.response = app.request(
              `/api/sessions/${sessionId}/transport/start`,
              { method: 'POST' },
              bindings,
            );
            const deadline = Date.now() + 5000;
            while (hub.inFlightCount < queued) {
              if (Date.now() > deadline) throw new Error('the take start was never queued');
              await new Promise((r) => setTimeout(r, 2));
            }
          },
        },
      }),
  });
  bindings = envWith(overrides, { sessions: registry });
  return { bindings, registry, started };
}

async function assertNotClobbered(
  sessionId: string,
  bindings: Bindings,
  res: Response,
  detail: string,
  started: { response: Response | Promise<Response> | null },
) {
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ detail });
  expect(started.response === null).toBe(false);
  expect((await started.response)?.status).toBe(200);

  const status = (await (
    await app.request(`/api/sessions/${sessionId}/status`, {}, bindings)
  ).json()) as { is_rolling: boolean; current_take: number };
  expect(status.is_rolling).toBe(true);
  expect(status.current_take).toBe(1);

  const events = (await (
    await app.request(`/api/sessions/${sessionId}/events?limit=100&offset=0`, {}, bindings)
  ).json()) as { events: Array<{ message: string }>; total: number };
  expect(events.events.filter((e) => /^Recording \d+ /.test(e.message))).toEqual([]);
  expect(events.total).toBe(0);

  const segments = (await (
    await app.request(`/api/sessions/${sessionId}/audio/segments`, {}, bindings)
  ).json()) as { segments: unknown[] };
  expect(segments.segments).toEqual([]);
}

describe('a take started before the imported take is anchored', () => {
  it('local import: the route answers its rolling 409, rolls the segment and blob back, and the take keeps rolling', async () => {
    const { sessionId } = await seededSession();
    const { bindings, registry, started } = startTakeAtPostBlobCheck(sessionId, {});
    const res = await app.request(
      `/api/sessions/${sessionId}/local-audio-import?duration_s=10`,
      { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: FAKE_AUDIO },
      bindings,
    );
    await assertNotClobbered(sessionId, bindings, res, LOCAL_ROLLING_DETAIL, started);
    expect((await env.ports.audio.list({ prefix: `audio/${sessionId}/` })).objects).toEqual([]);
    await registry.closeAll();
  });

  it('YouTube import: the route answers its rolling 409, deletes the segment, and the take keeps rolling', async () => {
    const { sessionId } = await seededSession();
    const { bindings, registry, started } = startTakeAtPostBlobCheck(sessionId, {
      YTDLP_RESOLVED_PATH: fakeYtDlp(),
      HOST: '127.0.0.1',
      IP_ALLOWLIST: '',
    });
    const res = await app.request(
      `/api/sessions/${sessionId}/youtube-import`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://youtu.be/abc123', use_publish_date: false }),
      },
      bindings,
    );
    await assertNotClobbered(sessionId, bindings, res, YOUTUBE_ROLLING_DETAIL, started);
    await registry.closeAll();
  });
});
