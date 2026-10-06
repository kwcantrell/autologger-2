import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, TOUCH_TARGET } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Dialog, DialogActions } from './Dialog';

/**
 * Themed replacement for `window.prompt` (shadcn-shared-wrappers D3b): a single-line text
 * request rendered in the app's Dialog vocabulary (centered card on desktop, bottom sheet on
 * mobile). Named `requestText` — not `prompt` — so the no-browser-dialogs repo guard needs no
 * exception for it.
 */
export interface TextPromptOptions {
  title: string;
  /** Visible label for the text field (also its accessible name). */
  label: string;
  description?: ReactNode;
  placeholder?: string;
  initialValue?: string;
  /** Defaults to "OK". */
  submitLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
}

interface PromptDialogProps extends TextPromptOptions {
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function PromptDialog({
  title,
  label,
  description,
  placeholder,
  initialValue = '',
  submitLabel = 'OK',
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputId = useId();
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()} title={title} description={description}>
      <div className="flex flex-col gap-2">
        <Label htmlFor={inputId}>{label}</Label>
        <Input
          id={inputId}
          type="text"
          autoComplete="off"
          autoFocus
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmit(value);
            }
          }}
        />
      </div>
      <DialogActions>
        <Button type="button" variant="outline" className={TOUCH_TARGET} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="button" className={TOUCH_TARGET} onClick={() => onSubmit(value)}>
          {submitLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

interface PendingPrompt {
  /** Per-request key, so a replacing request starts from its own initial value. */
  seq: number;
  opts: TextPromptOptions;
  resolve: (value: string | null) => void;
}

/**
 * Promise-based drop-in for `window.prompt`:
 *
 *   const { requestText, promptElement } = useTextPrompt();
 *   ...
 *   const raw = await requestText({ title, label });
 *   if (raw === null) return;
 *
 * Render `promptElement` once anywhere in the consumer's tree. Same no-hang guarantee as
 * `useConfirm`: cancel, Escape, overlay, sheet drag, a replacing request, or unmounting the
 * owner all resolve `null`; submit resolves the raw (untrimmed) string.
 */
export function useTextPrompt() {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  // Mirrors `pending` for the unmount cleanup, which must see the value at unmount time.
  const pendingRef = useRef<PendingPrompt | null>(null);
  pendingRef.current = pending;
  const seqRef = useRef(0);

  const requestText = useCallback(
    (opts: TextPromptOptions) =>
      new Promise<string | null>((resolve) => {
        seqRef.current += 1;
        const seq = seqRef.current;
        setPending((prev) => {
          prev?.resolve(null);
          return { seq, opts, resolve };
        });
      }),
    [],
  );

  const settle = useCallback((value: string | null) => {
    setPending((prev) => {
      prev?.resolve(value);
      return null;
    });
  }, []);

  useEffect(() => {
    return () => {
      pendingRef.current?.resolve(null);
    };
  }, []);

  const promptElement = pending ? (
    <PromptDialog
      key={pending.seq}
      {...pending.opts}
      onSubmit={(v) => settle(v)}
      onCancel={() => settle(null)}
    />
  ) : null;

  return { requestText, promptElement };
}
