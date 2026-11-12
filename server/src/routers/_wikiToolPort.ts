// The wiki turn's catalog port for the routes (show-wiki-ai design D3). `createWikiToolPort` lives
// in `server/src/generation/wikiToolPort.ts` (batch-autogenerate D6), shared with the wiki runner.

import type { WikiToolPort } from '@autologger/ai-runtime/wikiTools';
import type { Context } from 'hono';
import type { AppEnv } from '../appEnv';
import { createWikiToolPort } from '../generation/wikiToolPort';
import { sessionCaller } from './_helpers';

export { createWikiToolPort, type WikiToolPortDeps } from '../generation/wikiToolPort';

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
