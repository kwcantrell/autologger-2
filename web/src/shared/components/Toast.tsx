import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './Toast.module.css';

interface ShowOpts {
  persistent?: boolean;
}

interface ToastEntry {
  id: number;
  message: string;
  isError: boolean;
  persistent: boolean;
}

type Listener = (entries: ToastEntry[]) => void;

let _nextId = 1;
let _queue: ToastEntry[] = [];
const _listeners = new Set<Listener>();

function emit(): void {
  for (const listener of _listeners) listener(_queue);
}

function push(message: string, isError: boolean, persistent: boolean): number {
  const id = _nextId++;
  _queue = [..._queue, { id, message, isError, persistent }];
  emit();
  return id;
}

function dismiss(id: number): void {
  _queue = _queue.filter((t) => t.id !== id);
  emit();
}

/** Backwards-compatible API used by every page. */
export function showToast(message: string, isError = false, opts: ShowOpts = {}): void {
  push(message, isError, Boolean(opts.persistent));
}

/** Dismiss the most recent persistent toast (legacy single-toast contract). */
export function hideToast(): void {
  const last = [..._queue].reverse().find((t) => t.persistent);
  if (last) dismiss(last.id);
  else _queue = [];
  emit();
}

/** Convenience helpers (Phase 2 — queue store). */
export const toast = {
  success(message: string): void {
    push(message, false, false);
  },
  error(message: string): void {
    push(message, true, false);
  },
  persistent(message: string): number {
    return push(message, false, true);
  },
  dismiss,
};

const AUTO_DISMISS_MS = 3200;

export function Toast() {
  const [entries, setEntries] = useState<ToastEntry[]>(_queue);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const listener: Listener = (next) => setEntries(next);
    _listeners.add(listener);
    return () => {
      _listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    // Schedule auto-dismiss for newly arrived non-persistent entries.
    for (const entry of entries) {
      if (entry.persistent) continue;
      if (timers.has(entry.id)) continue;
      const t = setTimeout(() => {
        timers.delete(entry.id);
        dismiss(entry.id);
      }, AUTO_DISMISS_MS);
      timers.set(entry.id, t);
    }
    // Drop timers for entries that have been removed externally.
    for (const [id, t] of timers) {
      if (!entries.some((e) => e.id === id)) {
        clearTimeout(t);
        timers.delete(id);
      }
    }
  }, [entries]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <output id="toast-queue" className={styles.toastQueue} aria-live="polite">
      {entries.map((entry) => (
        <div key={entry.id} className={`${styles.toast} ${entry.isError ? styles.error : ''}`}>
          {entry.message}
        </div>
      ))}
    </output>,
    document.body,
  );
}
