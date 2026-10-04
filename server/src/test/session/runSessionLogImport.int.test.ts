// runSessionLogImport is async (async-session-callers D5; its hub calls are asynchronous, and each
// insert commits the live projection with it, session-tables D8); failures surface as rejections, not synchronous throws. Each row's
// duplicate check and insert are one hub transaction (async-session-hub D7, S10), so a row a
// concurrent import already stored is skipped and counted as skipped.
import type { CategoryRecord } from '@autologger/domain';
import { describe, expect, it } from 'vitest';
import { runSessionLogImport } from '@autologger/log-import/runSessionLogImport';
import { createSessionRow, openTestHub, testStorage } from './sessionRows';

describe('runSessionLogImport', () => {
  it('returns a promise that rejects on an untimed transcript', async () => {
    const run = runSessionLogImport({
      hub: {} as never,
      rows: [],
      categories: [],
      ctx: { frameRate: 24, startOffsetFrames: 0 },
      transcript: [],
    });
    expect(run).toBeInstanceOf(Promise);
    await expect(run).rejects.toThrow(/Transcript is missing/);
  });
});

describe('runSessionLogImport duplicate skip against a concurrent import', () => {
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
    const id = await createSessionRow();
    const hub = await openTestHub(id, testStorage(id));
    await hub.appendAudioSeamParts([{ duration_s: 600 }]);
    const run = () =>
      runSessionLogImport({
        hub,
        rows: [{ sheetSec: 10, message: words.join(' '), type: '', rawTimecode: '00:00:10' }],
        categories: [OTHER],
        ctx: { frameRate: 24, startOffsetFrames: 0 },
        transcript: words.map((word, i) => ({ word, startSec: 10 + i * 0.3 })),
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
