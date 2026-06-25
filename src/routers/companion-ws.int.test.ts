import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedSession, seedShow, seedStudio, setCompanionPresence } from '../test/helpers';

async function seededSession(): Promise<string> {
  const show = await seedShow({ studioId: await seedStudio() });
  return seedSession({ showId: show });
}
const ORIGIN = 'https://example.com';

function nextMessage(ws: WebSocket, ms = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws message timeout')), ms);
    ws.addEventListener('message', (e) => {
      clearTimeout(t);
      resolve(typeof e.data === 'string' ? e.data : '');
    });
  });
}

describe('companion WebSocket relay', () => {
  it('delivers a posted command over the session WebSocket', async () => {
    const s = await seededSession();
    const wsRes = await SELF.fetch(`${ORIGIN}/api/sessions/${s}/ws`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket;
    expect(ws).toBeTruthy();
    ws!.accept();
    const got = nextMessage(ws!);

    await setCompanionPresence('c1', s);
    const cmd = await SELF.fetch(`${ORIGIN}/api/companion/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'record-start' }),
    });
    expect(cmd.status).toBe(200);

    expect(JSON.parse(await got)).toMatchObject({ type: 'command', command: 'record-start' });
    ws!.close();
  });

  it('re-broadcasts a command sent BY a connected client', async () => {
    const s = await seededSession();
    const open = async (): Promise<WebSocket> => {
      const r = await SELF.fetch(`${ORIGIN}/api/sessions/${s}/ws`, {
        headers: { Upgrade: 'websocket' },
      });
      const w = r.webSocket as WebSocket;
      w.accept();
      return w;
    };
    const sender = await open();
    const receiver = await open();
    const got = nextMessage(receiver);
    sender.send(JSON.stringify({ type: 'command', command: 'play-toggle' }));
    expect(JSON.parse(await got)).toMatchObject({ type: 'command', command: 'play-toggle' });
    sender.close();
    receiver.close();
  });
});
