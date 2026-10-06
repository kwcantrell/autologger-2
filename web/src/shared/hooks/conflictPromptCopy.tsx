// session-edit-conflicts D5 (copy): the "Row changed" prompt a version conflict asks. Values are
// plain React text (never markup) and truncated for display, so a huge field cannot push the
// buttons off-screen. No React state; the caller hands the result to `useVersionedSave`'s
// `prompt`.

import type { ReactNode } from 'react';
import type { ConfirmOptions } from '../ui/ConfirmDialog';

/** One field of the row: the server's `current` value next to the operator's text. The caller
 *  passes every field where the operator's text (the draft or `edit`, plus the patch being sent)
 *  may differ from `current`, siblings included; only the differing ones are listed. */
export interface ConflictField {
  label: string;
  theirs: string | null | undefined;
  yours: string | null | undefined;
}

export type ConflictKind = 'edit' | 'delete';

/** Display cap per value, in characters. */
export const CONFLICT_VALUE_MAX = 200;

function shown(v: string | null | undefined): string {
  const s = v ?? '';
  if (s === '') return '(empty)';
  return s.length > CONFLICT_VALUE_MAX ? `${s.slice(0, CONFLICT_VALUE_MAX)}…` : s;
}

// `ConfirmDialog` wraps the message in a <p>, so each line is an inline-level span made a block.
function Line({ children }: { children: ReactNode }) {
  return <span className="block">{children}</span>;
}

/** The themed three-way decision for a version conflict: an edit offers Overwrite / Keep theirs;
 *  a delete lists the changed fields, then asks "Delete anyway?". */
export function conflictPromptCopy(kind: ConflictKind, fields: ConflictField[]): ConfirmOptions {
  const changed = fields.filter((f) => (f.theirs ?? '') !== (f.yours ?? ''));
  const message = (
    <>
      <Line>Someone else changed this row.</Line>
      {changed.map((f) => (
        <Line key={f.label}>
          {f.label}: theirs “{shown(f.theirs)}”, yours “{shown(f.yours)}”
        </Line>
      ))}
      {kind === 'delete' ? <Line>Delete anyway?</Line> : null}
    </>
  );
  return kind === 'delete'
    ? {
        title: 'Row changed',
        message,
        confirmLabel: 'Delete anyway',
        cancelLabel: 'Keep theirs',
        danger: true,
      }
    : {
        title: 'Row changed',
        message,
        confirmLabel: 'Overwrite',
        cancelLabel: 'Keep theirs',
        danger: true,
      };
}
