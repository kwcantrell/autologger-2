// Catalog search (catalog-search design D5, D7; api-contract-freeze "Search endpoint").
// `GET /api/search` runs one `catalog.search` under the caller's binding: the definer function
// applies the caller's access in every branch, so a filter id the caller can't see gives empty
// groups, like an unknown id. The store holds one of 2 process-wide search slots and sets a 3 s
// statement budget. The route makes no writes and sets no cookie.
//
// - 422: `q` out of 2–200 characters after trimming, or `limit` not a decimal 1–25 (ZodError).
// - 503 timeout: the statement was cancelled (`SearchTimeoutError`) or the catalog transaction ran
//   past its deadline (`CatalogTxTimeoutError`).
// - 503 busy: no search slot freed within 1 s (`SearchBusyError`).

import { SearchBusyError, SearchTimeoutError } from '@autologger/catalog';
import { SEARCH_BUSY_DETAIL, SEARCH_TIMEOUT_DETAIL, searchQuerySchema } from '@autologger/contract';
import { CatalogTxTimeoutError } from '@autologger/storage';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';
import { requireUser } from './_helpers';

export const searchRouter = new Hono<AppEnv>();

searchRouter.get('/api/search', async (c) => {
  requireUser(c);
  const query = searchQuerySchema.parse(c.req.query());
  try {
    const result = await c.get('catalog').search({
      q: query.q,
      studioId: query.studio_id ?? null,
      showId: query.show_id ?? null,
      limit: query.limit,
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof SearchTimeoutError || error instanceof CatalogTxTimeoutError) {
      throw new ApiError(503, SEARCH_TIMEOUT_DETAIL);
    }
    if (error instanceof SearchBusyError) throw new ApiError(503, SEARCH_BUSY_DETAIL);
    throw error;
  }
});
