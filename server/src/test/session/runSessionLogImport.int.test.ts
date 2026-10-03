// runSessionLogImport is async so an async catalog mirror (projectLive) can be awaited
// (async-session-callers D5); failures surface as rejections, not synchronous throws. Each row's
// duplicate check and insert are one hub transaction (async-session-hub D7, S10), so a row a
// concurrent import already stored is skipped and counted as skipped.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CategoryRecord } from '@autologger/domain';
import { SessionHub } from '@autologger/session-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSessionLogImport } from '@autologger/log-import/runSessionLogImport';

describe('runSessionLogImport', () => {
  it('returns a promise that rejects on an untimed transcript', async () => {
    const run = runSessionLogImport({
      hub: {} as never,
      rows: [],
      categories: [],
      ctx: { frameRate: 24, startOffsetFrames: 0 },
      transcript: [],
      projectLive: async () => {},
    });
    expect(run).toBeInstanceOf(Promise);
    await expect(run).rejects.toThrow(/Transcript is missing/);
  });
});

describe('runSessionLogImport duplicate skip against a concurrent import', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autologger-logimport-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const OTHER: CategoryRecord = {
    id: 'cat-other',
    name: 'Other',
    color: '#888888',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
  };
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

  async function setup() {
    const hub = await SessionHub.open(join(dir, 's1.db'));
    await hub.appendAudioSeamParts([{ duration_s: 600 }]);
    const run = () =>
      runSessionLogImport({
        hub,
        rows: [{ sheetSec: 10, message: words.join(' '), type: '', rawTimecode: '00:00:10' }],
        categories: [OTHER],
        ctx: { frameRate: 24, startOffsetFrames: 0 },
        transcript: words.map((word, i) => ({ word, startSec: 10 + i * 0.3 })),
        projectLive: async () => {},
      });
    return { hub, run };
  }

  it('skips a row an earlier import already stored, and counts it as skipped', async () => {
    const { hub, run } = await setup();
    const first = await run();
    expect([first.created, first.skipped]).toEqual([1, 0]);
    const second = await run();
    expect([second.created, second.skipped]).toEqual([0, 1]);
    expect(second.lines.at(-1)).toBe('Created 0, skipped 1 duplicate(s).');
    expect((await hub.exportEvents()).map((e) => e.message)).toEqual([words.join(' ')]);
    await hub.close();
  });

  it('two imports of the same row at once store it once, and their created counts sum to one', async () => {
    const { hub, run } = await setup();
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.created + b.created).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
    expect((await hub.exportEvents()).map((e) => e.message)).toEqual([words.join(' ')]);
    await hub.close();
  });
});
