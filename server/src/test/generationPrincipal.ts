// A generation principal for the runner tests (batch-autogenerate design D4, D6): the same four
// things a request or the batch worker hands a runner, built for a seeded user. Tests are exempt
// from the reviewed binding lists.

import { Catalog } from '@autologger/catalog';
import { parseWikiLinks } from '@autologger/contract';
import { userCaller } from '@autologger/session-core';
import type { Bindings } from '../appEnv';
import { authUserFromRow, type GenerationPrincipal } from '../generation/principal';
import { env as harnessEnv } from './harness';

export async function principalFor(
  userId: string,
  env: Bindings = harnessEnv,
): Promise<GenerationPrincipal> {
  const root = new Catalog(env.ports.catalog.bindSystem('test-seed'), {
    root: env.ports.catalog,
    wikiLinks: parseWikiLinks,
  });
  const row = await root.auth.authGetUserById(userId);
  if (!row) throw new Error(`no user ${userId}`);
  const user = authUserFromRow(row);
  const catalog = root.forUser(userId);
  await catalog.init();
  return { user, catalog, caller: userCaller(userId), env };
}
