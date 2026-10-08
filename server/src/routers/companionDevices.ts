// Companion device management routes (companion-devices D5; api-contract-freeze "Companion device
// management routes"). Each signed-in user lists, creates and revokes their own Companion devices.
//
// These paths are outside `/api/companion/`, so device-token auth never runs here: a Bearer is
// ignored and only a session cookie authenticates (the login gate answers 401 otherwise). The routes
// use the system device store (`ports.companionDevices`); the table has no user RLS, so the caller's
// user id in every store statement is the only isolation between users. The token is returned once,
// by the create; only its SHA-256 is stored. Create and revoke each write one audit line with the
// user and device ids, never the token or its hash.

import { companionDeviceCreateBodySchema } from '@autologger/contract';
import type { CompanionDevice } from '@autologger/ports';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import { hashCompanionDeviceToken, newCompanionDeviceToken } from '../auth/companionDeviceToken';
import { ApiError } from '../httpError';
import { requireUser } from './_helpers';

export const companionDevicesRouter = new Hono<AppEnv>();

const NUL_DETAIL = 'Text must not contain NUL characters.';
const CAP_REACHED_DETAIL = 'You already have 10 Companion devices; revoke one first.';
const NOT_FOUND_DETAIL = 'Companion device not found.';

function toWire(d: CompanionDevice) {
  return {
    id: d.id,
    name: d.name,
    created_at: d.created_at_utc,
    last_used_at: d.last_used_at_utc,
    expired: d.expired,
  };
}

companionDevicesRouter.get('/api/companion-devices', async (c) => {
  const user = requireUser(c);
  const devices = await c.env.ports.companionDevices.list(user.id);
  return c.json({ devices: devices.map(toWire) });
});

companionDevicesRouter.post('/api/companion-devices', async (c) => {
  const user = requireUser(c);
  const { name } = companionDeviceCreateBodySchema.parse(await c.req.json());
  if (name.includes('\u0000')) throw new ApiError(400, NUL_DETAIL);
  const token = newCompanionDeviceToken();
  const result = await c.env.ports.companionDevices.create(
    user.id,
    name,
    hashCompanionDeviceToken(token),
  );
  if (result.kind === 'cap-reached') throw new ApiError(409, CAP_REACHED_DETAIL);
  const { device } = result;
  console.info(`Companion device created: user=${user.id} device=${device.id}`);
  return c.json(
    { id: device.id, name: device.name, created_at: device.created_at_utc, token },
    201,
  );
});

companionDevicesRouter.delete('/api/companion-devices/:id', async (c) => {
  const user = requireUser(c);
  const id = c.req.param('id');
  if (!(await c.env.ports.companionDevices.delete(user.id, id))) {
    throw new ApiError(404, NOT_FOUND_DETAIL);
  }
  console.info(`Companion device revoked: user=${user.id} device=${id}`);
  return c.body(null, 204);
});
