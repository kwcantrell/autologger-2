// src/upgradeDispatch.test.ts — unit tier (plain node, no bindings/real Next/
// real server): the pure routing decision, the stub-capture technique, and
// the installed listener's dispatch behavior against fake sockets/servers.
// nextjs-frontend-migration task 3.3 — see upgradeDispatch.ts's module header
// for why this exists as a separate, directly-testable file rather than
// inline logic in main.ts (which boots a real listening server at module
// load and is not test-bootable).

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Config } from '@autologger/ports';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureHonoUpgradeHandler,
  decideUpgradeRoute,
  installUpgradeDispatcher,
  type UpgradeCapableServer,
} from './upgradeDispatch';

// A fully-populated fake Config — only IP_ALLOWLIST/TRUST_PROXY are read by
// the code under test, but the type is a plain data interface with no
// optional/default fields, so every member needs a value.
const baseConfig: Config = {
  PUBLIC_BASE_URL: 'https://example.com',
  HOST: '127.0.0.1',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  REQUIRE_LOGIN: '0',
  SESSION_COOKIE: 'autologger_sid',
  SESSION_DAYS: '14',
  NEW_USER_ALL_TEAMS: '0',
  COOKIE_SECURE: '',
  IP_ALLOWLIST: '',
  TRUST_PROXY: '',
  API_TOKEN: '',
  ADMIN_TOKEN: '',
  DEEPGRAM_API_KEY: '',
  DEEPGRAM_MODEL: '',
  CLAUDE_CLI_PATH: '',
  AI_CHAT_TIMEOUT_SEC: '',
  AI_CHAT_MAX_CONCURRENT: '',
  AI_CHAT_MAX_BUDGET_USD: '',
  TOPIC_GENERATE_MAX_BUDGET_USD: '',
  TOPIC_GENERATE_TIMEOUT_SEC: '',
  EVENT_GENERATE_MAX_BUDGET_USD: '',
  EVENT_GENERATE_TIMEOUT_SEC: '',
  EVENT_GENERATE_MAX_CREATED_EVENTS: '',
  EVENT_GENERATE_MAX_INSTRUCTION_BYTES: '',
  EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: '',
  AI_V2_ENABLED: '',
  AI_V2_API_KEY: '',
  AI_V2_MAX_BUDGET_USD: '',
  AI_V2_CREDENTIAL_SOURCE_PATH: '/tmp/upgrade-dispatch-test-does-not-exist',
};

describe('decideUpgradeRoute (pure)', () => {
  it('routes /api/* to Hono regardless of allowlist/dev/frontend state', () => {
    for (const allowed of [true, false]) {
      for (const dev of [true, false]) {
        for (const frontendAvailable of [true, false]) {
          expect(
            decideUpgradeRoute({ path: '/api/sessions/abc/ws', dev, frontendAvailable, allowed }),
          ).toBe('api');
        }
      }
    }
  });

  it('treats the bare /api path (no trailing slash) as api too', () => {
    expect(
      decideUpgradeRoute({ path: '/api', dev: true, frontendAvailable: true, allowed: true }),
    ).toBe('api');
  });

  it('destroys a non-/api upgrade that fails the allowlist decision, in dev or prod', () => {
    expect(
      decideUpgradeRoute({ path: '/_next/webpack-hmr', dev: true, frontendAvailable: true, allowed: false }),
    ).toBe('destroy');
    expect(
      decideUpgradeRoute({ path: '/_next/webpack-hmr', dev: false, frontendAvailable: true, allowed: false }),
    ).toBe('destroy');
  });

  it('routes an allowed non-/api upgrade to the frontend only in dev with a frontend available', () => {
    expect(
      decideUpgradeRoute({ path: '/_next/webpack-hmr', dev: true, frontendAvailable: true, allowed: true }),
    ).toBe('frontend');
  });

  it('destroys an allowed non-/api upgrade in prod even though it passed the allowlist (D6.5)', () => {
    expect(
      decideUpgradeRoute({ path: '/_next/webpack-hmr', dev: false, frontendAvailable: true, allowed: true }),
    ).toBe('destroy');
  });

  it('destroys an allowed non-/api upgrade in dev when no frontend is available (API-only / HTTP-test callers)', () => {
    expect(
      decideUpgradeRoute({ path: '/_next/webpack-hmr', dev: true, frontendAvailable: false, allowed: true }),
    ).toBe('destroy');
  });
});

describe('captureHonoUpgradeHandler', () => {
  it('captures the handler injectWebSocket registers via server.on("upgrade", ...) without installing it anywhere real', () => {
    let registeredOn: unknown;
    const marker = () => {};
    const fakeInjectWebSocket = (server: UpgradeCapableServer) => {
      registeredOn = server;
      server.on('upgrade', marker);
    };
    const captured = captureHonoUpgradeHandler(fakeInjectWebSocket);
    expect(captured).toBe(marker);
    // The stub object passed in is never the real server — captureHonoUpgradeHandler
    // constructs its own throwaway stub, proving nothing is installed on a real server.
    expect(registeredOn).not.toBeUndefined();
  });

  it('throws if injectWebSocket never registers an "upgrade" listener (signals an @hono/node-ws contract change)', () => {
    const fakeInjectWebSocket = () => {
      // deliberately registers nothing
    };
    expect(() => captureHonoUpgradeHandler(fakeInjectWebSocket)).toThrow(/upgrade/i);
  });
});

describe('installUpgradeDispatcher', () => {
  function fakeReq(url: string, remoteAddress = '203.0.113.9'): IncomingMessage {
    return {
      url,
      headers: {},
      socket: { remoteAddress },
    } as unknown as IncomingMessage;
  }

  function fakeSocket(): Duplex & { destroy: ReturnType<typeof vi.fn> } {
    return { destroy: vi.fn() } as unknown as Duplex & { destroy: ReturnType<typeof vi.fn> };
  }

  const head = Buffer.alloc(0);

  function install(opts: {
    config?: Config;
    dev?: boolean;
    frontend?: { upgradeHandler: ReturnType<typeof vi.fn> } | null;
  }) {
    const onCalls: Array<[string, (...args: unknown[]) => unknown]> = [];
    const server: UpgradeCapableServer = {
      on: vi.fn((event, handler) => {
        onCalls.push([event, handler as (...args: unknown[]) => unknown]);
      }) as unknown as UpgradeCapableServer['on'],
    };
    const honoUpgrade = vi.fn();
    installUpgradeDispatcher({
      server,
      honoUpgrade,
      // biome-ignore lint: test stub shape matches NextFrontend's used surface only
      frontend: opts.frontend as never,
      dev: opts.dev ?? true,
      config: opts.config ?? baseConfig,
    });
    expect(onCalls).toHaveLength(1);
    expect(onCalls[0][0]).toBe('upgrade');
    const listener = onCalls[0][1] as (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
    return { listener, honoUpgrade, server };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs exactly one real "upgrade" listener on the server', () => {
    const { server } = install({});
    expect((server.on as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('routes /api/* to the captured Hono handler, untouched by the allowlist/frontend', () => {
    const { listener, honoUpgrade } = install({
      config: { ...baseConfig, IP_ALLOWLIST: '10.0.0.0/8' }, // would fail the allowlist if checked
      dev: false,
      frontend: null,
    });
    const req = fakeReq('/api/sessions/abc/ws');
    const socket = fakeSocket();
    listener(req, socket, head);
    expect(honoUpgrade).toHaveBeenCalledWith(req, socket, head);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('routes a non-/api upgrade to the frontend when allowlist is open, dev, and a frontend is present', async () => {
    const upgradeHandler = vi.fn().mockResolvedValue(undefined);
    const { listener, honoUpgrade } = install({
      config: baseConfig, // IP_ALLOWLIST empty ⇒ open
      dev: true,
      frontend: { upgradeHandler },
    });
    const req = fakeReq('/_next/webpack-hmr');
    const socket = fakeSocket();
    listener(req, socket, head);
    await new Promise((r) => setImmediate(r));
    expect(upgradeHandler).toHaveBeenCalledWith(req, socket, head);
    expect(honoUpgrade).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('destroys a non-/api upgrade whose client fails a configured IP_ALLOWLIST, before reaching the frontend', () => {
    const upgradeHandler = vi.fn();
    const { listener } = install({
      config: { ...baseConfig, IP_ALLOWLIST: '198.51.100.0/24' },
      dev: true,
      frontend: { upgradeHandler },
    });
    const req = fakeReq('/_next/webpack-hmr', '203.0.113.9'); // outside the allowlist
    const socket = fakeSocket();
    listener(req, socket, head);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(upgradeHandler).not.toHaveBeenCalled();
  });

  it('destroys a non-/api upgrade in production even when the allowlist passes (spec: prod destroys non-API upgrades)', () => {
    const upgradeHandler = vi.fn();
    const { listener } = install({
      config: baseConfig, // open allowlist
      dev: false,
      frontend: { upgradeHandler },
    });
    const req = fakeReq('/_next/webpack-hmr');
    const socket = fakeSocket();
    listener(req, socket, head);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(upgradeHandler).not.toHaveBeenCalled();
  });

  it('destroys a non-/api upgrade in dev when no frontend was constructed (API-only boot)', () => {
    const { listener } = install({ config: baseConfig, dev: true, frontend: null });
    const req = fakeReq('/_next/webpack-hmr');
    const socket = fakeSocket();
    listener(req, socket, head);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails closed (destroys, logs) on a malformed IP_ALLOWLIST rather than throwing out of the listener', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const upgradeHandler = vi.fn();
    const { listener } = install({
      config: { ...baseConfig, IP_ALLOWLIST: 'garbage!!' },
      dev: true,
      frontend: { upgradeHandler },
    });
    const req = fakeReq('/_next/webpack-hmr');
    const socket = fakeSocket();
    expect(() => listener(req, socket, head)).not.toThrow();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(upgradeHandler).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('destroys the socket if the frontend upgrade handler rejects', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const upgradeHandler = vi.fn().mockRejectedValue(new Error('boom'));
    const { listener } = install({ config: baseConfig, dev: true, frontend: { upgradeHandler } });
    const req = fakeReq('/_next/webpack-hmr');
    const socket = fakeSocket();
    listener(req, socket, head);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
  });
});
