import { useId, useState } from 'react';
import { useSplitWikiPage, wikiVersionConflictOf } from '../../../../api/hooks/useWiki';
import type { WikiPage } from '../../../../api/types';
import { Button, TOUCH_TARGET } from '../../../../shared/components/ui/button';
import { Input } from '../../../../shared/components/ui/input';
import { Label } from '../../../../shared/components/ui/label';
import { RadioGroup, RadioGroupItem } from '../../../../shared/components/ui/radio-group';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { Textarea } from '../../../../shared/components/ui/textarea';
import { Dialog, DialogActions } from '../../../../shared/ui/Dialog';
import { showToast } from '../../utils/toast';
import { SPLIT_KINDS, WIKI_KIND_LABEL } from './wikiKindLabels';

// --- "Split" (show-wiki D7; show-wiki "Merge and split") ---
//
// Two boxes: the text that stays (it starts as the whole body) and the text to move, plus the new
// page's kind (person, topic or running bit; a session page's split defaults to topic), title
// and optional comma-separated aliases. One request moves the text: the source page keeps
// `remaining_body_md`, the new page gets `new_page`. It needs a title and some text to move.

type SplitKind = (typeof SPLIT_KINDS)[number];

interface Props {
  page: WikiPage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function isSplitKind(k: string): k is SplitKind {
  return (SPLIT_KINDS as readonly string[]).includes(k);
}

export function WikiSplitDialog({ page, open, onOpenChange }: Props) {
  const ids = { remaining: useId(), moved: useId(), title: useId(), aliases: useId() };
  const [remaining, setRemaining] = useState(page.body_md);
  const [moved, setMoved] = useState('');
  const [kind, setKind] = useState<SplitKind>(isSplitKind(page.kind) ? page.kind : 'topic');
  const [title, setTitle] = useState('');
  const [aliases, setAliases] = useState('');
  const [error, setError] = useState<string | null>(null);
  const split = useSplitWikiPage();

  const ready = title.trim() !== '' && moved.trim() !== '' && !split.isPending;

  const submit = () => {
    if (!ready) return;
    setError(null);
    const aliasList = aliases
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    split.mutate(
      {
        pageId: page.id,
        body: {
          expected_revision: page.revision,
          remaining_body_md: remaining,
          new_page: {
            kind,
            title: title.trim(),
            body_md: moved,
            ...(aliasList.length ? { aliases: aliasList } : {}),
          },
        },
      },
      {
        onSuccess: ({ new_page }) => {
          showToast(`Moved the text to “${new_page.title}”.`);
          onOpenChange(false);
        },
        onError: (e) =>
          setError(
            wikiVersionConflictOf(e)
              ? 'This page changed since you opened Split. Close it and try again.'
              : e instanceof Error && e.message
                ? e.message
                : 'The page was not split.',
          ),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Split into a new page"
      description="Move part of this page into a new page of the same show."
      className="md:max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.remaining}>Stays on this page</Label>
          <Textarea
            id={ids.remaining}
            value={remaining}
            onChange={(e) => setRemaining(e.target.value)}
            className="min-h-[8rem] font-mono text-[0.85rem]"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.moved}>Moves to the new page</Label>
          <Textarea
            id={ids.moved}
            value={moved}
            placeholder="Cut the text from the box above and paste it here."
            onChange={(e) => setMoved(e.target.value)}
            className="min-h-[8rem] font-mono text-[0.85rem]"
          />
        </div>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1.5 text-sm font-medium text-si-fg">New page kind</legend>
          <RadioGroup
            value={kind}
            onValueChange={(v) => isSplitKind(v) && setKind(v)}
            className="flex flex-wrap gap-4"
          >
            {SPLIT_KINDS.map((k) => (
              <div key={k} className="flex items-center gap-2">
                <RadioGroupItem value={k} id={`${ids.title}-${k}`} />
                <Label htmlFor={`${ids.title}-${k}`}>{WIKI_KIND_LABEL[k]}</Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.title}>New page title</Label>
          <Input
            id={ids.title}
            value={title}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.aliases}>Aliases</Label>
          <Input
            id={ids.aliases}
            value={aliases}
            placeholder="Optional, separated by commas"
            autoComplete="off"
            onChange={(e) => setAliases(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="m-0 text-sm text-v5-danger">
            {error}
          </p>
        )}
      </div>
      <DialogActions>
        <Button
          type="button"
          variant="outline"
          className={TOUCH_TARGET}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button type="button" className={TOUCH_TARGET} disabled={!ready} onClick={submit}>
          {split.isPending && <Spinner role="presentation" aria-hidden="true" />}
          Split
        </Button>
      </DialogActions>
    </Dialog>
  );
}
