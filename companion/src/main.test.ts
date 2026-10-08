import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real InstanceBase talks IPC to Companion; replace it with a recorder so the
// instance's init/configUpdated run in-process against a local HTTP server.
const captured = vi.hoisted(() => ({ ctor: null as null | (new (internal: unknown) => unknown) }));

vi.mock('@companion-module/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@companion-module/base')>();
  class FakeInstanceBase {
    statuses: Array<[string, string | null | undefined]> = [];
    updateStatus(status: string, message?: string | null): void {
      this.statuses.push([status, message]);
    }
    setVariableDefinitions(): void {}
    setFeedbackDefinitions(): void {}
    setPresetDefinitions(): void {}
    setActionDefinitions(): void {}
    setVariableValues(): void {}
    checkFeedbacks(): void {}
    log(): void {}
    async parseVariablesInString(t: string): Promise<string> {
      return t;
    }
  }
  return {
    ...actual,
    InstanceBase: FakeInstanceBase,
    runEntrypoint: (ctor: new (internal: unknown) => unknown) => {
      captured.ctor = ctor;
    },
  };
});

interface TestInstance {
  statuses: Array<[string, string | null | undefined]>;
  init(config: unknown, isFirstInit: boolean, secrets: unknown): Promise<void>;
  configUpdated(config: unknown, secrets: unknown): Promise<void>;
  destroy(): Promise<void>;
}

let server: Server;
let base: string;
let status = 200;
const seenAuth: Array<string | undefined> = [];

beforeEach(async () => {
  status = 200;
  seenAuth.length = 0;
  server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        status === 200
          ? { connected_clients: 0, active_session_id: null, session: null, last_command: null }
          : {},
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function newInstance(): Promise<TestInstance> {
  await import('./main.js');
  if (!captured.ctor) throw new Error('runEntrypoint was not called');
  return new captured.ctor({}) as TestInstance;
}

const config = (url: string) => ({ url, pollMs: 10000 });

describe('AutologgerInstance device token', () => {
  it('init sends secrets.token as the Bearer and ignores a plain config token', async () => {
    const inst = await newInstance();
    await inst.init({ ...config(base), token: 'plain-api-token' }, false, { token: 'ald_init' });
    await vi.waitFor(() => expect(seenAuth.length).toBeGreaterThan(0));
    await inst.destroy();
    expect(new Set(seenAuth)).toEqual(new Set(['Bearer ald_init']));
  });

  it('configUpdated switches to the new secrets.token', async () => {
    const inst = await newInstance();
    await inst.init(config(base), false, { token: 'ald_old' });
    await vi.waitFor(() => expect(seenAuth).toContain('Bearer ald_old'));
    await vi.waitFor(() => expect(inst.statuses.at(-1)?.[0]).toBe('ok'));
    seenAuth.length = 0;
    await inst.configUpdated(config(base), { token: 'ald_new' });
    await vi.waitFor(() => expect(seenAuth.length).toBeGreaterThan(0));
    await inst.destroy();
    expect(new Set(seenAuth)).toEqual(new Set(['Bearer ald_new']));
  });

  it('a 401 sets BadConfig with the device-token message', async () => {
    status = 401;
    const inst = await newInstance();
    await inst.init(config(base), false, { token: 'ald_revoked' });
    await vi.waitFor(() => expect(inst.statuses.at(-1)?.[0]).toBe('bad_config'));
    await inst.destroy();
    expect(inst.statuses.at(-1)).toEqual([
      'bad_config',
      'Device token invalid or revoked: create one in AutoLogger Settings → Companion devices',
    ]);
  });
});
