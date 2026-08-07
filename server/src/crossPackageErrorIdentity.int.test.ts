// Cross-package error-identity pins (package-split-foundation task 3.2,
// design D8; package-architecture spec "Runtime dependencies checked by
// nominal identity are never duplicated", scenario "Cross-package error
// identity preserved").
//
// WHY THIS EXISTS. `server/src/app.ts`'s onError handler maps
// `err instanceof ZodError` -> 422 and `err instanceof ValidationError` -> 400
// by NOMINAL identity — an `instanceof` check against a class constructor.
// Two hazards the package split could open, silently, at `npm install` time
// rather than at any code-review-visible diff:
//   - a second `zod` install under packages/contract (range drift from the
//     app's zod) would mint its own `ZodError` constructor; a schema failure
//     from a contract-package schema would then throw an instance the app's
//     `instanceof ZodError` check does NOT recognize, and the 422 response
//     silently becomes the unhandled-error 500 fallback instead.
//   - a dual module instance of @autologger/domain (e.g. during a
//     transitional shim window) would mint its own `ValidationError`
//     constructor, with the same silent 400 -> 500 failure mode.
// `zod` is a peerDependency of @autologger/contract precisely to make the
// first hazard structurally impossible (single copy, see
// packageBoundaries.repo.test.ts / `npm ls zod` gate evidence in the apply
// ledger); these two tests are the pin that would actually FAIL if either
// mapping silently regressed to 500 — exercised through the real app
// (`wireApp`), not a unit test of the schema/class in isolation, because the
// property under test is the constructor identity seen by app.ts's
// `instanceof` checks at the wire boundary.
//
// Route choices: POST /api/shows validates its body with
// `showCreateBodySchema` (@autologger/contract, moved in task 3.1) — omitting
// the required `name` field fails that schema. PUT /api/profile's
// settings-write path calls `catalog.studios.saveStudioSettingsBlob`, which
// throws `ValidationError` (@autologger/domain) via `validateSettingsBlob` ->
// `validateCategoriesList` when `settings.categories` is missing/empty — both
// routes already exercise these exact failure modes in
// routers/shows-profile.int.test.ts (the 422-missing-name and
// 400-missing-active-studio-id cases); this file adds the categories-empty
// 400 case and states the cross-package-identity INTENT explicitly, which
// the existing incidental coverage does not.

import { describe, expect, it } from 'vitest';
import { app, env } from './test/harness';

async function activeStudioId(): Promise<string> {
  const res = await app.request('/api/studio', { method: 'GET' }, { ...env });
  return ((await res.json()) as { id: string }).id;
}

describe('cross-package error identity (package-architecture spec, design D8)', () => {
  it('a request failing a contract-package (zod) schema returns 422 with the standard {detail: issues} shape', async () => {
    // showCreateBodySchema (packages/contract/src/schemas.ts) requires
    // `name`; omitting it fails validation before the handler body runs.
    const sid = await activeStudioId();
    const res = await app.request(
      '/api/shows',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ studio_id: sid }),
      },
      { ...env },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: unknown };
    // ZodError.issues is an array of issue objects — this is the shape
    // app.ts's onError sends verbatim (`c.json({ detail: err.issues }, 422)`).
    expect(Array.isArray(body.detail)).toBe(true);
  });

  it('a request triggering a domain-package ValidationError returns 400 with the standard {detail: message} shape', async () => {
    // validateSettingsBlob (packages/domain/src/studio.ts) throws
    // ValidationError when `settings.categories` is missing/empty —
    // PUT /api/profile's settings branch calls it via
    // catalog.studios.saveStudioSettingsBlob, uncaught in the route body
    // (app.ts's onError is the only handler).
    const sid = await activeStudioId();
    const res = await app.request(
      '/api/profile',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active_studio_id: sid, settings: {} }),
      },
      { ...env },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: unknown };
    expect(typeof body.detail).toBe('string');
    expect(body.detail).toBe('Add at least one log category.');
  });
});
