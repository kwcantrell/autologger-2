import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/shared/components/ui/alert-dialog';
import { Button, TOUCH_TARGET } from '@/shared/components/ui/button';
import { useDialogMode } from './breakpoints';
import { Dialog, DialogActions } from './Dialog';

// The confirm/prompt lead text (shadcn-port-modals D7): the former `.modal-lead` values.
const LEAD = 'm-0 mb-4 text-[0.82rem] leading-[1.45] text-legacy-muted';

/**
 * Themed replacement for `window.confirm` (ui-refresh; shadcn-shared-wrappers D3): an alert
 * dialog on desktop and the shared bottom sheet on mobile. Escape, an overlay click, and a sheet
 * drag-dismiss all resolve as decline — unless the caller passes `onDismiss`
 * (session-edit-conflicts D7), which then receives them instead of `onCancel`.
 */
export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  /** Defaults to "Confirm". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Renders the confirm action in the danger variant. */
  danger?: boolean;
}

interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Called for a dismissal (Escape, an overlay click, a sheet drag-dismiss: any close that is
   *  not one of the two buttons). Absent, a dismissal calls `onCancel` exactly as before. */
  onDismiss?: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
  onDismiss,
}: ConfirmDialogProps) {
  const isMobile = useDialogMode(open);
  const actionVariant = danger ? 'destructive' : 'default';
  // Exactly one decision per open: Radix's Action/Cancel parts also close the dialog, which
  // fires onOpenChange(false) right after the click — without this guard an accept would
  // report onConfirm AND onCancel.
  const decided = useRef(false);
  useEffect(() => {
    if (open) decided.current = false;
  }, [open]);
  const confirmOnce = () => {
    if (decided.current) return;
    decided.current = true;
    onConfirm();
  };
  const cancelOnce = () => {
    if (decided.current) return;
    decided.current = true;
    onCancel();
  };
  const dismissOnce = () => {
    if (decided.current) return;
    decided.current = true;
    (onDismiss ?? onCancel)();
  };

  if (isMobile) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && dismissOnce()} title={title}>
        <p className={LEAD}>{message}</p>
        <DialogActions>
          <Button type="button" variant="outline" className={TOUCH_TARGET} onClick={cancelOnce}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={actionVariant}
            className={TOUCH_TARGET}
            onClick={confirmOnce}
          >
            {confirmLabel}
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && dismissOnce()}>
      <AlertDialogContent onOverlayClick={dismissOnce}>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <p className={LEAD}>{message}</p>
        </AlertDialogDescription>
        <DialogActions>
          <AlertDialogCancel className={TOUCH_TARGET} onClick={cancelOnce}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction variant={actionVariant} className={TOUCH_TARGET} onClick={confirmOnce}>
            {confirmLabel}
          </AlertDialogAction>
        </DialogActions>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A three-way decision (session-edit-conflicts D7): the confirm button, the cancel button, or a
 *  dismissal (Escape, overlay, drag-dismiss, a replaced prompt, an unmount). */
export type Choice = 'confirm' | 'cancel' | 'dismiss';

// Every pending prompt resolves a `Choice`; the boolean `confirm()` maps it to `=== 'confirm'`,
// so its dismissals still resolve false.
interface PendingConfirm {
  opts: ConfirmOptions;
  resolve: (choice: Choice) => void;
}

/**
 * Promise-based drop-in for `window.confirm`:
 *
 *   const { confirm, confirmElement } = useConfirm();
 *   ...
 *   if (!(await confirm({ title, message, danger: true }))) return;
 *
 * Render `confirmElement` once anywhere in the consumer's tree.
 *
 * Resolve-false guarantee (ui-refresh D2): no awaiting caller ever hangs.
 * Replacing an already-pending confirmation (a second `confirm()` call before
 * the first was answered) resolves the replaced promise `false`; unmounting
 * this hook's owner while a confirmation is pending (e.g. a session switch)
 * also resolves it `false` via an effect cleanup.
 *
 * `choose(opts)` (session-edit-conflicts D7) is the three-way form: it resolves
 * `'confirm'`, `'cancel'` or `'dismiss'`. The same guarantee holds, as
 * `'dismiss'`: a replaced or unmounted pending choose never hangs. Both share
 * the one dialog, so a `choose` replaces a pending `confirm` and vice versa.
 */
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Mirrors `pending` for the unmount-cleanup effect below, which must read
  // whatever is pending at unmount time rather than a stale closed-over value.
  const pendingRef = useRef<PendingConfirm | null>(null);
  pendingRef.current = pending;

  const choose = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<Choice>((resolve) => {
        setPending((prev) => {
          // A second prompt arriving while one is still pending replaces
          // it — resolve the replaced promise as a dismissal (false, for
          // confirm()) instead of leaving its awaiting caller hung forever.
          prev?.resolve('dismiss');
          return { opts, resolve };
        });
      }),
    [],
  );

  const confirm = useCallback(
    (opts: ConfirmOptions) => choose(opts).then((choice) => choice === 'confirm'),
    [choose],
  );

  const settle = useCallback((choice: Choice) => {
    setPending((prev) => {
      prev?.resolve(choice);
      return null;
    });
  }, []);

  useEffect(() => {
    return () => {
      // Unmounting with a decision still pending (e.g. the consumer unmounts
      // or the session it belongs to switches away) is a dismissal, not a hang.
      pendingRef.current?.resolve('dismiss');
    };
  }, []);

  const confirmElement = pending ? (
    <ConfirmDialog
      open
      {...pending.opts}
      onConfirm={() => settle('confirm')}
      onCancel={() => settle('cancel')}
      onDismiss={() => settle('dismiss')}
    />
  ) : null;

  return { confirm, choose, confirmElement };
}
