import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTimelineZoom,
  invalidateEvents,
  isRegistered,
  register,
  reset,
  scrollTimelineToSec,
  seekAudio,
  seekAudioAndPlay,
  setManualScrubSec,
  stopTransportIfNeeded,
  unregister,
} from './registry';

const here = path.dirname(fileURLToPath(import.meta.url));
const registrySource = fs.readFileSync(path.join(here, 'registry.ts'), 'utf8');
const registrySourceFile = ts.createSourceFile(
  'registry.ts',
  registrySource,
  ts.ScriptTarget.Latest,
  true,
);

// The registry is module-scoped singleton state, so — unlike a fresh class
// instance per test — one test's registration is visible to the next
// unless cleared. `reset()` is exactly what `web/src/test/setup.ts` will
// call in `afterEach` once the registry has real owners (task 1.3); this
// file establishes the same discipline directly against the registry API,
// which doubles as its own dogfooding of `reset`.
afterEach(() => {
  reset();
});

describe('invoke is a silent no-op when unregistered', () => {
  it('a void-returning handle does not throw and produces no observable effect', () => {
    expect(() => seekAudio(12)).not.toThrow();
    expect(() => seekAudioAndPlay(12)).not.toThrow();
    expect(() => stopTransportIfNeeded()).not.toThrow();
    expect(() => setManualScrubSec(5)).not.toThrow();
    expect(() => setManualScrubSec(null)).not.toThrow();
    expect(() => scrollTimelineToSec(5)).not.toThrow();
    expect(() => scrollTimelineToSec(5, 100)).not.toThrow();
    expect(() => invalidateEvents()).not.toThrow();
  });

  it('a value-returning handle yields undefined, not a fabricated default', () => {
    expect(getTimelineZoom()).toBeUndefined();
  });
});

describe('register / invoke forwards arguments to the current handler', () => {
  it('seekAudio', () => {
    const handler = vi.fn();
    register('seekAudio', handler);
    seekAudio(42);
    expect(handler).toHaveBeenCalledExactlyOnceWith(42);
  });

  it('seekAudioAndPlay', () => {
    const handler = vi.fn();
    register('seekAudioAndPlay', handler);
    seekAudioAndPlay(42);
    expect(handler).toHaveBeenCalledExactlyOnceWith(42);
  });

  it('stopTransportIfNeeded', () => {
    const handler = vi.fn();
    register('stopTransportIfNeeded', handler);
    stopTransportIfNeeded();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('setManualScrubSec, including a null argument', () => {
    const handler = vi.fn();
    register('setManualScrubSec', handler);
    setManualScrubSec(7);
    setManualScrubSec(null);
    expect(handler).toHaveBeenNthCalledWith(1, 7);
    expect(handler).toHaveBeenNthCalledWith(2, null);
  });

  it('scrollTimelineToSec, with and without the optional totalSec', () => {
    const handler = vi.fn();
    register('scrollTimelineToSec', handler);
    scrollTimelineToSec(3);
    scrollTimelineToSec(3, 90);
    expect(handler).toHaveBeenNthCalledWith(1, 3, undefined);
    expect(handler).toHaveBeenNthCalledWith(2, 3, 90);
  });

  it('getTimelineZoom returns the handler result', () => {
    register('getTimelineZoom', () => 4.5);
    expect(getTimelineZoom()).toBe(4.5);
  });

  it('invalidateEvents', () => {
    const handler = vi.fn();
    register('invalidateEvents', handler);
    invalidateEvents();
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('re-registration replaces the current handler', () => {
  it('a second register call for the same handle supersedes the first', () => {
    const first = vi.fn();
    const second = vi.fn();
    register('invalidateEvents', first);
    register('invalidateEvents', second);
    invalidateEvents();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('teardown clears the handle', () => {
  it('unregister with the currently-registered handler clears it', () => {
    const handler = vi.fn();
    register('invalidateEvents', handler);
    unregister('invalidateEvents', handler);
    invalidateEvents();
    expect(handler).not.toHaveBeenCalled();
    expect(isRegistered('invalidateEvents')).toBe(false);
  });
});

describe('reset clears all registrations', () => {
  it('every handle is unregistered afterwards, regardless of how many were live', () => {
    register('seekAudio', vi.fn());
    register('stopTransportIfNeeded', vi.fn());
    register('getTimelineZoom', () => 2);
    reset();
    expect(isRegistered('seekAudio')).toBe(false);
    expect(isRegistered('stopTransportIfNeeded')).toBe(false);
    expect(isRegistered('getTimelineZoom')).toBe(false);
    expect(getTimelineZoom()).toBeUndefined();
  });
});

describe('StrictMode double-invocation shape', () => {
  it('register -> unregister -> register leaves exactly one live handler', () => {
    const first = vi.fn();
    // Simulates React StrictMode's dev-only double-invoke of a mount effect:
    // effect runs (register), its cleanup runs immediately (unregister),
    // then the effect runs again (register) — all synchronously, no
    // intervening registration from anyone else.
    register('seekAudio', first);
    unregister('seekAudio', first);
    const second = vi.fn();
    register('seekAudio', second);

    seekAudio(9);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith(9);
    expect(isRegistered('seekAudio')).toBe(true);
  });
});

describe('unowned vs registered-to-a-no-op are distinguishable', () => {
  it('isRegistered is false when nothing is registered, true for a handler that does nothing', () => {
    expect(isRegistered('invalidateEvents')).toBe(false);

    const noop = () => {};
    register('invalidateEvents', noop);
    expect(isRegistered('invalidateEvents')).toBe(true);

    // Both states are observably a no-op through invoke alone — isRegistered
    // is the only thing that tells them apart.
    expect(() => invalidateEvents()).not.toThrow();
  });
});

describe('identity-scoped teardown', () => {
  it('a stale owner unregistering with its old handler does not clear a newer registration', () => {
    const ownerA = vi.fn();
    const ownerB = vi.fn();

    register('stopTransportIfNeeded', ownerA);
    register('stopTransportIfNeeded', ownerB); // B supersedes A before A tears down.
    unregister('stopTransportIfNeeded', ownerA); // A's stale teardown.

    expect(isRegistered('stopTransportIfNeeded')).toBe(true);
    stopTransportIfNeeded();
    expect(ownerA).not.toHaveBeenCalled();
    expect(ownerB).toHaveBeenCalledOnce();
  });

  it('a current owner unregistering with its own handler does clear', () => {
    const owner = vi.fn();
    register('stopTransportIfNeeded', owner);
    unregister('stopTransportIfNeeded', owner);

    expect(isRegistered('stopTransportIfNeeded')).toBe(false);
    stopTransportIfNeeded();
    expect(owner).not.toHaveBeenCalled();
  });

  it('unregistering with a handler that was never registered is a no-op, not an error', () => {
    const registered = vi.fn();
    const foreign = vi.fn();
    register('seekAudio', registered);
    expect(() => unregister('seekAudio', foreign)).not.toThrow();
    expect(isRegistered('seekAudio')).toBe(true);
    seekAudio(1);
    expect(registered).toHaveBeenCalledExactlyOnceWith(1);
  });
});

// --- Whole-branch audit finding Important-4(b) ---
//
// Two spec SHALLs govern this module and, until now, neither had an
// enforcing test:
//
//   1. "The registry module SHALL import no other application module" —
//      justified as cycle safety for `navigation.ts -> departureWatcher.ts
//      -> registry` at module evaluation time (registry.ts's own header
//      comment). Checked structurally against the real `registry.ts` source
//      on disk (an AST parse, not a regex — a regex would risk matching the
//      word "import" inside the module's own doc comments, which discuss the
//      import-freedom rule at length).
//   2. "The registry holds exactly these seven handles ... An eighth
//      requires an authorizing change" — checked against `HandlerMap`, the
//      interface registry.ts's own header comment names as "the single
//      declaration site" for every handle's name and signature.
describe('registry module import-freedom (spec: "SHALL import no other application module")', () => {
  it('registry.ts contains no import (or import-equals) declarations', () => {
    const importDeclarations = registrySourceFile.statements.filter(
      (statement) => ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement),
    );
    expect(importDeclarations).toHaveLength(0);
  });
});

describe('registry holds exactly seven declared handles (spec: "An eighth requires an authorizing change")', () => {
  it('HandlerMap declares exactly these seven handle names, in this order', () => {
    const handlerMapDeclaration = registrySourceFile.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'HandlerMap',
    );
    if (!handlerMapDeclaration) {
      throw new Error('registry.ts no longer declares a HandlerMap interface');
    }
    const handleNames = handlerMapDeclaration.members
      .filter(ts.isPropertySignature)
      .map((member) => (member.name as ts.Identifier).text);

    expect(handleNames).toEqual([
      'seekAudio',
      'seekAudioAndPlay',
      'stopTransportIfNeeded',
      'setManualScrubSec',
      'scrollTimelineToSec',
      'getTimelineZoom',
      'invalidateEvents',
    ]);
  });
});
