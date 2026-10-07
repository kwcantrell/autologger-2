import { type ReactNode, useState } from 'react';
import { ApiError } from '../../../../api/client';
import { Alert, AlertDescription } from '../../../../shared/components/ui/alert';
import { Button } from '../../../../shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../../../shared/components/ui/sheet';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { useConfirm } from '../../../../shared/ui/ConfirmDialog';

// --- SidePanel (redesign-show-ignition 6.3; design D4, D10) ---
//
// The one right-hand panel the Settings view edits a single thing in: a member (8.1), a show
// (8.2), an event button (9.2). It is a shadcn `Sheet side="right"` (focus-trapped, titled and
// described by its header) with Cancel and Save in a footer that stays put while the body scrolls.
//
// The save model is web-ui-system "Honest save model in Settings", side panels:
//   - dirtiness is DERIVED: the caller's draft (`value`) compared with the snapshot taken when the
//     panel opened (or an explicit `baseline`), never a hand-armed flag;
//   - Save is disabled until there is a change and the caller says the draft is `valid`;
//   - every close path with unsaved changes (Cancel, the close control, Escape, a click outside)
//     goes through the themed confirm, and declining keeps the panel and its edits;
//   - Save runs the caller's `onSave` and closes on success. On failure the panel stays open with
//     a line naming what did not apply; `runSaveSteps` builds that name for multi-call saves.

/** A save that stopped at one of its calls. The message names the step: "Couldn’t <step>: …". */
export class SaveStepError extends Error {
  readonly step: string;
  constructor(step: string, detail: string) {
    super(`Couldn’t ${step}: ${detail}`);
    this.name = 'SaveStepError';
    this.step = step;
  }
}

function errorDetail(err: unknown): string {
  if (err instanceof ApiError || err instanceof Error) return err.message;
  return 'something went wrong.';
}

export interface SaveStep {
  /** What the step does, as a verb phrase: "change the role", "grant Morning News". */
  label: string;
  run: () => unknown;
}

/**
 * Run a panel's calls in order (design D4: role, then grants, then removal; or `show_updates`),
 * stopping at the first failure with a `SaveStepError` naming it. Steps already run stay applied;
 * the caller invalidates the affected queries so they show.
 */
export async function runSaveSteps(steps: readonly SaveStep[]): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      throw new SaveStepError(step.label, errorDetail(err));
    }
  }
}

export interface SidePanelProps<T> {
  open: boolean;
  /** Closes the panel. Called after a confirmed discard, a clean close, or a successful save. */
  onClose: () => void;
  title: string;
  description?: ReactNode;
  /** Shown beside the title (a member's avatar, a show's initials). */
  media?: ReactNode;
  /** The caller's current draft. Compared structurally (JSON) with the baseline. */
  value: T;
  /** The saved state to compare against. Omitted, the panel snapshots `value` when it opens. */
  baseline?: T;
  /** False while a required field is empty or invalid. */
  valid?: boolean;
  /** Applies the draft. Rejects to keep the panel open; a `SaveStepError` names the failed step. */
  onSave: () => Promise<void>;
  saveLabel?: string;
  children: ReactNode;
}

export function SidePanel<T>({
  open,
  onClose,
  title,
  description,
  media,
  value,
  baseline,
  valid = true,
  onSave,
  saveLabel = 'Save',
  children,
}: SidePanelProps<T>) {
  const serialized = JSON.stringify(value);
  // Snapshot on the opening render itself (adjust-state-during-render), so the first commit of
  // an open panel already reads clean.
  const [snapshot, setSnapshot] = useState(() => (open ? serialized : null));
  const [prevOpen, setPrevOpen] = useState(open);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setSnapshot(serialized);
      setError(null);
    }
  }

  const reference = baseline !== undefined ? JSON.stringify(baseline) : snapshot;
  const dirty = reference !== null && serialized !== reference;

  const { confirm, confirmElement } = useConfirm();

  async function requestClose() {
    if (saving) return;
    if (dirty) {
      const ok = await confirm({
        title: 'Discard changes?',
        message: `Your changes to ${title.toLowerCase()} haven’t been saved. Discard them?`,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave();
      onClose();
    } catch (err) {
      setError(err instanceof SaveStepError ? err.message : `Couldn’t save: ${errorDetail(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) void requestClose();
        }}
      >
        <SheetContent side="right" className="w-full gap-0 sm:max-w-[420px]">
          <SheetHeader className="flex-row items-center gap-3 pr-12">
            {media}
            <div className="flex min-w-0 flex-col gap-1">
              <SheetTitle className="truncate">{title}</SheetTitle>
              {description && <SheetDescription>{description}</SheetDescription>}
            </div>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
            {children}
          </div>
          <SheetFooter className="mt-0 border-t border-(--si-line)">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={saving} onClick={() => void requestClose()}>
                Cancel
              </Button>
              <Button disabled={!dirty || !valid || saving} onClick={() => void handleSave()}>
                {saving && <Spinner data-icon="inline-start" />}
                {saveLabel}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      {confirmElement}
    </>
  );
}
