// session-edit-conflicts D4/D5: one save loop for every versioned row edit or delete.
//
// - Saves are chained per `rowKey`: a save starts only after the previous save on that row has
//   settled, including its outcome handler, so the next save's `baseVersion()` reads the rebased
//   seed (D4).
// - A version conflict asks the operator through one shared three-way prompt (D7). Prompts across
//   rows are FIFO and asked one at a time, never replacing each other (A4).
// - A decision other than Overwrite settles every save still queued on that row without sending.
// - A session switch or an unmount dismisses the open and queued prompts and drops queued saves;
//   after every await the loop re-checks the session generation, so a late 409 never prompts.
//
// Only type imports from `api` (webBoundaries: shared may not value-import from api).

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { VersionGuard } from '../../api/versionConflict';
import { type Choice, type ConfirmOptions, useConfirm } from '../ui/ConfirmDialog';

export type SaveOutcome<R, C> =
  | { kind: 'saved'; result: R }
  | { kind: 'keptTheirs'; current: C }
  | { kind: 'dismissed'; current?: C };

export interface VersionedSaveOptions<R, C extends { version: number }> {
  /** Serialization key: saves with the same key run one after another. */
  rowKey: string;
  /** The seed's version, read when this save's turn comes (never the cache). `undefined` sends
   *  no guard (last writer wins). */
  baseVersion: () => number | undefined;
  /** Sends the edit or delete with the guard: `{version}`, `{version, overwrite: true}` on an
   *  Overwrite, or `{}` for an unknown base. */
  send: (guard: VersionGuard) => Promise<R>;
  /** The conflict's `current` row, or `null` for any other error (which is rethrown). */
  conflictOf: (e: unknown) => C | null;
  /** The prompt for a conflict (see `conflictPromptCopy`). */
  prompt: (current: C) => ConfirmOptions;
  /** Run inside the row's chain, before the next queued save reads its base (D4). */
  onSaved?: (result: R) => void;
  onKeptTheirs?: (current: C) => void;
  onDismissed?: () => void;
}

export interface VersionedSave {
  run<R, C extends { version: number }>(
    opts: VersionedSaveOptions<R, C>,
  ): Promise<SaveOutcome<R, C>>;
  /** A save is in flight or queued for the row (D3 follow rule). Its identity changes whenever
   *  any row's busy state changes, so effects may depend on it. */
  isBusy: (rowKey: string) => boolean;
  /** Render once in the owner's tree. */
  conflictElement: ReactNode;
}

interface RowChain {
  tail: Promise<void>;
  /** Saves in flight or queued. */
  size: number;
  /** Bumped by each Keep theirs / dismissed decision; a queued save that joined before the bump
   *  settles with `lastDecision` instead of sending. */
  decisionSeq: number;
  lastDecision: SaveOutcome<never, unknown> | null;
}

export function useVersionedSave(sessionId: string): VersionedSave {
  const { choose, confirmElement } = useConfirm();

  // Session generation: bumped on every sessionId change. `aliveRef` is false after unmount.
  const genRef = useRef(0);
  const aliveRef = useRef(true);
  const lastSessionRef = useRef(sessionId);
  const rowsRef = useRef(new Map<string, RowChain>());
  // Cancels for queued (not yet started) saves and for open or queued prompts.
  const cancelsRef = useRef(new Set<() => void>());
  const promptTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const [busyTick, setBusyTick] = useState(0);
  // The prompt on screen and the session it belongs to: the dialog renders only for the current
  // session and only while its prompt is live (a cancelled `choose` leaves `useConfirm` pending
  // until the next prompt replaces it, so the element is gated here).
  const [openPrompt, setOpenPrompt] = useState<{ token: number; sessionId: string } | null>(null);
  const tokenRef = useRef(0);

  const cancelAll = useCallback(() => {
    const cancels = [...cancelsRef.current];
    cancelsRef.current.clear();
    for (const c of cancels) c();
    rowsRef.current = new Map();
    promptTailRef.current = Promise.resolve();
    setOpenPrompt(null);
  }, []);

  // Layout effect so a save started by a sibling's passive effect after the switch already sees
  // the new generation.
  useLayoutEffect(() => {
    if (lastSessionRef.current === sessionId) return;
    lastSessionRef.current = sessionId;
    genRef.current += 1;
    cancelAll();
    setBusyTick((t) => t + 1);
  }, [sessionId, cancelAll]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelAll();
    };
  }, [cancelAll]);

  const bump = useCallback(() => {
    if (aliveRef.current) setBusyTick((t) => t + 1);
  }, []);

  /** One prompt at a time, FIFO. Resolves 'dismiss' if cancelled (session change, unmount). */
  const ask = useCallback(
    (copy: ConfirmOptions, gen: number, sid: string): Promise<Choice> => {
      const token = ++tokenRef.current;
      let settled = false;
      let resolveAnswer!: (c: Choice) => void;
      const answer = new Promise<Choice>((r) => {
        resolveAnswer = r;
      });
      const settle = (c: Choice) => {
        if (settled) return;
        settled = true;
        cancelsRef.current.delete(cancel);
        setOpenPrompt((p) => (p?.token === token ? null : p));
        resolveAnswer(c);
      };
      const cancel = () => settle('dismiss');
      cancelsRef.current.add(cancel);
      // The queue moves on only when this prompt settles, chosen or cancelled.
      promptTailRef.current = promptTailRef.current.then(() => {
        if (settled) return;
        if (!aliveRef.current || genRef.current !== gen) return settle('dismiss');
        setOpenPrompt({ token, sessionId: sid });
        choose(copy).then(settle);
        return answer.then(() => {});
      });
      return answer;
    },
    [choose],
  );

  const run = useCallback(
    <R, C extends { version: number }>(
      opts: VersionedSaveOptions<R, C>,
    ): Promise<SaveOutcome<R, C>> => {
      const gen = genRef.current;
      const sid = lastSessionRef.current;
      const live = () => aliveRef.current && genRef.current === gen;
      if (!live()) return Promise.resolve({ kind: 'dismissed' });

      const rows = rowsRef.current;
      let row = rows.get(opts.rowKey);
      if (!row) {
        row = { tail: Promise.resolve(), size: 0, decisionSeq: 0, lastDecision: null };
        rows.set(opts.rowKey, row);
      }
      const chain = row;
      chain.size += 1;
      const joinedAt = chain.decisionSeq;
      const prev = chain.tail;
      let release!: () => void;
      chain.tail = new Promise<void>((r) => {
        release = r;
      });
      bump();

      return new Promise<SaveOutcome<R, C>>((resolve, reject) => {
        let finished = false;
        const finish = () => {
          if (finished) return false;
          finished = true;
          cancelsRef.current.delete(cancelQueued);
          chain.size -= 1;
          if (chain.size === 0 && rowsRef.current.get(opts.rowKey) === chain) {
            rowsRef.current.delete(opts.rowKey);
          }
          release();
          bump();
          return true;
        };
        const done = (o: SaveOutcome<R, C>) => {
          if (finish()) resolve(o);
        };
        const fail = (e: unknown) => {
          if (finish()) reject(e);
        };
        let started = false;
        // A queued save dropped by a session change or unmount: dismissed, never sent.
        const cancelQueued = () => {
          if (!started) done({ kind: 'dismissed' });
        };
        cancelsRef.current.add(cancelQueued);

        const loop = async () => {
          if (finished) return;
          started = true;
          cancelsRef.current.delete(cancelQueued);
          if (!live()) return done({ kind: 'dismissed' });
          if (chain.decisionSeq !== joinedAt && chain.lastDecision) {
            // Covered by the decision taken on an earlier save of this row: settle the same way
            // without sending. Its text is still in the caller's draft; the decision's handler
            // already ran once, so none runs here.
            return done(chain.lastDecision as SaveOutcome<R, C>);
          }
          const base = opts.baseVersion();
          let guard: VersionGuard = base === undefined ? {} : { version: base };
          for (;;) {
            let result: R;
            try {
              result = await opts.send(guard);
            } catch (e) {
              const current = opts.conflictOf(e);
              // A conflict for a request sent before a session switch or unmount: no prompt.
              if (!live())
                return done(current ? { kind: 'dismissed', current } : { kind: 'dismissed' });
              if (!current) return fail(e);
              const choice = await ask(opts.prompt(current), gen, sid);
              if (!live()) return done({ kind: 'dismissed', current });
              if (choice === 'confirm') {
                guard = { version: current.version, overwrite: true };
                continue;
              }
              const outcome: SaveOutcome<R, C> =
                choice === 'cancel'
                  ? { kind: 'keptTheirs', current }
                  : { kind: 'dismissed', current };
              chain.decisionSeq += 1;
              chain.lastDecision = outcome as SaveOutcome<never, unknown>;
              if (outcome.kind === 'keptTheirs') opts.onKeptTheirs?.(current);
              else opts.onDismissed?.();
              return done(outcome);
            }
            if (!live()) return done({ kind: 'dismissed' });
            opts.onSaved?.(result);
            return done({ kind: 'saved', result });
          }
        };

        prev.then(() => loop().catch(fail));
      });
    },
    [ask, bump],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: busyTick is the change signal
  const isBusy = useCallback(
    (rowKey: string) => (rowsRef.current.get(rowKey)?.size ?? 0) > 0,
    [busyTick],
  );

  const conflictElement = openPrompt && openPrompt.sessionId === sessionId ? confirmElement : null;

  return { run, isBusy, conflictElement };
}
