// Batch autogenerate routes (OpenSpec change `batch-autogenerate`, design D14; api-contract-freeze
// "Batch autogenerate endpoints"). Every route first answers the team family's prefix, byte for byte
// (`requireTeamRole`: the masked `404 {"detail":"Team not found"}`, then `403 Admin role
// required.` for a member), before reading any body. Bodies that fail the schema answer `422` with
// zod 4 issues (not the team routes' 400 string). No route sets a cookie, and none sends a
// database notification: the worker polls (D3).

import {
  AUTOGENERATE_DETAIL,
  autogenerateScopeBodySchema,
  autogenerateStartBodySchema,
} from '@autologger/contract';
import { Hono } from 'hono';
import type { AppEnv } from '../appEnv';
import {
  cancelBy,
  detailWire,
  jobWire,
  previewAutogenerateJob,
  startAutogenerateJob,
} from '../autogenerate/service';
import { ApiError } from '../httpError';
import { principalOf } from './_helpers';
import { OWNER_OR_ADMIN, requireTeamRole } from './teams';

export const autogenerateRouter = new Hono<AppEnv>();

const BASE = '/api/teams/:teamId/autogenerate-jobs';

autogenerateRouter.post(`${BASE}/preview`, async (c) => {
  const teamId = c.req.param('teamId');
  await requireTeamRole(c, teamId, OWNER_OR_ADMIN);
  const body = autogenerateScopeBodySchema.parse(await c.req.json());
  const out = await previewAutogenerateJob(principalOf(c), teamId, body);
  if ('status' in out) return c.json(out.body, out.status);
  return c.json(out);
});

autogenerateRouter.post(BASE, async (c) => {
  const teamId = c.req.param('teamId');
  await requireTeamRole(c, teamId, OWNER_OR_ADMIN);
  const body = autogenerateStartBodySchema.parse(await c.req.json());
  const out = await startAutogenerateJob(principalOf(c), teamId, body);
  if ('status' in out) return c.json(out.body, out.status);
  return c.json(out, 201);
});

autogenerateRouter.get(BASE, async (c) => {
  const teamId = c.req.param('teamId');
  await requireTeamRole(c, teamId, OWNER_OR_ADMIN);
  const jobs = await c.get('catalog').autogenerate.listJobs(teamId);
  return c.json({ jobs: jobs.map(jobWire) });
});

autogenerateRouter.get(`${BASE}/:jobId`, async (c) => {
  const teamId = c.req.param('teamId');
  await requireTeamRole(c, teamId, OWNER_OR_ADMIN);
  const catalog = c.get('catalog');
  const job = await catalog.autogenerate.getJob(teamId, c.req.param('jobId'));
  if (job === null) throw new ApiError(404, AUTOGENERATE_DETAIL.jobNotFound);
  return c.json(detailWire(job, await catalog.autogenerate.detailItems(job.id)));
});

autogenerateRouter.post(`${BASE}/:jobId/cancel`, async (c) => {
  const teamId = c.req.param('teamId');
  await requireTeamRole(c, teamId, OWNER_OR_ADMIN);
  const p = principalOf(c);
  const out = await p.catalog.autogenerate.requestCancel(
    teamId,
    c.req.param('jobId'),
    cancelBy(p),
    p.env.ports.clock.now(),
  );
  switch (out.kind) {
    case 'not-found':
      throw new ApiError(404, AUTOGENERATE_DETAIL.jobNotFound);
    case 'ended':
      return c.json({ detail: AUTOGENERATE_DETAIL.jobEnded, status: out.status }, 409);
    case 'ok':
      return c.json({ job: jobWire(out.job) });
  }
});
