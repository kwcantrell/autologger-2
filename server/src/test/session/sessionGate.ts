// A session-storage gate (session-content-policies task 5.1, design D8, D12): a registry over the
// harness's adapter whose storage can hold one matching call before it starts, so a test can
// commit a revoke between a route's `requireSession` and its hub call, the session-storage
// counterpart of `GatedCatalog`. The hold runs outside the adapter's transaction, before the call
// takes its connection. Test infrastructure.

import type { SessionCaller } from '@autologger/session-core/sessionCaller';
import { testRegistry } from './sessionRows';
import type { TestRegistry } from './testHub';

export type GateKind = 'tx' | 'snapshot';
export type GateMatch = (kind: GateKind, caller: SessionCaller) => boolean;

export interface HeldCall {
  /** Resolves when the matching call is held. */
  reached: Promise<void>;
  release(): void;
}

export interface SessionGate {
  registry: TestRegistry;
  /** Holds the next storage call `match` accepts (once), before it starts. */
  holdNext(match: GateMatch): HeldCall;
}

export function sessionGate(): SessionGate {
  let next: { match: GateMatch; reached: () => void; release: Promise<void> } | null = null;
  const hold = async (kind: GateKind, caller: SessionCaller): Promise<void> => {
    const n = next;
    if (n?.match(kind, caller)) {
      next = null;
      n.reached();
      await n.release;
    }
  };
  const registry = testRegistry({
    wrap: (inner) => ({
      tx: async (caller, fn) => {
        await hold('tx', caller);
        return inner.tx(caller, fn);
      },
      snapshot: async (caller, fn) => {
        await hold('snapshot', caller);
        return inner.snapshot(caller, fn);
      },
    }),
  });
  return {
    registry,
    holdNext(match) {
      let reached!: () => void;
      let release!: () => void;
      const r = new Promise<void>((res) => {
        reached = res;
      });
      const rel = new Promise<void>((res) => {
        release = res;
      });
      next = { match, reached, release: rel };
      return { reached: r, release };
    },
  };
}

/** The `n`th (from 1) user-bound call of `kind` (any kind when omitted). */
export function nthUserCall(n: number, kind?: GateKind): GateMatch {
  let seen = 0;
  return (k, caller) => caller.kind === 'user' && (kind === undefined || k === kind) && ++seen === n;
}

/** The next call made as the system task `reason`. */
export function systemCall(reason: string): GateMatch {
  return (_k, caller) => caller.kind === 'system' && caller.reason === reason;
}
