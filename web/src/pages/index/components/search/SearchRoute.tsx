import { SearchIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useSearch as useLocationSearch } from 'wouter';
import { useProfile } from '../../../../api/hooks/useProfile';
import { isSearchableQuery, useSearch } from '../../../../api/hooks/useSearch';
import type { SearchMoment, SearchResponse } from '../../../../api/types';
import { Button } from '../../../../shared/components/ui/button';
import { Input } from '../../../../shared/components/ui/input';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { cn } from '../../../../shared/lib/utils';
import { navigate } from '../../navigation';
import { Select, type SelectOption } from '../Select';
import { SEARCH_DEBOUNCE_MS } from './SearchPalette';
import { SearchSnippet } from './SearchSnippet';
import { momentLabel, sessionHref, useSearchChoose } from './searchLinks';

// --- The `/search` results page (catalog-search D9; catalog-search "Command palette and results
// page"; web-session-routing "Search route is a first-class app route") ---
//
// The URL is the state: `q`, `studio_id` and `show_id` are read from it, and every edit REPLACES
// the entry (Back leaves the page rather than stepping through keystrokes). Each group shows up
// to 25 results. Empty filters are left out of the request (the server reads `studio_id=` as an
// id). Choosing a result routes exactly as the palette does (`useSearchChoose`).
//
// Moments are grouped under their session (D11.3): the search's own (at most 3 per session)
// first, then "Show N more in this session", N = min(total, 25) − shown, which asks for that
// session's moments (`session_id`, limit 25, the same filters) and lists them in place. Past 25 the
// group says how many there are and links to the session. A new search collapses every group.

const PAGE_LIMIT = 25;
/** What one "Show more" can list for a session (the API's largest `limit`). */
const SESSION_LIMIT = 25;
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

/** The "Moments" region: its own session sub-groups hold the lists. */
function MomentsGroup({ children }: { children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h2 id={id} className="m-0 px-3 text-xs font-semibold tracking-wide text-si-dim uppercase">
        Moments
      </h2>
      {children}
    </section>
  );
}

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

type Choose = ReturnType<typeof useSearchChoose>;

interface SearchFilters {
  q: string;
  studioId: string;
  showId: string;
}

function MomentItem({ m, choose }: { m: SearchMoment; choose: Choose }) {
  return (
    <li>
      <button type="button" className={RESULT_BUTTON} onClick={() => choose.chooseMoment(m)}>
        <span data-slot="moment-label" className="text-xs font-medium tracking-wide text-si-dim">
          {momentLabel(m)}
        </span>
        <SearchSnippet text={m.snippet} className="text-sm" />
      </button>
    </li>
  );
}

function MomentList({ moments, choose }: { moments: SearchMoment[]; choose: Choose }) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {moments.map((m) => (
        <MomentItem key={`${m.kind}:${m.session_id}:${m.id}`} m={m} choose={choose} />
      ))}
    </ul>
  );
}

function SessionGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-0.5">
      <h3 id={id} className="m-0 truncate px-3 pt-1 text-sm font-medium text-si-fg">
        {title.trim() || 'Untitled session'}
      </h3>
      {children}
    </section>
  );
}

/** One session's moments after "Show more": up to 25 from a `session_id` search, the first ones
 * kept while it loads or if it fails. */
function ExpandedSession({
  sessionId,
  initial,
  total,
  filters,
  choose,
}: {
  sessionId: string;
  initial: SearchMoment[];
  total: number;
  filters: SearchFilters;
  choose: Choose;
}) {
  const { data, isError, error, refetch } = useSearch({
    ...filters,
    sessionId,
    limit: SESSION_LIMIT,
  });
  const moments = data?.moments ?? initial;
  const sessionTotal =
    data?.moment_sessions.find((t) => t.session_id === sessionId)?.total ?? total;
  const href = sessionHref(sessionId);
  return (
    <>
      <MomentList moments={moments} choose={choose} />
      {isError ? (
        <div role="alert" className="flex items-center gap-2 px-3 text-xs text-si-fg">
          <span>{error?.message || 'Search failed.'}</span>
          <Button variant="link" size="xs" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : !data ? (
        <div role="status" className="flex items-center gap-2 px-3 text-xs text-si-muted">
          <Spinner role="presentation" aria-hidden="true" className="size-3" /> Loading this
          session’s matches…
        </div>
      ) : (
        sessionTotal > moments.length && (
          <p className="m-0 flex flex-wrap items-center gap-x-2 px-3 text-xs text-si-dim">
            <span>
              Showing {moments.length} of {sessionTotal} matches in this session
            </span>
            <Button asChild variant="link" size="xs" className="px-0">
              <a
                href={href}
                onClick={(e) => {
                  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  navigate(href);
                }}
              >
                Open session
              </a>
            </Button>
          </p>
        )
      )}
    </>
  );
}

/** The moments group: one sub-group per session, in the order the search ranked them. */
function MomentsBySession({
  results,
  filters,
  choose,
}: {
  results: SearchResponse;
  filters: SearchFilters;
  choose: Choose;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const groups = useMemo(() => {
    const bySession = new Map<string, SearchMoment[]>();
    for (const m of results.moments) {
      const list = bySession.get(m.session_id);
      if (list) list.push(m);
      else bySession.set(m.session_id, [m]);
    }
    const totals = new Map(results.moment_sessions.map((t) => [t.session_id, t.total]));
    return [...bySession].map(([sessionId, moments]) => ({
      sessionId,
      moments,
      title: moments[0]?.session_title ?? '',
      total: Math.max(totals.get(sessionId) ?? 0, moments.length),
    }));
  }, [results]);

  return (
    <div className="flex flex-col gap-3">
      {groups.map(({ sessionId, moments, title, total }) => {
        const more = Math.min(total, SESSION_LIMIT) - moments.length;
        return (
          <SessionGroup key={sessionId} title={title}>
            {expanded.has(sessionId) ? (
              <ExpandedSession
                sessionId={sessionId}
                initial={moments}
                total={total}
                filters={filters}
                choose={choose}
              />
            ) : (
              <>
                <MomentList moments={moments} choose={choose} />
                {more > 0 && (
                  <Button
                    variant="link"
                    size="xs"
                    className="self-start px-3"
                    onClick={() => setExpanded((s) => new Set(s).add(sessionId))}
                  >
                    Show {more} more in this session
                  </Button>
                )}
              </>
            )}
          </SessionGroup>
        );
      })}
    </div>
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
          <MomentsGroup>
            <MomentsBySession
              key={`${debouncedQ}\n${state.studioId}\n${state.showId}`}
              results={results}
              filters={{ q: debouncedQ, studioId: state.studioId, showId: state.showId }}
              choose={choose}
            />
          </MomentsGroup>
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
