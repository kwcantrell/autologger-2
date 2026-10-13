import { XIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { Textarea } from '@/shared/components/ui/textarea';
import { WikiMarkdown } from './WikiMarkdown';

// The page editor (show-wiki D7; show-wiki "Wiki screens"): the title, Write and Preview tabs over
// the Markdown body, and alias chips. Controlled: the page view owns the draft, so a save that
// gets `409` keeps it. Aliases are trimmed and an exact (case-insensitive) repeat is not added;
// the server drops anything else that collides with the title or an earlier alias.

export interface WikiDraft {
  title: string;
  body: string;
  aliases: string[];
}

interface Props {
  draft: WikiDraft;
  onChange: (draft: WikiDraft) => void;
  /** Session pages have no aliases. */
  showAliases: boolean;
}

export function WikiEditor({ draft, onChange, showAliases }: Props) {
  const titleId = useId();
  const aliasId = useId();
  const [alias, setAlias] = useState('');

  const addAlias = () => {
    const next = alias.trim();
    if (!next) return;
    const lower = next.toLocaleLowerCase();
    if (!draft.aliases.some((a) => a.toLocaleLowerCase() === lower)) {
      onChange({ ...draft, aliases: [...draft.aliases, next] });
    }
    setAlias('');
  };

  return (
    <div data-slot="wiki-editor" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={titleId}>Title</Label>
        <Input
          id={titleId}
          value={draft.title}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </div>

      {showAliases && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={aliasId}>Aliases</Label>
          {draft.aliases.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {draft.aliases.map((a) => (
                <li key={a}>
                  <Badge variant="outline" className="gap-1 pr-1 normal-case tracking-normal">
                    {a}
                    <button
                      type="button"
                      aria-label={`Remove alias ${a}`}
                      className="rounded-sm text-si-dim outline-none hover:text-si-fg focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      onClick={() =>
                        onChange({ ...draft, aliases: draft.aliases.filter((x) => x !== a) })
                      }
                    >
                      <XIcon aria-hidden="true" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Input
              id={aliasId}
              aria-label="Add alias"
              placeholder="Add an alias, then press Enter"
              value={alias}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => setAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addAlias();
                }
              }}
            />
            <Button type="button" variant="outline" onClick={addAlias} disabled={!alias.trim()}>
              Add
            </Button>
          </div>
        </div>
      )}

      <Tabs defaultValue="write" className="gap-2">
        <TabsList variant="line">
          <TabsTrigger value="write">Write</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
        <TabsContent value="write">
          <Textarea
            aria-label="Page text"
            value={draft.body}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
            className="min-h-[18rem] font-mono text-[0.85rem] leading-relaxed"
            spellCheck
          />
          <p className="m-0 mt-1.5 text-xs text-si-dim">
            Markdown. Link a page with <code className="font-mono">[name](wiki:page-id)</code>
            and a moment with <code className="font-mono">[quote](cite:session-id@seconds)</code>.
          </p>
        </TabsContent>
        <TabsContent value="preview">
          <div className="min-h-[18rem] rounded-ctl border border-v5-border px-4 py-2">
            {draft.body.trim() ? (
              <WikiMarkdown body={draft.body} />
            ) : (
              <p className="m-0 py-2 text-sm text-si-muted">Nothing to preview yet.</p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
