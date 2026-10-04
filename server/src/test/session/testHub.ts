// The harness caller and test hubs (session-content-policies D12): the caller the session tests'
// own storage calls run as, and hubs whose storage members are bound to it, so tests that are not
// about access keep calling hub members as they were written. Free of the harness, so the opt-in
// real AI tests can use it. Test infrastructure.

import { systemCaller } from '@autologger/session-core/sessionCaller';
import {
  SessionHub,
  type SessionHubEntry,
  SessionHubRegistry,
  type SessionHubView,
} from '@autologger/session-core/SessionHub';

/** The caller of the harness's own storage calls (session-content-policies D12): a system task, so
 * raw reads and writes see every row. */
export const TEST_CALLER = systemCaller('test-harness');

/** The bound view's public members (a class intersection with the hub's private members would be
 * `never`). */
export type TestHubMembers = Pick<SessionHubView, keyof SessionHubView>;
/** A concrete hub as tests hold it (`testHub`). */
export type TestHub = SessionHub & TestHubMembers;

/** `hub` with its storage members bound to `TEST_CALLER` (session-content-policies D12): a member
 * the hub itself has (the socket members, `as`, `close`, the counters, a test's spies) is the
 * hub's; every other member is `hub.as(TEST_CALLER)`'s. Tests that are not about access use it, so
 * their hub calls stay as they were written. */
const testHubs = new WeakMap<object, object>();

export function testHub<H extends SessionHubEntry>(hub: H): H & TestHubMembers {
  // One proxy per hub, so a hub resolved twice is the same object (identity checks).
  const known = testHubs.get(hub);
  if (known) return known as H & TestHubMembers;
  const view = hub.as(TEST_CALLER);
  const proxy = new Proxy(hub, {
    get(target, prop) {
      const from = prop in target ? target : (view as object);
      const value = Reflect.get(from, prop, from);
      return typeof value === 'function' ? value.bind(from) : value;
    },
  }) as H & TestHubMembers;
  testHubs.set(hub, proxy);
  return proxy;
}

/** `SessionHub.open` with its storage members bound to `TEST_CALLER` (`testHub`). */
export async function openTestHub(
  ...args: Parameters<typeof SessionHub.open>
): Promise<SessionHub & TestHubMembers> {
  return testHub(await SessionHub.open(...args));
}

/** A registry whose `get` resolves `testHub`s (session-content-policies D12). */
export class TestRegistry extends SessionHubRegistry {
  override async get(sessionId: string): Promise<SessionHub & TestHubMembers> {
    return testHub(await super.get(sessionId));
  }
}
