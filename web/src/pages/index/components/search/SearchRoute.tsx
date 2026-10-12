import { SearchIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useSearch as useLocationSearch } from 'wouter';
import { useProfile } from '../../../../api/hooks/useProfile';
import { isSearchableQuery, useSearch } from '../../../../api/hooks/useSearch';
import type { SearchResponse } from '../../../../api/types';
import { Button } from '../../../../shared/components/ui/button';
import { Input } from '../../../../shared/components/ui/input';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { cn } from '../../../../shared/lib/utils';
import { navigate } from '../../navigation';
import { Select, type SelectOption } from '../Select';
import { SEARCH_DEBOUNCE_MS } from './SearchPalette';
import { SearchSnippet } from './SearchSnippet';
import { MOMENT_KIND_LABEL, useSearchChoose } from './searchLinks';

// --- The `/search` results page (catalog-search D9; catalog-search "Command palette and results
// page"; web-session-routing "Search route is a first-class app route") ---
//
// The URL is the state: `q`, `studio_id` and `show_id` are read from it, and every edit REPLACES
// the entry (Back leaves the page rather than stepping through keystrokes). Each group shows up
// to 25 results. Empty filters are left out of the request (the server reads `studio_id=` as an
// id). Choosing a result routes exactly as the palette does (`useSearchChoose`).

const PAGE_LIMIT = 25;
// Radix Select has no empty value; this stands for "no filter" and never reaches the URL.
const ALL = '__all__';

interface Props {
  /** AppShell's close-session path. */
  onCloseSession: () => void;
  /** The open Settings view's discard guard. */
  confirmSwitch?: () => true | Promise<boolean>;
}

interface PageState {
  q: string;
  studioId: string;
  showId: string;
}

function searchPageUrl({ q, studioId, showId }: PageState): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (studioId) params.set('studio_id', studioId);
  if (showId) params.set('show_id', showId);
  const s = params.toString();
  return s ? `/search?${s}` : '/search';
}

function isEmpty(r: SearchResponse): boolean {
  return !r.studios.length && !r.shows.length && !r.sessions.length && !r.moments.length;
}

const RESULT_BUTTON =
  'flex w-full min-w-0 flex-col items-start gap-1 rounded-ctl px-3 py-2.5 text-left outline-none transition-colors hover:bg-si-panel-2 focus-visible:ring-[3px] focus-visible:ring-ring/50';

function ResultGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h2 id={id} className="m-0 px-3 text-xs font-semibold tracking-wide text-si-dim uppercase">
        {title}
      </h2>
      <ul className="m-0 flex list-none flex-col p-0">{children}</ul>
    </section>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export function SearchRoute({ onCloseSession, confirmSwitch }: Props) {
  const search = useLocationSearch();
  const state = useMemo<PageState>(() => {
    const p = new URLSearchParams(search);
    return {
      q: p.get('q') ?? '',
      studioId: p.get('studio_id') ?? '',
      showId: p.get('show_id') ?? '',
    };
  }, [search]);
  const replace = (next: Partial<PageState>) =>
    navigate(searchPageUrl({ ...state, ...next }), { replace: true });

  // The first render searches the URL's query at once; later edits wait for typing to pause.
  const [debouncedQ, setDebouncedQ] = useState(state.q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(state.q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [state.q]);

  const { data, isPending, isFetching, isError, error, refetch } = useSearch({
    q: debouncedQ,
    studioId: state.studioId,
    showId: state.showId,
    limit: PAGE_LIMIT,
  });
  const choose = useSearchChoose({ onCloseSession, confirmSwitch });

  const { data: profile } = useProfile();
  const studios = profile?.auth.user?.teams ?? profile?.studios ?? [];
  const shows = (profile?.shows ?? []).filter(
    (s) => !state.studioId || s.studio_id === state.studioId,
  );
  const studioOptions: SelectOption[] = [
    { value: ALL, label: 'All studios' },
    ...studios.map((s) => ({ value: s.id, label: s.name })),
  ];
  const showOptions: SelectOption[] = [
    { value: ALL, label: 'All shows' },
    ...shows.map((s) => ({ value: s.id, label: s.name })),
  ];

  const chooseStudioFilter = (value: string) => {
    const studioId = value === ALL ? '' : value;
    const show = profile?.shows.find((s) => s.id === state.showId);
    const keepShow = !studioId || !show || show.studio_id === studioId;
    replace({ studioId, showId: keepShow ? state.showId : '' });
  };

  const searchable = isSearchableQuery(state.q);
  const waiting = debouncedQ !== state.q || isPending || (isFetching && !data);
  const results = searchable && data ? data : null;

  let body: ReactNode;
  if (!searchable) {
    body = (
      <p className="m-0 py-10 text-center text-sm text-si-muted">
        Type at least 2 characters to search sessions, transcripts, topics and events.
      </p>
    );
  } else if (isError && !waiting) {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center text-sm">
        <p className="m-0 text-si-fg">{error?.message || 'Search failed.'}</p>
        <Button variant="outline" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (!results || waiting) {
    body = (
      <div
        role="status"
        className="flex items-center justify-center gap-2 py-10 text-sm text-si-muted"
      >
        <Spinner role="presentation" aria-hidden="true" className="size-4" /> Searching…
      </div>
    );
  } else if (isEmpty(results)) {
    body = (
      <p className="m-0 py-10 text-center text-sm text-si-muted">
        No results for “{state.q.trim()}”.
      </p>
    );
  } else {
    body = (
      <div className="flex flex-col gap-6">
        {results.studios.length > 0 && (
          <ResultGroup title="Studios">
            {results.studios.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className={RESULT_BUTTON}
                  onClick={() => void choose.chooseStudio(hit)}
                >
                  <span className="truncate font-medium text-si-fg">{hit.name}</span>
                </button>
              </li>
            ))}
          </ResultGroup>
        )}
        {results.shows.length > 0 && (
          <ResultGroup title="Shows">
            {results.shows.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className={RESULT_BUTTON}
                  onClick={() => void choose.chooseShow(hit)}
                >
                  <span className="truncate font-medium text-si-fg">{hit.name}</span>
                  <span className="text-xs text-si-dim">
                    {studios.find((s) => s.id === hit.studio_id)?.name ?? ''}
                  </span>
                </button>
              </li>
            ))}
          </ResultGroup>
        )}
        {results.sessions.length > 0 && (
          <ResultGroup title="Sessions">
            {results.sessions.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className={RESULT_BUTTON}
                  onClick={() => choose.chooseSession(hit)}
                >
                  <span className="flex w-full min-w-0 items-baseline gap-2">
                    <span className="truncate font-medium text-si-fg">
                      {hit.title.trim() || 'Untitled session'}
                    </span>
                    {hit.episode && (
                      <span className="shrink-0 text-xs text-si-dim">{hit.episode}</span>
                    )}
                    <span className="ml-auto shrink-0 font-tc text-xs text-si-dim">
                      {formatDate(hit.started_at_utc)}
                    </span>
                  </span>
                  {hit.snippet && <SearchSnippet text={hit.snippet} className="text-sm" />}
                </button>
              </li>
            ))}
          </ResultGroup>
        )}
        {results.moments.length > 0 && (
          <ResultGroup title="Moments">
            {results.moments.map((m) => (
              <li key={`${m.kind}:${m.session_id}:${m.id}`}>
                <button
                  type="button"
                  className={RESULT_BUTTON}
                  onClick={() => choose.chooseMoment(m)}
                >
                  <span className="flex w-full min-w-0 items-baseline gap-2 text-xs text-si-dim">
                    <span className="shrink-0 font-medium tracking-wide uppercase">
                      {MOMENT_KIND_LABEL[m.kind]}
                    </span>
                    <span className="truncate">{m.session_title.trim() || 'Untitled session'}</span>
                    {m.speaker && <span className="shrink-0">· {m.speaker}</span>}
                  </span>
                  <SearchSnippet text={m.snippet} className="text-sm" />
                </button>
              </li>
            ))}
          </ResultGroup>
        )}
      </div>
    );
  }

  return (
    <div
      data-slot="search-route"
      className="mx-auto flex w-full max-w-[52rem] flex-col gap-5 px-4 py-6 max-md:px-3"
    >
      <h1 className="m-0 text-[1.35rem] font-semibold text-si-fg">Search</h1>
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-si-dim"
          />
          <Input
            type="search"
            aria-label="Search"
            placeholder="Search sessions, transcripts, topics, events…"
            value={state.q}
            onChange={(e) => replace({ q: e.target.value })}
            className="pl-9"
          />
        </div>
        <div className={cn('flex gap-2 max-md:[&>*]:flex-1')}>
          <Select
            ariaLabel="Studio filter"
            value={state.studioId || ALL}
            options={studioOptions}
            onChange={chooseStudioFilter}
            className="md:w-44"
          />
          <Select
            ariaLabel="Show filter"
            value={state.showId || ALL}
            options={showOptions}
            onChange={(v) => replace({ showId: v === ALL ? '' : v })}
            className="md:w-44"
          />
        </div>
      </div>
      {body}
    </div>
  );
}
