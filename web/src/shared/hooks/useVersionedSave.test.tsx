import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { VersionConflict } from '../../api/types';
import { type VersionGuard, versionConflictOf } from '../../api/versionConflict';
import { renderStrict } from '../../test/renderStrict';
import type { ConfirmOptions } from '../ui/ConfirmDialog';
import { conflictPromptCopy } from './conflictPromptCopy';
import { type SaveOutcome, useVersionedSave, type VersionedSave } from './useVersionedSave';

// session-edit-conflicts D4/D5 (task 5.3): the save loop, its per-row chain, the queued prompt and
// the session generation. A probe renders `conflictElement` and exposes the hook through a ref;
// the dialog is the real themed ConfirmDialog (desktop: an alertdialog), driven with fireEvent.

interface Row {
  id: string;
  version: number;
  text: string;
}

type Api = ReturnType<typeof useVersionedSave>;

function Probe({ sessionId, api }: { sessionId: string; api: MutableRefObject<Api | null> }) {
  const vs = useVersionedSave(sessionId);
  api.current = vs;
  return <div>{vs.conflictElement}</div>;
}

function mount(sessionId = 's1') {
  const api: MutableRefObject<Api | null> = { current: null };
  const r = renderStrict(<Probe sessionId={sessionId} api={api} />);
  return {
    api: () => api.current as Api,
    rerender: (sid: string) => r.rerender(<Probe sessionId={sid} api={api} />),
    unmount: r.unmount,
  };
}

/** The real 409 the hooks see: an `ApiError` carrying the parsed body. */
function conflict(current: Row): ApiError {
  return new ApiError(409, 'Version conflict.', { detail: 'Version conflict.', current });
}

const conflictOf = (e: unknown): Row | null =>
  versionConflictOf<VersionConflict<Row>>(e)?.current ?? null;

const editPrompt = (yours: string) => (current: Row) =>
  conflictPromptCopy('edit', [{ label: 'Text', theirs: current.text, yours }]);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => act(async () => {});

function track<R, C>(p: Promise<SaveOutcome<R, C>>) {
  const box: { outcome?: SaveOutcome<R, C>; error?: unknown } = {};
  p.then(
    (o) => {
      box.outcome = o;
    },
    (e) => {
      box.error = e;
    },
  );
  return box;
}

const dialog = () => screen.queryByRole('alertdialog');
const click = async (name: string) => {
  fireEvent.click(await screen.findByRole('button', { name }));
  await flush();
};
const pressEscape = async () => {
  const d = await screen.findByRole('alertdialog');
  fireEvent.keyDown(d, { key: 'Escape' });
  await flush();
};

describe('useVersionedSave: the save loop (D5)', () => {
  it('saves with the base version and runs onSaved', async () => {
    const h = mount();
    const send = vi.fn(async (_g: VersionGuard) => 'ok');
    const onSaved = vi.fn();
    let out!: ReturnType<typeof track<string, Row>>;
    await act(async () => {
      out = track(
        h.api().run<string, Row>({
          rowKey: 'r1',
          baseVersion: () => 4,
          send,
          conflictOf,
          prompt: editPrompt('mine'),
          onSaved,
        }),
      );
    });
    await flush();
    expect(send.mock.calls).toEqual([[{ version: 4 }]]);
    expect(out.outcome).toEqual({ kind: 'saved', result: 'ok' });
    expect(onSaved).toHaveBeenCalledWith('ok');
    expect(dialog()).toBeNull();
  });

  it('fails closed when the base is unknown: rejects with an Error and sends nothing', async () => {
    const h = mount();
    const send = vi.fn(async (_g: VersionGuard) => 'ok');
    const onSaved = vi.fn();
    let out!: ReturnType<typeof track<string, Row>>;
    await act(async () => {
      out = track(
        h.api().run<string, Row>({
          rowKey: 'r1',
          baseVersion: () => undefined,
          send,
          conflictOf,
          prompt: editPrompt('mine'),
          onSaved,
        }),
      );
    });
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(out.error).toBeInstanceOf(Error);
    expect(h.api().isBusy('r1')).toBe(false);
    // The row is released: a later save with a known base sends.
    await act(async () => {
      await h.api().run<string, Row>({
        rowKey: 'r1',
        baseVersion: () => 2,
        send,
        conflictOf,
        prompt: editPrompt('mine'),
      });
    });
    expect(send.mock.calls).toEqual([[{ version: 2 }]]);
  });

  it('conflict, Overwrite, conflict, Overwrite, then saved: each retry carries the newer version', async () => {
    const h = mount();
    const send = vi
      .fn<(g: VersionGuard) => Promise<string>>()
      .mockRejectedValueOnce(conflict({ id: 'r1', version: 2, text: 'second writer' }))
      .mockRejectedValueOnce(conflict({ id: 'r1', version: 3, text: 'third writer' }))
      .mockResolvedValueOnce('ok');
    let out!: ReturnType<typeof track<string, Row>>;
    await act(async () => {
      out = track(
        h.api().run<string, Row>({
          rowKey: 'r1',
          baseVersion: () => 1,
          send,
          conflictOf,
          prompt: editPrompt('mine'),
        }),
      );
    });
    expect(await screen.findByText(/second writer/)).toBeTruthy();
    await click('Overwrite');
    expect(await screen.findByText(/third writer/)).toBeTruthy();
    await click('Overwrite');
    await waitFor(() => expect(out.outcome).toEqual({ kind: 'saved', result: 'ok' }));
    expect(send.mock.calls).toEqual([
      [{ version: 1 }],
      [{ version: 2, overwrite: true }],
      [{ version: 3, overwrite: true }],
    ]);
    expect(dialog()).toBeNull();
  });

  it('Keep theirs gives keptTheirs and sends nothing more', async () => {
    const h = mount();
    const theirs = { id: 'r1', version: 2, text: 'theirs' };
    const send = vi.fn(async (_g: VersionGuard): Promise<string> => {
      throw conflict(theirs);
    });
    const onKeptTheirs = vi.fn();
    const onDismissed = vi.fn();
    let out!: ReturnType<typeof track<string, Row>>;
    await act(async () => {
      out = track(
        h.api().run<string, Row>({
          rowKey: 'r1',
          baseVersion: () => 1,
          send,
          conflictOf,
          prompt: editPrompt('mine'),
          onKeptTheirs,
          onDismissed,
        }),
      );
    });
    await click('Keep theirs');
    expect(out.outcome).toEqual({ kind: 'keptTheirs', current: theirs });
    expect(onKeptTheirs).toHaveBeenCalledWith(theirs);
    expect(onDismissed).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('dismiss (Escape) gives dismissed and sends nothing more', async () => {
    const h = mount();
    const theirs = { id: 'r1', version: 2, text: 'theirs' };
    const send = vi.fn(async (_g: VersionGuard): Promise<string> => {
      throw conflict(theirs);
    });
    const onKeptTheirs = vi.fn();
    const onDismissed = vi.fn();
    let out!: ReturnType<typeof track<string, Row>>;
    await act(async () => {
      out = track(
        h.api().run<string, Row>({
          rowKey: 'r1',
          baseVersion: () => 1,
          send,
          conflictOf,
          prompt: editPrompt('mine'),
          onKeptTheirs,
          onDismissed,
        }),
      );
    });
    await pressEscape();
    expect(out.outcome).toEqual({ kind: 'dismissed', current: theirs });
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(onKeptTheirs).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('a non-conflict error rejects unchanged, runs no handler, and releases the row', async () => {
    const h = mount();
    const boom = new ApiError(500, 'Server exploded', { detail: 'Server exploded' });
    const send = vi
      .fn<(g: VersionGuard) => Promise<string>>()
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce('ok');
    const handlers = { onSaved: vi.fn(), onKeptTheirs: vi.fn(), onDismissed: vi.fn() };
    let first!: ReturnType<typeof track<string, Row>>;
    await act(async () => {
      first = track(
        h.api().run<string, Row>({
          rowKey: 'r1',
          baseVersion: () => 1,
          send,
          conflictOf,
          prompt: editPrompt('mine'),
          ...handlers,
        }),
      );
    });
    await flush();
    expect(first.error).toBe(boom);
    expect(first.outcome).toBeUndefined();
    expect(handlers.onSaved).not.toHaveBeenCalled();
    expect(handlers.onKeptTheirs).not.toHaveBeenCalled();
    expect(handlers.onDismissed).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(h.api().isBusy('r1')).toBe(false);

    let second!: ReturnType<typeof track<string, Row>>;
    await act(async () => {
      second = track(
        h.api().run<string, Row>({
          rowKey: 'r1',
          baseVersion: () => 1,
          send,
          conflictOf,
          prompt: editPrompt('mine'),
        }),
      );
    });
    await flush();
    expect(second.outcome).toEqual({ kind: 'saved', result: 'ok' });
  });
});

describe('useVersionedSave: prompts across rows are queued (A4)', () => {
  it('two conflicts on different rows are prompted one after the other, neither auto-resolved', async () => {
    const h = mount();
    const a = { id: 'a', version: 2, text: 'theirs-A' };
    const b = { id: 'b', version: 7, text: 'theirs-B' };
    const sendA = vi
      .fn<(g: VersionGuard) => Promise<string>>()
      .mockRejectedValueOnce(conflict(a))
      .mockResolvedValueOnce('A-ok');
    const sendB = vi.fn<(g: VersionGuard) => Promise<string>>().mockRejectedValueOnce(conflict(b));
    let outA!: ReturnType<typeof track<string, Row>>;
    let outB!: ReturnType<typeof track<string, Row>>;
    await act(async () => {
      outA = track(
        h.api().run<string, Row>({
          rowKey: 'a',
          baseVersion: () => 1,
          send: sendA,
          conflictOf,
          prompt: editPrompt('mine-A'),
        }),
      );
      outB = track(
        h.api().run<string, Row>({
          rowKey: 'b',
          baseVersion: () => 6,
          send: sendB,
          conflictOf,
          prompt: editPrompt('mine-B'),
        }),
      );
    });
    await flush();
    // Both rows sent concurrently; only the first prompt is showing; neither is resolved.
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.getByText(/theirs-A/)).toBeTruthy();
    expect(screen.queryByText(/theirs-B/)).toBeNull();
    expect(outA.outcome).toBeUndefined();
    expect(outB.outcome).toBeUndefined();

    await click('Overwrite');
    await waitFor(() => expect(outA.outcome).toEqual({ kind: 'saved', result: 'A-ok' }));
    expect(outB.outcome).toBeUndefined();
    expect(await screen.findByText(/theirs-B/)).toBeTruthy();

    await click('Keep theirs');
    expect(outB.outcome).toEqual({ kind: 'keptTheirs', current: b });
    expect(dialog()).toBeNull();
  });
});

describe('useVersionedSave: per-row chain (D4)', () => {
  it('two saves on one row: the second waits and reads its base after the first settles', async () => {
    const h = mount();
    const first = deferred<string>();
    const log: string[] = [];
    const send1 = vi.fn((_g: VersionGuard) => {
      log.push('send1');
      return first.promise;
    });
    const send2 = vi.fn(async (_g: VersionGuard) => {
      log.push('send2');
      return 'two';
    });
    let out1!: ReturnType<typeof track<string, Row>>;
    let out2!: ReturnType<typeof track<string, Row>>;
    await act(async () => {
      out1 = track(
        h.api().run<string, Row>({
          rowKey: 'r1',
          baseVersion: () => {
            log.push('base1');
            return 1;
          },
          send: send1,
          conflictOf,
          prompt: editPrompt('a'),
        }),
      );
      out2 = track(
        h.api().run<string, Row>({
          rowKey: 'r1',
          baseVersion: () => {
            log.push('base2');
            return 2;
          },
          send: send2,
          conflictOf,
          prompt: editPrompt('b'),
        }),
      );
    });
    await flush();
    expect(log).toEqual(['base1', 'send1']);
    expect(send2).not.toHaveBeenCalled();

    await act(async () => {
      first.resolve('one');
    });
    await flush();
    expect(log).toEqual(['base1', 'send1', 'base2', 'send2']);
    expect(out1.outcome).toEqual({ kind: 'saved', result: 'one' });
    expect(out2.outcome).toEqual({ kind: 'saved', result: 'two' });
    expect(send2.mock.calls).toEqual([[{ version: 2 }]]);
  });

  it('onSaved runs inside the chain, so a queued save’s base thunk sees the rebased seed', async () => {
    const h = mount();
    const seed = { version: 1 };
    const first = deferred<Row>();
    const log: string[] = [];
    const send = vi
      .fn<(g: VersionGuard) => Promise<Row>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => ({ id: 'r1', version: 3, text: 'b' }));
    const opts = (label: string) => ({
      rowKey: 'r1',
      baseVersion: () => {
        log.push(`base:${label}:${seed.version}`);
        return seed.version;
      },
      send,
      conflictOf,
      prompt: editPrompt(label),
      onSaved: (row: Row) => {
        log.push(`onSaved:${label}:${row.version}`);
        seed.version = row.version;
      },
    });
    await act(async () => {
      track(h.api().run<Row, Row>(opts('a')));
      track(h.api().run<Row, Row>(opts('b')));
    });
    await act(async () => {
      first.resolve({ id: 'r1', version: 2, text: 'a' });
    });
    await flush();
    expect(log).toEqual(['base:a:1', 'onSaved:a:2', 'base:b:2', 'onSaved:b:3']);
    expect(send.mock.calls).toEqual([[{ version: 1 }], [{ version: 2 }]]);
  });

  it.each([
    ['Keep theirs', 'keptTheirs'],
    ['Escape', 'dismissed'],
  ] as const)('after %s, saves still queued on that row settle %s and send nothing', async (action, kind) => {
    const h = mount();
    const theirs = { id: 'r1', version: 2, text: 'theirs' };
    const first = deferred<string>();
    const send1 = vi.fn((_g: VersionGuard) => first.promise);
    const send2 = vi.fn(async (_g: VersionGuard) => 'two');
    const send3 = vi.fn(async (_g: VersionGuard) => 'three');
    const queuedHandlers = { onSaved: vi.fn(), onKeptTheirs: vi.fn(), onDismissed: vi.fn() };
    const firstHandlers = { onKeptTheirs: vi.fn(), onDismissed: vi.fn() };
    const outs: Array<ReturnType<typeof track<string, Row>>> = [];
    await act(async () => {
      outs.push(
        track(
          h.api().run<string, Row>({
            rowKey: 'r1',
            baseVersion: () => 1,
            send: send1,
            conflictOf,
            prompt: editPrompt('a'),
            ...firstHandlers,
          }),
        ),
      );
      for (const send of [send2, send3]) {
        outs.push(
          track(
            h.api().run<string, Row>({
              rowKey: 'r1',
              baseVersion: () => 1,
              send,
              conflictOf,
              prompt: editPrompt('b'),
              ...queuedHandlers,
            }),
          ),
        );
      }
    });
    await act(async () => {
      first.reject(conflict(theirs));
    });
    if (action === 'Keep theirs') await click('Keep theirs');
    else await pressEscape();
    await flush();

    const expected = { kind, current: theirs };
    expect(outs.map((o) => o.outcome)).toEqual([expected, expected, expected]);
    expect(send2).not.toHaveBeenCalled();
    expect(send3).not.toHaveBeenCalled();
    // The first decision's handler ran once; the queued saves run no handler of their own.
    expect(
      kind === 'keptTheirs' ? firstHandlers.onKeptTheirs : firstHandlers.onDismissed,
    ).toHaveBeenCalledTimes(1);
    expect(queuedHandlers.onSaved).not.toHaveBeenCalled();
    expect(queuedHandlers.onKeptTheirs).not.toHaveBeenCalled();
    expect(queuedHandlers.onDismissed).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(h.api().isBusy('r1')).toBe(false);

    // A save started after the decision is not covered by it: it sends normally.
    const send4 = vi.fn(async (_g: VersionGuard) => 'four');
    let out4!: ReturnType<typeof track<string, Row>>;
    await act(async () => {
      out4 = track(
        h.api().run<string, Row>({
          rowKey: 'r1',
          baseVersion: () => 2,
          send: send4,
          conflictOf,
          prompt: editPrompt('c'),
        }),
      );
    });
    await flush();
    expect(out4.outcome).toEqual({ kind: 'saved', result: 'four' });
    expect(send4.mock.calls).toEqual([[{ version: 2 }]]);
  });

  it('isBusy(rowKey) is true while a save is in flight or queued for that row', async () => {
    const h = mount();
    const first = deferred<string>();
    const second = deferred<string>();
    const send = vi
      .fn<(g: VersionGuard) => Promise<string>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const opts = {
      rowKey: 'r1',
      baseVersion: () => 1,
      send,
      conflictOf,
      prompt: editPrompt('a'),
    };
    expect(h.api().isBusy('r1')).toBe(false);
    await act(async () => {
      track(h.api().run<string, Row>(opts));
      track(h.api().run<string, Row>(opts));
    });
    expect(h.api().isBusy('r1')).toBe(true);
    expect(h.api().isBusy('r2')).toBe(false);
    await act(async () => {
      first.resolve('one');
    });
    await flush();
    // The first settled; the second is in flight.
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.api().isBusy('r1')).toBe(true);
    await act(async () => {
      second.resolve('two');
    });
    await flush();
    expect(h.api().isBusy('r1')).toBe(false);
  });
});

describe('useVersionedSave: session generation and unmount (D5)', () => {
  it('a sessionId change dismisses the open and queued prompts and sends no queued save', async () => {
    const h = mount('s1');
    const a = { id: 'a', version: 2, text: 'theirs-A' };
    const b = { id: 'b', version: 2, text: 'theirs-B' };
    const sendA = vi.fn(async (_g: VersionGuard): Promise<string> => {
      throw conflict(a);
    });
    const sendB = vi.fn(async (_g: VersionGuard): Promise<string> => {
      throw conflict(b);
    });
    const sendQueued = vi.fn(async (_g: VersionGuard) => 'queued');
    const handlers = { onSaved: vi.fn(), onKeptTheirs: vi.fn(), onDismissed: vi.fn() };
    const outs: Array<ReturnType<typeof track<string, Row>>> = [];
    await act(async () => {
      outs.push(
        track(
          h.api().run<string, Row>({
            rowKey: 'a',
            baseVersion: () => 1,
            send: sendA,
            conflictOf,
            prompt: editPrompt('mine-A'),
            ...handlers,
          }),
        ),
        track(
          h.api().run<string, Row>({
            rowKey: 'b',
            baseVersion: () => 1,
            send: sendB,
            conflictOf,
            prompt: editPrompt('mine-B'),
            ...handlers,
          }),
        ),
        track(
          h.api().run<string, Row>({
            rowKey: 'a',
            baseVersion: () => 1,
            send: sendQueued,
            conflictOf,
            prompt: editPrompt('mine-A2'),
            ...handlers,
          }),
        ),
      );
    });
    await flush();
    expect(screen.getByText(/theirs-A/)).toBeTruthy();

    await act(async () => {
      h.rerender('s2');
    });
    await flush();
    expect(dialog()).toBeNull();
    expect(outs[0].outcome).toEqual({ kind: 'dismissed', current: a });
    expect(outs[1].outcome).toEqual({ kind: 'dismissed', current: b });
    expect(outs[2].outcome).toEqual({ kind: 'dismissed' });
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledTimes(1);
    expect(sendQueued).not.toHaveBeenCalled();
    // A session-change dismissal runs no handler: the feed's own session clear owns the drafts.
    expect(handlers.onDismissed).not.toHaveBeenCalled();
    expect(h.api().isBusy('a')).toBe(false);
    expect(h.api().isBusy('b')).toBe(false);

    // The new session saves normally, and its prompts show.
    const c = { id: 'c', version: 5, text: 'theirs-C' };
    const sendC = vi.fn(async (_g: VersionGuard): Promise<string> => {
      throw conflict(c);
    });
    await act(async () => {
      track(
        h.api().run<string, Row>({
          rowKey: 'a',
          baseVersion: () => 4,
          send: sendC,
          conflictOf,
          prompt: editPrompt('mine-C'),
        }),
      );
    });
    expect(await screen.findByText(/theirs-C/)).toBeTruthy();
    expect(sendC.mock.calls).toEqual([[{ version: 4 }]]);
  });

  it('switching back to the earlier session does not reopen its closed prompt', async () => {
    const h = mount('s1');
    const send = vi.fn(async (_g: VersionGuard): Promise<string> => {
      throw conflict({ id: 'a', version: 2, text: 'theirs-A' });
    });
    await act(async () => {
      track(
        h.api().run<string, Row>({
          rowKey: 'a',
          baseVersion: () => 1,
          send,
          conflictOf,
          prompt: editPrompt('mine'),
        }),
      );
    });
    expect(await screen.findByText(/theirs-A/)).toBeTruthy();
    await act(async () => {
      h.rerender('s2');
    });
    await act(async () => {
      h.rerender('s1');
    });
    await flush();
    expect(dialog()).toBeNull();
  });

  it('a 409 that arrives after a sessionId change opens no dialog and sends nothing', async () => {
    const h = mount('s1');
    const inFlight = deferred<string>();
    const send = vi.fn((_g: VersionGuard) => inFlight.promise);
    const onDismissed = vi.fn();
    let out!: ReturnType<typeof track<string, Row>>;
    await act(async () => {
      out = track(
        h.api().run<string, Row>({
          rowKey: 'a',
          baseVersion: () => 1,
          send,
          conflictOf,
          prompt: editPrompt('mine'),
          onDismissed,
        }),
      );
    });
    await act(async () => {
      h.rerender('s2');
    });
    const theirs = { id: 'a', version: 2, text: 'theirs' };
    await act(async () => {
      inFlight.reject(conflict(theirs));
    });
    await flush();
    expect(dialog()).toBeNull();
    expect(out.outcome).toEqual({ kind: 'dismissed', current: theirs });
    expect(send).toHaveBeenCalledTimes(1);
    expect(onDismissed).not.toHaveBeenCalled();
  });

  it('unmount resolves the open and queued prompts as dismissed', async () => {
    const h = mount();
    const a = { id: 'a', version: 2, text: 'theirs-A' };
    const b = { id: 'b', version: 2, text: 'theirs-B' };
    const mk = (row: Row) =>
      vi.fn(async (_g: VersionGuard): Promise<string> => {
        throw conflict(row);
      });
    const sendA = mk(a);
    const sendB = mk(b);
    const outs: Array<ReturnType<typeof track<string, Row>>> = [];
    await act(async () => {
      outs.push(
        track(
          h.api().run<string, Row>({
            rowKey: 'a',
            baseVersion: () => 1,
            send: sendA,
            conflictOf,
            prompt: editPrompt('x'),
          }),
        ),
        track(
          h.api().run<string, Row>({
            rowKey: 'b',
            baseVersion: () => 1,
            send: sendB,
            conflictOf,
            prompt: editPrompt('y'),
          }),
        ),
      );
    });
    expect(await screen.findByText(/theirs-A/)).toBeTruthy();
    h.unmount();
    await flush();
    expect(outs.map((o) => o.outcome)).toEqual([
      { kind: 'dismissed', current: a },
      { kind: 'dismissed', current: b },
    ]);
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledTimes(1);
  });
});

describe('conflictPromptCopy (D5 copy)', () => {
  it('renders row text as text, lists differing sibling fields only, and truncates at 200 characters', async () => {
    const h = mount();
    const long = 'x'.repeat(250);
    const current = { id: 'w1', version: 2, text: 'their <b>word</b>' };
    const send = vi.fn(async (_g: VersionGuard): Promise<string> => {
      throw conflict(current);
    });
    await act(async () => {
      track(
        h.api().run<string, Row>({
          rowKey: 'w1',
          baseVersion: () => 1,
          send,
          conflictOf,
          prompt: (cur) =>
            conflictPromptCopy('edit', [
              { label: 'Text', theirs: cur.text, yours: 'my <i>word</i>' },
              { label: 'Speaker', theirs: 'Ann', yours: 'Bob' },
              { label: 'Notes', theirs: 'same', yours: 'same' },
              { label: 'Comment', theirs: '', yours: long },
            ]),
        }),
      );
    });
    const d = await screen.findByRole('alertdialog', { name: 'Row changed' });
    expect(d.querySelector('b')).toBeNull();
    expect(d.querySelector('i')).toBeNull();
    expect(d.textContent).toContain('their <b>word</b>');
    expect(d.textContent).toContain('my <i>word</i>');
    // The sibling field holding operator text is listed; the unchanged one is not.
    expect(d.textContent).toContain('Speaker');
    expect(d.textContent).toContain('Bob');
    expect(d.textContent).not.toContain('Notes');
    // Truncated: 200 characters then an ellipsis, never the full 250.
    expect(d.textContent).toContain(`${'x'.repeat(200)}…`);
    expect(d.textContent).not.toContain('x'.repeat(201));
    // Each line is an inline block span (the dialog wraps the message in a <p>).
    expect(d.querySelectorAll('p span.block').length).toBeGreaterThanOrEqual(3);
    const overwrite = screen.getByRole('button', { name: 'Overwrite' });
    expect(overwrite.getAttribute('data-variant')).toBe('destructive');
    expect(screen.getByRole('button', { name: 'Keep theirs' })).toBeTruthy();
  });

  it('builds the edit and delete copy', () => {
    const fields = [
      { label: 'Text', theirs: 'a', yours: 'b' },
      { label: 'Same', theirs: 'c', yours: 'c' },
    ];
    const edit: ConfirmOptions = conflictPromptCopy('edit', fields);
    expect(edit).toMatchObject({
      title: 'Row changed',
      confirmLabel: 'Overwrite',
      cancelLabel: 'Keep theirs',
      danger: true,
    });
    const del: ConfirmOptions = conflictPromptCopy('delete', fields);
    expect(del).toMatchObject({
      title: 'Row changed',
      confirmLabel: 'Delete anyway',
      cancelLabel: 'Keep theirs',
      danger: true,
    });
  });

  it('ends the delete message with "Delete anyway?" after the changed-field lines', async () => {
    const h = mount();
    const send = vi.fn(async (_g: VersionGuard): Promise<string> => {
      throw conflict({ id: 'e1', version: 2, text: 'theirs' });
    });
    await act(async () => {
      track(
        h.api().run<string, Row>({
          rowKey: 'e1',
          baseVersion: () => 1,
          send,
          conflictOf,
          prompt: (cur) =>
            conflictPromptCopy('delete', [{ label: 'Text', theirs: cur.text, yours: 'seen' }]),
        }),
      );
    });
    const d = await screen.findByRole('alertdialog', { name: 'Row changed' });
    const text = d.querySelector('p')?.textContent ?? '';
    expect(text).toMatch(/Text.*theirs.*seen.*Delete anyway\?$/s);
    await click('Delete anyway');
    expect(send.mock.calls[1]).toEqual([{ version: 2, overwrite: true }]);
  });
});

// Type-level: the exported VersionedSave is the hook's return type.
const _typeCheck: (v: VersionedSave) => Api = (v) => v;
void _typeCheck;
