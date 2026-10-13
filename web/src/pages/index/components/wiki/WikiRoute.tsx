import { PlusIcon, SearchIcon } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useProfile } from '../../../../api/hooks/useProfile';
import {
  useRestoreWikiPage,
  useWikiPages,
  type WikiPageFilters,
} from '../../../../api/hooks/useWiki';
import type { WikiKind, WikiPageListItem } from '../../../../api/types';
import { Button } from '../../../../shared/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '../../../../shared/components/ui/empty';
import { Input } from '../../../../shared/components/ui/input';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../shared/components/ui/tabs';
import { type NewPageKind, NewWikiPageDialog } from './NewWikiPageDialog';
import { WikiPageLink } from './WikiPageLink';

// --- `/wiki`, the active show's wiki (show-wiki D7; show-wiki "Wiki screens") ---
//
// One tab per kind lists that kind's live pages (the server sorts by title), and a Deleted tab
// lists deleted pages with Restore. Only the open tab's list is fetched. The filter matches
// titles and aliases on the client, ignoring case and accents. With no active show the screen
// asks for one (the top bar's show menu chooses it).

type TabId = WikiKind | 'deleted';

const TABS: { id: TabId; label: string; empty: string }[] = [
  { id: 'person', label: 'People', empty: 'No people yet.' },
  { id: 'topic', label: 'Topics', empty: 'No topics yet.' },
  { id: 'bit', label: 'Running bits', empty: 'No running bits yet.' },
  { id: 'session', label: 'Sessions', empty: 'No session pages yet.' },
  { id: 'deleted', label: 'Deleted', empty: 'No deleted pages.' },
];

const ROW =
  'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-ctl px-3 py-2.5 text-left no-underline outline-none transition-colors hover:bg-si-panel-2 focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** Lower-case with accents dropped, so "jose" finds "José". */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function matches(page: WikiPageListItem, needle: string): boolean {
  if (!needle) return true;
  return [page.title, ...page.aliases].some((s) => fold(s).includes(needle));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

function PageMeta({ page }: { page: WikiPageListItem }) {
  return (
    <>
      {page.aliases.length > 0 && (
        <span className="truncate text-xs text-si-muted">Also: {page.aliases.join(', ')}</span>
      )}
      <span className="text-xs text-si-dim">
        {`Updated ${formatDate(page.updated_at_utc)} by ${page.updated_by_name}`}
      </span>
    </>
  );
}

function Status({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-10 text-sm text-si-muted"
    >
      {children}
    </div>
  );
}

function PageList({
  showId,
  tab,
  needle,
  filterText,
}: {
  showId: string;
  tab: (typeof TABS)[number];
  needle: string;
  filterText: string;
}) {
  const deleted = tab.id === 'deleted';
  const filters: WikiPageFilters = deleted ? { deleted: true } : { kind: tab.id as WikiKind };
  const { data, isPending, isError, error, refetch } = useWikiPages(showId, filters);
  const restore = useRestoreWikiPage();
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const pages = useMemo(
    () => (data?.pages ?? []).filter((p) => matches(p, needle)),
    [data, needle],
  );

  if (isError) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center text-sm">
        <p className="m-0 text-si-fg">{error?.message || 'Could not load the wiki.'}</p>
        <Button variant="outline" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (isPending) {
    return (
      <Status>
        <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading pages…
      </Status>
    );
  }
  if (data.pages.length === 0) {
    return <p className="m-0 py-10 text-center text-sm text-si-muted">{tab.empty}</p>;
  }
  if (pages.length === 0) {
    return (
      <p className="m-0 py-10 text-center text-sm text-si-muted">
        No pages match “{filterText.trim()}”.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {restoreError && (
        <p role="alert" className="m-0 px-3 text-sm text-si-fg">
          {restoreError}
        </p>
      )}
      <ul
        aria-label={deleted ? 'Deleted pages' : `${tab.label} pages`}
        className="m-0 flex list-none flex-col p-0"
      >
        {pages.map((page) => (
          <li key={page.id}>
            {deleted ? (
              <div className="flex items-center gap-3 px-3 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium text-si-fg">{page.title}</span>
                  <PageMeta page={page} />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Restore ${page.title}`}
                  disabled={restore.isPending && restore.variables?.pageId === page.id}
                  onClick={() => {
                    setRestoreError(null);
                    restore.mutate(
                      { pageId: page.id, expectedRevision: page.revision },
                      {
                        onError: (e) =>
                          setRestoreError(
                            `Could not restore “${page.title}”: ${e instanceof Error ? e.message : 'try again.'}`,
                          ),
                      },
                    );
                  }}
                >
                  Restore
                </Button>
              </div>
            ) : (
              <WikiPageLink pageId={page.id} data-title={page.title} className={ROW}>
                <span className="w-full truncate font-medium text-si-fg">{page.title}</span>
                <PageMeta page={page} />
              </WikiPageLink>
            )}
          </li>
        ))}
      </ul>
      {data.truncated && (
        <p className="m-0 px-3 text-xs text-si-dim">Showing the first {data.pages.length} pages.</p>
      )}
    </div>
  );
}

export function WikiRoute() {
  const { data: profile, isPending } = useProfile();
  const [tab, setTab] = useState<TabId>('person');
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);

  const showId = profile?.active_show_id ?? null;
  const showName = profile?.shows.find((s) => s.id === showId)?.name ?? '';
  const needle = fold(filter.trim());
  const newKind: NewPageKind = tab === 'topic' || tab === 'bit' ? tab : 'person';

  let body: ReactNode;
  if (isPending && !profile) {
    body = (
      <Status>
        <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading…
      </Status>
    );
  } else if (!showId) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No show chosen</EmptyTitle>
          <EmptyDescription>Choose a show in the top bar to see its wiki.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <>
        <div className="relative min-w-0">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-si-dim"
          />
          <Input
            type="search"
            aria-label="Filter pages"
            placeholder="Filter by title or alias"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9"
          />
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="min-w-0">
          <div className="flex min-w-0 max-md:overflow-x-auto max-md:[scrollbar-width:none]">
            <TabsList variant="line" aria-label="Page kinds">
              {TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {TABS.map((t) => (
            <TabsContent key={t.id} value={t.id} className="pt-3">
              <PageList showId={showId} tab={t} needle={needle} filterText={filter} />
            </TabsContent>
          ))}
        </Tabs>
        <NewWikiPageDialog
          showId={showId}
          open={creating}
          onOpenChange={setCreating}
          initialKind={newKind}
        />
      </>
    );
  }

  return (
    <div
      data-slot="wiki-route"
      className="mx-auto flex w-full max-w-[52rem] flex-col gap-5 px-4 py-6 max-md:px-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="m-0 text-[1.35rem] font-semibold text-si-fg">Wiki</h1>
          {showId && showName && <p className="m-0 truncate text-sm text-si-muted">{showName}</p>}
        </div>
        {showId && (
          <Button onClick={() => setCreating(true)}>
            <PlusIcon data-icon="inline-start" />
            New page
          </Button>
        )}
      </div>
      {body}
    </div>
  );
}
