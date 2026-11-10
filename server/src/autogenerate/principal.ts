// Acting as a batch job's initiator, with no stored secret (OpenSpec change `batch-autogenerate`,
// design D4; core-ports-architecture "Every catalog and session call is bound to a caller": the
// worker is the second, reviewed site that creates a catalog user binding and a user session
// caller). Before each session the worker re-reads the account under its system binding
// (`autogenerate-worker`; a missing or disabled account reads as null), then binds a catalog and
// a session caller to that user, exactly what the auth middleware builds for a request, so every
// statement of the session's steps runs under the initiator's row-level security. Provider
// credentials are resolved by each runner from the user when its step starts.

import { autogenerateWorkerCatalog, type CatalogFacade } from '@autologger/catalog';
import { userCaller } from '@autologger/session-core';
import type { Bindings } from '../appEnv';
import { authUserFromRow, type GenerationPrincipal } from '../generation/principal';

export interface InitiatorBinder {
  /** The initiator's principal, after the system re-read; null for a missing or disabled account. */
  principal(userId: string): Promise<GenerationPrincipal | null>;
  /** The initiator's bindings without the re-read, for a cleanup attempted after the account went
   * (its refusals are tolerated). */
  bind(userId: string): GenerationPrincipal;
}

export function initiatorBinder(root: CatalogFacade, env: Bindings): InitiatorBinder {
  const sys = autogenerateWorkerCatalog(root);
  const bound = (user: GenerationPrincipal['user']): GenerationPrincipal => ({
    user,
    catalog: sys.forUser(user.id),
    caller: userCaller(user.id),
    env,
  });
  return {
    async principal(userId) {
      // The registry snapshot the bound catalog carries is loaded here, as the middleware does.
      await sys.init();
      const row = await sys.auth.authGetUserById(userId);
      return row === null ? null : bound(authUserFromRow(row));
    },
    bind(userId) {
      return bound({
        id: userId,
        email: '',
        google_sub: '',
        given_name: '',
        family_name: '',
        picture_url: '',
      });
    },
  };
}
