import { SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isSearchableQuery, useSearch } from '../../../../api/hooks/useSearch';
import type { SearchResponse } from '../../../../api/types';
import { Button } from '../../../../shared/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../../../../shared/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '../../../../shared/components/ui/dialog';
import { Kbd, KbdGroup } from '../../../../shared/components/ui/kbd';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { isOverlayOpen } from '../../../../shared/ui/overlayOpen';
import { Tooltip } from '../../../../shared/ui/Tooltip';
import { navigate } from '../../navigation';
import { isTypingTarget } from '../ShortcutsDialog';
import { SearchSnippet } from './SearchSnippet';
import { momentLabel, searchPageHref, useSearchChoose } from './searchLinks';

// --- Search palette (catalog-search D9; catalog-search "Command palette and results page") ---
//
// Opens on Cmd/Ctrl-K, or from the top-bar search button whose tooltip names the shortcut (the
// shortcuts dialog's list is fixed by web-session-console, so it is not listed there). The
// shortcut yields to text entry and to any other open dialog, sheet or menu (web-ui-system's
// dialog rules). It searches 200 ms after typing pauses, shows up to 5 results per group, and
// offers "See all results" (`/search?q=`). The server ranks; cmdk's own filter is off.

export const SEARCH_DEBOUNCE_MS = 200;
const PALETTE_LIMIT = 5;

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '');
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';

interface Props {
  /** AppShell's close-session path (a studio change from a result follows it). */
  onCloseSession: () => void;
  /** The open Settings view's discard guard. */
  confirmSwitch?: () => true | Promise<boolean>;
}

function isEmpty(r: SearchResponse): boolean {
  return !r.studios.length && !r.shows.length && !r.sessions.length && !r.moments.length;
}

export function SearchPalette({ onCloseSession, confirmSwitch }: Props) {
  const [open, setOpen] = useState(false);
  // In the parent, not the body: a show or studio switch outlives the closed palette.
  const choose = useSearchChoose({ onCloseSession, confirmSwitch });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return;
      if (e.altKey || e.shiftKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target) || isOverlayOpen(document)) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <Tooltip
        side="bottom"
        content={
          <span className="inline-flex items-center gap-2">
            Search
            <KbdGroup>
              <Kbd>{MOD_KEY}</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </span>
        }
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search"
          className="size-(--h-ctl) shrink-0"
          onClick={() => setOpen(true)}
        >
          <SearchIcon />
        </Button>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="top-[12vh] w-[min(100%_-_2rem,38rem)] ![transform:translate(-50%,0)] overflow-hidden p-0"
        >
          <DialogTitle className="sr-only">Search</DialogTitle>
          <PaletteBody choose={choose} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

type Choose = ReturnType<typeof useSearchChoose>;

/**
 * The palette's contents, mounted only while it is open: the query, its debounce and the search
 * itself start fresh on every open and cost nothing while closed.
 */
function PaletteBody({ choose, onDone }: { choose: Choose; onDone: () => void }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isFetching, isError, error } = useSearch({ q: debounced, limit: PALETTE_LIMIT });

  // Close first, then act: a navigation or a switch guard must not run under the palette.
  const pick = (act: () => unknown) => () => {
    onDone();
    void act();
  };

  const searchable = isSearchableQuery(query);
  const settled = debounced === query && !isFetching;
  const results = searchable && data ? data : null;

  let status: React.ReactNode = null;
  if (!searchable) status = 'Type at least 2 characters to search.';
  else if (isError && settled) status = error?.message || 'Search failed.';
  else if (!results || !settled)
    status = (
      <span className="inline-flex items-center gap-2">
        <Spinner role="presentation" aria-hidden="true" className="size-3.5" /> Searching…
      </span>
    );
  else if (isEmpty(results)) status = `No results for “${query.trim()}”.`;

  return (
    <Command shouldFilter={false} className="bg-transparent text-si-fg">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search sessions, transcripts, topics, events…"
        aria-label="Search"
      />
      <CommandList className="max-h-[min(60vh,28rem)]">
        {status && (
          <div role="status" className="px-3 py-6 text-center text-sm text-si-muted">
            {status}
          </div>
        )}
        {results && results.studios.length > 0 && (
          <CommandGroup heading="Studios">
            {results.studios.map((hit) => (
              <CommandItem
                key={hit.id}
                value={`studio:${hit.id}`}
                onSelect={pick(() => choose.chooseStudio(hit))}
              >
                <span className="truncate">{hit.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {results && results.shows.length > 0 && (
          <CommandGroup heading="Shows">
            {results.shows.map((hit) => (
              <CommandItem
                key={hit.id}
                value={`show:${hit.id}`}
                onSelect={pick(() => choose.chooseShow(hit))}
              >
                <span className="truncate">{hit.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {results && results.sessions.length > 0 && (
          <CommandGroup heading="Sessions">
            {results.sessions.map((hit) => (
              <CommandItem
                key={hit.id}
                value={`session:${hit.id}`}
                onSelect={pick(() => choose.chooseSession(hit))}
                className="flex-col items-start gap-0.5"
              >
                <span className="flex w-full min-w-0 items-baseline gap-2">
                  <span className="truncate font-medium">
                    {hit.title.trim() || 'Untitled session'}
                  </span>
                  {hit.episode && (
                    <span className="shrink-0 text-xs text-si-dim">{hit.episode}</span>
                  )}
                </span>
                {hit.snippet && (
                  <SearchSnippet text={hit.snippet} className="line-clamp-2 text-xs" />
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {results && results.moments.length > 0 && (
          <CommandGroup heading="Moments">
            {results.moments.map((m) => (
              <CommandItem
                key={`${m.kind}:${m.session_id}:${m.id}`}
                value={`moment:${m.kind}:${m.session_id}:${m.id}`}
                onSelect={pick(() => choose.chooseMoment(m))}
                className="flex-col items-start gap-0.5"
              >
                <span className="flex w-full min-w-0 items-baseline gap-2 text-xs text-si-dim">
                  <span data-slot="moment-label" className="shrink-0 font-medium">
                    {momentLabel(m)}
                  </span>
                  <span className="truncate">{m.session_title.trim() || 'Untitled session'}</span>
                </span>
                <SearchSnippet text={m.snippet} className="line-clamp-2 text-sm" />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {searchable && (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="see-all" onSelect={pick(() => navigate(searchPageHref(query)))}>
                <SearchIcon />
                <span>See all results</span>
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
