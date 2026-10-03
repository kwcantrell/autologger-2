// session-content-policies design D5, D12 (task 4.2): the lock decides, and a revoke inside a hub
// body is not prevented. The owner's write commits with its projection. A grant revoked through a
// second connection after the lock, before a later insert, fails that write: nothing is saved and
// no frame is sent. A grant revoked before an `updateEvent`'s read makes the body a committed no-op,
// and the route answers its own `404 Event not found.`.

import { AsyncResource } from 'node:async_hooks';
import { systemCaller, userCaller } from '@autologger/session-core/sessionCaller';
import { SessionProjectionError } from '@autologger/session-core/sessionCore';
import { CatalogForbiddenError } from '@autologger/storage';
import type { SessionHubRegistry, SessionHubRegistryFacade } from '@autologger/session-core/SessionHub';
import { afterEach, describe, expect, it } from 'vitest';
import { app, envWith } from '../harness';
import { catalogFor, loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../helpers';
import { slowStorage } from './slowStorage';
import { testRegistry } from './sessionRows';

const CTX = { frameRate: 24, startOffsetFrames: 0 };
const event = (message: string) => ({
  category: 'cam',
  message,
  metadataJson: '{}',
  markedAtUtc: null,
  ctx: CTX,
});
const SYS = systemCaller('test-harness');

/** Team T with an owner and a member granted the show; one session. */
async function grantedSession() {
  const studio = await seedStudio();
  const owner = await seedUser({ studios: [studio], role: 'owner' });
  const member = await seedUser({ studios: [studio] });
  const show = await seedShow({ studioId: studio });
  await catalogFor().auth.authGrantShow(member, show, owner, new Date().toISOString());
  const session = await seedSession({ showId: show });
  return { studio, owner, member, show, session };
}

/** A registry whose storage runs `onStatement` before each statement. */
function hookedRegistry(onStatement: (sql: string) => Promise<void> | void) {
  return testRegistry({
    wrap: (s) => slowStorage(s, { delayMs: 0, hooks: { beforeStatement: onStatement } }),
  });
}

const registries: SessionHubRegistry[] = [];
afterEach(async () => {
  for (const r of registries.splice(0)) await r.closeAll();
});

describe('the policy window (session-content-policies D5)', () => {
  it("the owner's write commits, with its projection equal to ensure()", async () => {
    const { owner, session } = await grantedSession();
    const registry = testRegistry();
    registries.push(registry);
    const view = (await registry.get(session)).as(userCaller(owner));
    const { projection } = await view.addEvent(event('mine'));
    expect(projection.event_count).toBe(1);
    expect(await view.ensure()).toEqual(projection);
  });

  it('a revoke committed mid-body fails a later insert: nothing saved, no frame', async () => {
    const { member, show, session } = await grantedSession();
    let armed = false;
    const outside = new AsyncResource('another-request');
    const registry = hookedRegistry(async (sql) => {
      if (armed && /^\s*INSERT INTO session_events/i.test(sql)) {
        armed = false;
        // A second connection commits the revoke while the body holds the session row (run
        // outside the body's async context, as another request would).
        await outside.runInAsyncScope(() => catalogFor().auth.authRevokeShow(member, show));
      }
    });
    registries.push(registry);
    const hub = await registry.get(session);
    const frames: unknown[] = [];
    hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
    const view = hub.as(userCaller(member));
    await view.addEvent(event('before'));
    frames.length = 0;
    armed = true;
    const err = await view.addEvent(event('during')).catch((e: unknown) => e);
    expect(armed).toBe(false);
    expect(
      err instanceof CatalogForbiddenError || err instanceof SessionProjectionError,
      String(err),
    ).toBe(true);
    expect(frames).toEqual([]);
    const stored = await hub.as(SYS).exportEvents();
    expect(stored.map((e) => e.message)).toEqual(['before']);
  });

  it("a revoke before an updateEvent's read commits a no-op, and PUT answers 404 Event not found.", async () => {
    const { member, show, session } = await grantedSession();
    let armed = false;
    const outside = new AsyncResource('another-request');
    const registry = hookedRegistry(async (sql) => {
      if (armed && /FROM session_events/i.test(sql)) {
        armed = false;
        await outside.runInAsyncScope(() => catalogFor().auth.authRevokeShow(member, show));
      }
    });
    registries.push(registry);
    const hub = await registry.get(session);
    const { event: created } = await hub.as(SYS).addEvent(event('original'));
    const frames: unknown[] = [];
    hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
    const cookie = await loginCookie(member);
    armed = true;
    const res = await app.request(
      `/api/sessions/${session}/events/${created.event_id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          category: 'cam',
          message: 'edited',
          wall_time_utc: created.wall_time_utc,
          timecode_hms: '00:00:01',
        }),
      },
      envWith({}, { sessions: registry as SessionHubRegistryFacade }),
    );
    expect(armed).toBe(false);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Event not found.' });
    expect(frames).toEqual([]);
    const stored = await hub.as(SYS).exportEvents();
    expect(stored.map((e) => e.message)).toEqual(['original']);
  });
});
