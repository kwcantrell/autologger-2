// The wiki turn's catalog port (show-wiki-ai design D3; wiki-generation "Every read runs as the
// caller", "The show is fixed by the session").
//
// `createWikiToolPort` implements ai-runtime's `WikiToolPort` over the catalog the route already
// holds, `c.get('catalog')`, which is bound to the signed-in caller: every read runs under the
// caller's row-level security, and no other binding is made here. RLS alone is not enough,
// because a member can reach several shows: every read is also filtered on the run's show here,
// so a page, suggestion or session of another accessible show reads as missing, and `readPending`
// keeps only pending rows. Another session's words are read through the session hub as the same
// caller, and only after its catalog row shows it belongs to the run's show.

import type {
  WikiSnapshotWord,
  WikiToolPendingDetail,
  WikiToolPort,
} from '@autologger/ai-runtime/wikiTools';
import type { CatalogFacade, WikiSuggestionDetail } from '@autologger/catalog';
import type { SessionCaller, SessionHubRegistryFacade } from '@autologger/session-core';
import type { Context } from 'hono';
import type { AppEnv } from '../appEnv';
import { sessionCaller } from './_helpers';

export interface WikiToolPortDeps {
  /** The catalog bound to the caller (`c.get('catalog')`). */
  catalog: CatalogFacade;
  /** The session hub registry (`c.env.ports.sessions`). */
  sessions: SessionHubRegistryFacade;
  /** The route's caller (`sessionCaller(c)`), for another session's transcript words. */
  caller: SessionCaller;
}

function pendingDetail(s: WikiSuggestionDetail): WikiToolPendingDetail {
  return {
    suggestionId: s.id,
    pageId: s.page_id,
    kind: s.kind,
    title: s.title,
    aliases: s.aliases,
    bodyMd: s.body_md,
  };
}

/** The port for one run: the session `sessionId` of the show `showId`, read as the caller. */
export function createWikiToolPort(
  deps: WikiToolPortDeps,
  showId: string,
  sessionId: string,
): WikiToolPort {
  const wiki = deps.catalog.wiki;
  return {
    showId,
    sessionId,

    async listPages() {
      const [{ pages }, pending] = await Promise.all([
        wiki.listPages(showId),
        wiki.listSuggestions(showId, { status: 'pending' }),
      ]);
      const withPending = new Set(
        pending.suggestions.flatMap((s) => (s.page_id === null ? [] : [s.page_id])),
      );
      return pages.map((p) => ({
        id: p.id,
        kind: p.kind,
        title: p.title,
        aliases: p.aliases,
        revision: p.revision,
        pending: withPending.has(p.id),
      }));
    },

    async listPendingNew() {
      return (await wiki.pendingNewPages(showId)).map((s) => ({
        suggestionId: s.id,
        kind: s.kind,
        title: s.title,
      }));
    },

    async readPage(id) {
      const page = await wiki.getPage(id);
      if (page === null || page.show_id !== showId || page.deleted) return null;
      if (page.merged_into !== null) return { mergedInto: page.merged_into };
      const pending = await wiki.pendingFor(showId, { pageId: page.id });
      return {
        id: page.id,
        kind: page.kind,
        title: page.title,
        aliases: page.aliases,
        revision: page.revision,
        bodyMd: page.body_md,
        pendingSuggestionId: pending?.id ?? null,
      };
    },

    async readPending(suggestionId) {
      const s = await wiki.getSuggestion(suggestionId);
      if (s === null || s.show_id !== showId || s.status !== 'pending') return null;
      return pendingDetail(s);
    },

    async pendingFor(target) {
      const s = await wiki.pendingFor(showId, target);
      return s === null || s.show_id !== showId ? null : pendingDetail(s);
    },

    async sessionWords(id): Promise<WikiSnapshotWord[] | null> {
      const row = await deps.catalog.sessions.getSessionIndexRow(id, { includeHidden: true });
      if (row === null || row.show_id == null || String(row.show_id) !== showId) return null;
      const hub = (await deps.sessions.get(id)).as(deps.caller);
      return (await hub.listTranscriptWords()).map((w) => {
        const startSec = Number(w.start_sec ?? 0);
        return {
          word: String(w.word ?? ''),
          session_time: String(w.session_time ?? ''),
          speaker: String(w.speaker ?? ''),
          start_sec: Number.isFinite(startSec) ? startSec : 0,
        };
      });
    },

    sessionPageId: () => wiki.sessionPageId(showId, sessionId),
    nameHolder: (names) => wiki.nameHolder(showId, names),
    checkLinks: (bodyMd) => wiki.checkLinks(showId, bodyMd),
    normalize: (texts) => wiki.normalize(texts),
  };
}

/** The route's port: the request's caller-bound catalog, the hub registry and the caller. */
export function wikiToolPortFor(
  c: Context<AppEnv>,
  showId: string,
  sessionId: string,
): WikiToolPort {
  return createWikiToolPort(
    { catalog: c.get('catalog'), sessions: c.env.ports.sessions, caller: sessionCaller(c) },
    showId,
    sessionId,
  );
}
