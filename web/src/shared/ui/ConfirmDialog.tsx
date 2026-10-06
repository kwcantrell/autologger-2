import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/shared/components/ui/alert-dialog';
import { Button } from '@/shared/components/ui/button';
import { useIsMobile } from './breakpoints';
import { Dialog } from './Dialog';

/**
 * Themed replacement for `window.confirm` (ui-refresh; shadcn-shared-wrappers D3): an alert
 * dialog on desktop and the shared bottom sheet on mobile. Escape, an overlay click, and a sheet
 * drag-dismiss all resolve as decline.
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
}: ConfirmDialogProps) {
  const isMobile = useIsMobile();
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

  if (isMobile) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && cancelOnce()} title={title}>
        <p className="modal-lead">{message}</p>
        <div className="modal-actions">
          <Button type="button" variant="outline" onClick={cancelOnce}>
            {cancelLabel}
          </Button>
          <Button type="button" variant={actionVariant} onClick={confirmOnce}>
            {confirmLabel}
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && cancelOnce()}>
      <AlertDialogContent onOverlayClick={cancelOnce}>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <p className="modal-lead">{message}</p>
        </AlertDialogDescription>
        <div className="modal-actions">
          <AlertDialogCancel onClick={cancelOnce}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction variant={actionVariant} onClick={confirmOnce}>
            {confirmLabel}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface PendingConfirm {
  opts: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
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
 */
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Mirrors `pending` for the unmount-cleanup effect below, which must read
  // whatever is pending at unmount time rather than a stale closed-over value.
  const pendingRef = useRef<PendingConfirm | null>(null);
  pendingRef.current = pending;

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending((prev) => {
          // A second confirm() arriving while one is still pending replaces
          // it — resolve the replaced promise false instead of leaving its
          // awaiting caller hung forever.
          prev?.resolve(false);
          return { opts, resolve };
        });
      }),
    [],
  );

  const settle = useCallback((confirmed: boolean) => {
    setPending((prev) => {
      prev?.resolve(confirmed);
      return null;
    });
  }, []);

  useEffect(() => {
    return () => {
      // Unmounting with a decision still pending (e.g. the consumer unmounts
      // or the session it belongs to switches away) is a decline, not a hang.
      pendingRef.current?.resolve(false);
    };
  }, []);

  const confirmElement = pending ? (
    <ConfirmDialog
      open
      {...pending.opts}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { confirm, confirmElement };
}
