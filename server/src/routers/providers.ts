// Provider credential routes (byo-ai-providers design D4, D5; api-contract-freeze "Provider
// credential routes"; provider-credentials). Each signed-in user reads, saves, deletes and tests
// their own provider credentials.
//
// - Cookie only: these paths are outside `/api/companion/`, so a device token never authenticates
//   them (the login gate answers 401).
// - The store (`ports.providerCredentials`) holds only ciphertext and has no user RLS: the caller's
//   user id in every store statement is the only isolation between users.
// - A key is write-only: no response carries it, only its last four characters. It is bound to its
//   user, kind, provider and (OpenAI-compatible) base URL origin, so a save that changes the
//   provider or the origin needs the key again (`422`), and a keep-key save is one UPDATE that
//   can't resurrect a deleted or replaced key.
// - The connection test is rate-limited per user before any decryption or outbound request, and
//   answers only the fixed PROVIDER_TEST_DETAIL strings.
// - Save and delete write one audit line with the user id and kind, never the key.
// - The keyless `llm` provider `claude-cli` (ai-sdk-agent-harness D2) is saved only by a caller
//   `claudeCliAllowed` lets use the operator's Claude CLI now (else `403`, nothing stored). Its
//   connection test makes no outbound request and still takes a slot in the window.

import {
  CLAUDE_CLI_PROVIDER,
  PROVIDER_TEST_DETAIL,
  type ProviderKindWire,
  providerKindSchema,
  providerPutBodySchema,
} from '@autologger/contract';
import type { ProviderCredentialRow, ProviderKind } from '@autologger/ports';
import { PROVIDER_TEST_LIMIT } from '@autologger/storage';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../appEnv';
import { normalizeBaseUrl, normalizeOrigin } from '../auth/providerOutbound';
import { claudeCliAllowed, runFeatureAllowed } from '../env';
import { ApiError } from '../httpError';
import { requireUser } from './_helpers';

export const providersRouter = new Hono<AppEnv>();

const NUL_DETAIL = 'Text must not contain NUL characters.';
const NOT_FOUND = 'Not found.';
const NOT_SET_UP = 'Provider not set up.';
const TOO_MANY = 'Too many connection tests. Try again in a minute.';
const CLI_FORBIDDEN = 'The Claude CLI is limited to approved operator accounts.';

function toWire(r: ProviderCredentialRow) {
  return {
    kind: r.kind,
    provider: r.provider,
    base_url: r.base_url,
    model: r.model,
    // Null only on the keyless `claude-cli` row (ai-sdk-agent-harness D2).
    key_last4: r.key?.last4 ?? null,
    updated_at: r.updated_at_utc,
  };
}

function kindParam(raw: string): ProviderKind {
  const parsed = providerKindSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(404, NOT_FOUND);
  return parsed.data satisfies ProviderKindWire;
}

function containsNul(v: unknown): boolean {
  if (typeof v === 'string') return v.includes('\u0000');
  if (Array.isArray(v)) return v.some(containsNul);
  if (v !== null && typeof v === 'object') {
    return Object.entries(v).some(([k, x]) => k.includes('\u0000') || containsNul(x));
  }
  return false;
}

/** The `422` for a keep-key save that matched no row. Raised through a parse, because a ZodError
 * built by hand is not an `Error` in zod 4, and Hono only hands `Error`s to the app's error handler. */
const keyRequired = z.object({
  api_key: z.string({
    error:
      'api_key is required: no key is saved for this provider and host, or the provider or host changed',
  }),
});

providersRouter.get('/api/me/providers', async (c) => {
  const user = requireUser(c);
  const rows = await c.env.ports.providerCredentials.list(user.id);
  const of = (k: ProviderKind) => {
    const r = rows.find((x) => x.kind === k);
    return r ? toWire(r) : null;
  };
  return c.json({
    llm: of('llm'),
    stt: of('stt'),
    run_features_allowed: runFeatureAllowed(c.env.config, user),
    claude_cli_allowed: claudeCliAllowed(c.env.config, user),
  });
});

providersRouter.put('/api/me/providers/:kind', async (c) => {
  const user = requireUser(c);
  const kind = kindParam(c.req.param('kind'));
  const raw: unknown = await c.req.json();
  if (containsNul(raw)) throw new ApiError(400, NUL_DETAIL);
  const production = c.env.config.PROVIDER_DEV_MODE !== true;
  const body = providerPutBodySchema(kind, { production }).parse(raw);
  if (body.provider === CLAUDE_CLI_PROVIDER) {
    // Only `llm` accepts it (the `stt` schema refuses it above).
    if (!claudeCliAllowed(c.env.config, user)) throw new ApiError(403, CLI_FORBIDDEN);
    const cli = await c.env.ports.providerCredentials.putKeyless(user.id, 'llm', CLAUDE_CLI_PROVIDER);
    console.info(`provider credential saved user=${user.id} kind=${kind}`);
    return c.json(toWire(cli));
  }

  const baseUrl =
    body.provider === 'openai-compatible' && body.base_url ? normalizeBaseUrl(body.base_url) : null;
  const origin = baseUrl === null ? null : normalizeOrigin(baseUrl);
  const fields = {
    provider: body.provider,
    base_url: baseUrl,
    base_origin: origin,
    model: body.model,
  };
  const store = c.env.ports.providerCredentials;

  let row: ProviderCredentialRow | null;
  if (body.api_key !== undefined) {
    const key = c.env.ports.providerKeys.encrypt(body.api_key, {
      userId: user.id,
      kind,
      provider: body.provider,
      origin,
    });
    row = await store.put(user.id, kind, { ...fields, key });
  } else {
    row = await store.updateKeepingKey(user.id, kind, fields);
    if (row === null) throw keyRequired.safeParse({}).error;
  }
  console.info(`provider credential saved user=${user.id} kind=${kind}`);
  return c.json(toWire(row));
});

providersRouter.delete('/api/me/providers/:kind', async (c) => {
  const user = requireUser(c);
  const kind = kindParam(c.req.param('kind'));
  if (!(await c.env.ports.providerCredentials.delete(user.id, kind))) {
    throw new ApiError(404, NOT_SET_UP);
  }
  console.info(`provider credential deleted user=${user.id} kind=${kind}`);
  return c.body(null, 204);
});

providersRouter.post('/api/me/providers/:kind/test', async (c) => {
  const user = requireUser(c);
  const kind = kindParam(c.req.param('kind'));
  const store = c.env.ports.providerCredentials;
  const row = await store.get(user.id, kind);
  if (row === null) throw new ApiError(404, NOT_SET_UP);
  if ((await store.takeTestSlot(user.id)) > PROVIDER_TEST_LIMIT) throw new ApiError(429, TOO_MANY);
  // The keyless `claude-cli` row (the catalog check allows no other): no outbound request; it
  // answers whether this caller would get the Claude CLI now.
  if (row.key === null) {
    return c.json(
      claudeCliAllowed(c.env.config, user)
        ? { ok: true, detail: PROVIDER_TEST_DETAIL.connected }
        : { ok: false, detail: PROVIDER_TEST_DETAIL.claudeCliUnavailable },
    );
  }
  const key = c.env.ports.providerKeys.decrypt(row.key, {
    userId: user.id,
    kind,
    provider: row.provider,
    origin: row.base_origin,
  });
  if (key === null) return c.json({ ok: false, detail: PROVIDER_TEST_DETAIL.unreadable });
  const result = await c.env.ports.providerTester.test({
    kind,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    key,
    production: c.env.config.PROVIDER_DEV_MODE !== true,
  });
  return c.json(result);
});
