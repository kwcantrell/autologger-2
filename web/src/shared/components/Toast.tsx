import { toast as sonner } from 'sonner';
import { Toaster } from '@/shared/components/ui/sonner';

/**
 * The app's toast API, as a facade over sonner (shadcn-shared-wrappers D6). Signatures are the
 * legacy queue store's; sonner owns rendering, stacking, timers, and the live region. Toasts
 * created before the <Toast/> host mounts still show (sonner keeps them).
 *
 * Persistent toasts use the id sonner RETURNS (choosing our own would collide with sonner's
 * auto-increment ids and let one toast overwrite another). `toast.persistent` keeps returning a
 * number: the facade's own counter, mapped to sonner's id.
 */
interface ShowOpts {
  persistent?: boolean;
}

/** Non-persistent toasts auto-dismiss after this long (the legacy store's value). */
const AUTO_DISMISS_MS = 3200;

type SonnerId = string | number;

let _nextId = 1;
/** Facade id → sonner id, for persistent toasts still on screen (insertion order = age). */
const _persistent = new Map<number, SonnerId>();

function push(message: string, isError: boolean, persistent: boolean): number {
  const id = _nextId++;
  const duration = persistent ? Number.POSITIVE_INFINITY : AUTO_DISMISS_MS;
  // A persistent toast the user swipes away must leave the map too, so hideToast() never
  // targets a toast that is already gone.
  const opts = persistent ? { duration, onDismiss: () => _persistent.delete(id) } : { duration };
  const sonnerId = isError ? sonner.error(message, opts) : sonner(message, opts);
  if (persistent) _persistent.set(id, sonnerId);
  return id;
}

function dismiss(id: number): void {
  const sonnerId = _persistent.get(id);
  if (sonnerId === undefined) return;
  _persistent.delete(id);
  sonner.dismiss(sonnerId);
}

/** Backwards-compatible API used by every page. */
export function showToast(message: string, isError = false, opts: ShowOpts = {}): void {
  push(message, isError, Boolean(opts.persistent));
}

/** Dismiss the most recent persistent toast (legacy single-toast contract).
 * No persistent toast pending ⇒ no-op — never clears unrelated (auto-dismiss) toasts. */
export function hideToast(): void {
  const newest = [..._persistent.keys()].pop();
  if (newest !== undefined) dismiss(newest);
}

/** Convenience helpers. */
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

/** V5 toast surface (the legacy store's classes); errors keep the red border/text. */
const TOAST_CLASSNAMES = {
  toast:
    'glass-face-strong !rounded-v5-sm !border !border-v5-border !px-[0.9rem] !py-[0.65rem] !text-[0.85rem] !leading-[1.35] !text-v5-text !shadow-[0_8px_32px_rgba(0,0,0,0.35)]',
  error: '!border-danger !text-[#ffb4b4]',
};

/** The toast host (AppShell, AdminUsersPage): sonner's dark Toaster, bottom-right, V5-styled. */
export function Toast() {
  return (
    <Toaster
      position="bottom-right"
      className="z-(--z-toast)"
      toastOptions={{ classNames: TOAST_CLASSNAMES }}
    />
  );
}
