import { type FormEvent, useId, useState } from 'react';
import { ApiError } from '../../../../api/client';
import { useCreateWikiPage } from '../../../../api/hooks/useWiki';
import type { WikiKind } from '../../../../api/types';
import { Button } from '../../../../shared/components/ui/button';
import { Field, FieldLabel } from '../../../../shared/components/ui/field';
import { Input } from '../../../../shared/components/ui/input';
import { RadioGroup, RadioGroupItem } from '../../../../shared/components/ui/radio-group';
import { Dialog, DialogActions } from '../../../../shared/ui/Dialog';
import { navigate } from '../../navigation';
import { WikiPageLink } from './WikiPageLink';

// "New page" (show-wiki D7; show-wiki "Wiki screens"): asks for the kind and the title, creates
// the page in the active show and opens it. Session pages are made from the session workspace
// (they need the session), so the kinds here are person, topic and running bit. A `409 Title
// already used.` keeps the draft and links to the page holding the title (its `page_id`).

export type NewPageKind = Exclude<WikiKind, 'session'>;

const KINDS: { value: NewPageKind; label: string }[] = [
  { value: 'person', label: 'Person' },
  { value: 'topic', label: 'Topic' },
  { value: 'bit', label: 'Running bit' },
];

/** The `page_id` a wiki 409 names (`Title already used.`, `Session already has a page.`). */
export function conflictPageId(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const id = (e.body as { page_id?: unknown } | undefined)?.page_id;
  return typeof id === 'string' && id ? id : null;
}

interface Props {
  showId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The kind picked when the dialog opens. */
  initialKind: NewPageKind;
}

export function NewWikiPageDialog({ showId, open, onOpenChange, initialKind }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New page">
      {/* Remounted on each open, so the form starts clean on the open tab's kind. */}
      {open && (
        <NewPageForm showId={showId} initialKind={initialKind} onOpenChange={onOpenChange} />
      )}
    </Dialog>
  );
}

function NewPageForm({ showId, initialKind, onOpenChange }: Omit<Props, 'open'>) {
  const ids = useId();
  const [kind, setKind] = useState<NewPageKind>(initialKind);
  const [title, setTitle] = useState('');
  const create = useCreateWikiPage(showId);
  const trimmed = title.trim();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || create.isPending) return;
    create.mutate(
      { kind, title: trimmed },
      {
        onSuccess: (page) => {
          onOpenChange(false);
          navigate(`/wiki/${page.id}`);
        },
      },
    );
  };

  const holder = conflictPageId(create.error);

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <Field>
        <FieldLabel id={`${ids}-kind`}>Kind</FieldLabel>
        <RadioGroup
          aria-labelledby={`${ids}-kind`}
          value={kind}
          onValueChange={(v) => setKind(v as NewPageKind)}
          className="flex flex-wrap gap-4"
        >
          {KINDS.map((k) => (
            <span key={k.value} className="flex items-center gap-2">
              <RadioGroupItem id={`${ids}-${k.value}`} value={k.value} aria-label={k.label} />
              <label htmlFor={`${ids}-${k.value}`} className="text-sm text-si-fg">
                {k.label}
              </label>
            </span>
          ))}
        </RadioGroup>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${ids}-title`}>Title</FieldLabel>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => {
            setTitle(e.target.value);
            if (create.isError) create.reset();
          }}
        />
      </Field>
      {create.isError && (
        <div role="alert" className="flex flex-wrap items-center gap-x-2 text-sm text-si-fg">
          <span>{create.error.message || 'Could not create the page.'}</span>
          {holder && (
            <WikiPageLink
              pageId={holder}
              className="text-sm font-medium text-si-fg underline underline-offset-2"
              onOpen={() => onOpenChange(false)}
            >
              Open that page
            </WikiPageLink>
          )}
        </div>
      )}
      <DialogActions>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!trimmed || create.isPending}>
          Create
        </Button>
      </DialogActions>
    </form>
  );
}
