// Shared Hono generics: bindings (Env) + per-request context Variables.

import type { AuthUser, Catalog } from './db/d1';

export interface Variables {
  catalog: Catalog;
  user: AuthUser | null;
  apiTokenAuth: boolean;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
