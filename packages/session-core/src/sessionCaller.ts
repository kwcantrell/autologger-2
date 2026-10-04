// Who a session hub call runs for (session-content-policies design D2; ADR 0021 slice 7b-2): a
// signed-in user, whose calls run under the database's content policies, or a reviewed system task.
// Only `userCaller` and `systemCaller` make one: the brand makes an object literal a type error
// where a `SessionCaller` is expected, so the reviewed-bindings scan sees every caller
// (`server/src/catalogSystem.repo.test.ts`). Each validates as the catalog adapter's
// `bindUser`/`bindSystem` do, so a bad caller fails where it is made, not on first use.

declare const callerBrand: unique symbol;

/** Who a session hub call runs for. Only `userCaller` and `systemCaller` make one. */
export type SessionCaller =
  | { readonly kind: 'user'; readonly userId: string; readonly [callerBrand]: true }
  | { readonly kind: 'system'; readonly reason: string; readonly [callerBrand]: true };

const REASON = /^[a-z][a-z0-9-]*$/;

/** A call for signed-in user `userId` (a non-empty id, else `TypeError`). */
export function userCaller(userId: string): SessionCaller {
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('userCaller needs a non-empty user id');
  }
  return Object.freeze({ kind: 'user', userId }) as unknown as SessionCaller;
}

/** A call for the reviewed system task `reason` (`[a-z][a-z0-9-]*`, else `TypeError`). */
export function systemCaller(reason: string): SessionCaller {
  if (typeof reason !== 'string' || !REASON.test(reason)) {
    throw new TypeError('systemCaller needs a reason matching [a-z][a-z0-9-]*');
  }
  return Object.freeze({ kind: 'system', reason }) as unknown as SessionCaller;
}
