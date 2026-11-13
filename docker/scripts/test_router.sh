#!/bin/sh
# docker/scripts/test_router.sh ENV [--record] -- the router's behaviour without a browser
# (retire-e2e D5; spec container-deployment "Router behaviour is checked without a browser").
# Ported from the retired e2e/container-routing.spec.ts. Needs a running stack (make ENV-up);
# run by hand, CI has no docker:
#
#   COMPANION_DEVICE_TOKEN=… sh docker/scripts/test_router.sh stage
#   sh docker/scripts/test_router.sh stage --record   # print the current disposition tables
#
# Custom session dashboards (design section 10.3, J6): the router's mode (ROUTER_CUSTOM_DASHBOARDS
# `on` or `off`, and ROUTER_DASHBOARD_RUNTIME_HOST) is read from the running router container, and
# the `dashboards` disposition rows (GET HEAD POST PUT DELETE on each path of section 10.3 and on
# the runtime host: status, Set-Cookie presence, the compared headers incl. Content-Type, and a
# body hash) are checked against the table for that mode. Record the `off` table on a stack built
# from main first, then run this script unchanged on the stack built from the job. A stack with a
# non-default compose project (a proof stack beside another) sets ROUTER_TEST_PROJECT, and
# ROUTER_TEST_WEB / ROUTER_TEST_API when its container names differ from `<project>-web-1` and
# `<project>-api`.
#
# COMPANION_DEVICE_TOKEN is a Companion device token the operator created in that stack's
# Settings -> Companion devices (companion-devices D9 category 12; API_TOKEN is ignored since 9d).
# It is kept only in this process's environment; it is never printed or put on a command line.
# Output: case names and statuses.
set -eu
ENV=${1:?usage: test_router.sh stage|prod [--record]}
case $ENV in stage) P=autologger-stage ;; prod) P=autologger ;; *) echo "stage or prod" >&2; exit 2 ;; esac
P=${ROUTER_TEST_PROJECT:-$P}
PORT=${ROUTER_TEST_PORT:-$(docker port "$P-router-1" 8080/tcp | sed -n 's/^127\.0\.0\.1://p' | head -1)}
[ -n "$PORT" ] || { echo "no router port for $P" >&2; exit 2; }
LAN=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -vE '^(127\.|172\.|$)' | head -1 || true)
WEB=${ROUTER_TEST_WEB:-$P-web-1}
API=${ROUTER_TEST_API:-$P-api}
# The router's mode and runtime host, as the running container was started with them.
ROUTER_ENV=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$P-router-1")
ROUTER_MODE=$(printf '%s\n' "$ROUTER_ENV" | sed -n 's/^ROUTER_CUSTOM_DASHBOARDS=//p' | head -1)
RT_HOST=$(printf '%s\n' "$ROUTER_ENV" | sed -n 's/^ROUTER_DASHBOARD_RUNTIME_HOST=//p' | head -1)
[ -n "${2:-}" ] || [ -n "${COMPANION_DEVICE_TOKEN:-}" ] || {
  echo "set COMPANION_DEVICE_TOKEN to a device token from the $ENV stack's Settings -> Companion devices" >&2
  exit 2
}
export COMPANION_DEVICE_TOKEN="${COMPANION_DEVICE_TOKEN:-}"
PORT="$PORT" LAN="$LAN" WEB="$WEB" API="$API" ROUTER_MODE="${ROUTER_MODE:-off}" RT_HOST="$RT_HOST" RECORD="${2:-}" \
  exec node --input-type=module - <<'EOF'
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const { PORT, LAN, WEB, API, ROUTER_MODE, RT_HOST, RECORD, COMPANION_DEVICE_TOKEN } = process.env;
const port = Number(PORT);
let pass = 0;
let fail = 0;
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`ok   ${name}${got !== undefined ? ` (${got})` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${got !== undefined ? ` (got ${got})` : ''}`); }
};

// One raw HTTP/1.1 exchange; resolves { bytes, raw, closed }.
function raw(text, host = '127.0.0.1', ms = 4000) {
  return new Promise((ok) => {
    const chunks = [];
    let closed = false;
    const s = net.connect({ host, port }, () => s.write(text));
    const done = () => ok({ bytes: Buffer.concat(chunks).length, raw: Buffer.concat(chunks).toString('latin1'), closed });
    s.on('data', (c) => chunks.push(c));
    s.on('end', () => { closed = true; });
    s.on('close', done);
    s.on('error', () => { closed = true; });
    s.setTimeout(ms, () => s.destroy());
  });
}
const req = (method, path, headers = {}, body = '', host = `127.0.0.1:${port}`) =>
  [`${method} ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: close',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []), '', body].join('\r\n');
function parse(r) {
  const [head, ...rest] = r.raw.split('\r\n\r\n');
  const lines = head.split('\r\n');
  const status = Number(lines[0].match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0);
  const h = {};
  const cookies = [];
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i < 0) continue;
    const k = l.slice(0, i).toLowerCase();
    const v = l.slice(i + 1).trim();
    if (k === 'set-cookie') cookies.push(v); else h[k] = v;
  }
  return { status, h, cookies, body: rest.join('\r\n\r\n'), head };
}
const http = async (method, path, headers, body, host) => parse(await raw(req(method, path, headers, body, host)));
const bearer = { Authorization: `Bearer ${COMPANION_DEVICE_TOKEN}` };

// ---- Shell served by web
for (const p of ['/', '/teams', '/sessions/abc', '/sessions/a%2Fb']) {
  const r = await http('GET', p);
  check(`shell GET ${p} -> 200 html, no Set-Cookie`, r.status === 200 && (r.h['content-type'] ?? '').includes('text/html') && r.cookies.length === 0, `${r.status} ${r.h['content-type'] ?? '-'} cookies=${r.cookies.length}`);
}
// The retired admin page (remove-admin-users-page; spec container-deployment "The retired admin
// page is not a shell path"): the app's not-found page, 404 html, no Set-Cookie.
{
  const r = await http('GET', '/admin/users');
  check('retired GET /admin/users -> 404 html, no Set-Cookie', r.status === 404 && (r.h['content-type'] ?? '').includes('text/html') && r.cookies.length === 0, `${r.status} ${r.h['content-type'] ?? '-'} cookies=${r.cookies.length}`);
}

// ---- Dispositions (spec "Differential parity with the single-process server"): status, Set-Cookie
// presence and the compared headers, against the table below (recorded with --record; see D5).
const ROWS = [];
for (const p of ['/', '/teams', '/sessions/abc', '/admin/users', '/admin/logs']) ROWS.push(['GET', p], ['HEAD', p]);
ROWS.push(['GET', '/teams', { RSC: '1' }], ['GET', '/static/fonts/inter-latin-var.woff2'], ['GET', '/static/fonts/league-gothic-latin.woff2'],
  ['GET', '/_next/image?url=/static/logo-autologger-app.png&w=64&q=75'], ['GET', '/sessions'], ['GET', '/sessions/a/b'], ['GET', '/sessions/a%2F'],
  ['GET', '/teams/'], ['HEAD', '/teams/'], ['GET', '/nope'], ['POST', '/sessions/abc', { 'Content-Type': 'application/json' }, '{}'],
  ['GET', '/api/does-not-exist'], ['GET', '/API/profile'], ['GET', '/%61pi/profile']);
const HDRS = ['x-powered-by', 'location', 'content-type', 'content-encoding', 'vary', 'cache-control'];
const summary = (r) => [r.status, r.cookies.length ? 'cookie' : '-', ...HDRS.map((k) => r.h[k] ?? '-')].join(' | ');
const EXPECTED = {
// Recorded 2026-09-30 with --record against the stage router; edit only deliberately.
// 2026-10-06 (remove-admin-users-page D5): the two /admin/users rows were deliberately changed from
// the retired page's `200 … s-maxage=31536000` to the not-found disposition /admin/logs already
// records (verified byte-identical on a scratch `next start` by the change's panel).
// 2026-11-13 (Next 16 upgrade, job 014; human decision): GET /teams (RSC) was deliberately changed
// from `200 text/x-component` to Next 16's RSC request validation redirect. The request sends
// `RSC: 1` with no router-state headers and no `_rsc` query, so Next answers `307` to the same
// path with an empty `_rsc` and no Content-Type, Vary or Cache-Control. Recorded against the
// `web` image built from the job branch, not through a stage router.
  "GET /": "200 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "HEAD /": "200 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "GET /teams": "200 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "HEAD /teams": "200 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "GET /sessions/abc": "200 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "HEAD /sessions/abc": "200 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "GET /admin/users": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "HEAD /admin/users": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "GET /admin/logs": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "HEAD /admin/logs": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "GET /teams (RSC)": "307 | - | - | /teams?_rsc | - | - | - | -",
  "GET /static/fonts/inter-latin-var.woff2": "200 | - | - | - | font/woff2 | - | - | public, max-age=0",
  "GET /static/fonts/league-gothic-latin.woff2": "200 | - | - | - | font/woff2 | - | - | public, max-age=0",
  "GET /_next/image?url=/static/logo-autologger-app.png&w=64&q=75": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "GET /sessions": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "GET /sessions/a/b": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "GET /sessions/a%2F": "200 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "GET /teams/": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | -",
  "HEAD /teams/": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | -",
  "GET /nope": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "POST /sessions/abc": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | -",
  "GET /api/does-not-exist": "401 | - | - | - | application/json | - | - | -",
  "GET /API/profile": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate",
  "GET /%61pi/profile": "200 | - | - | - | application/json | - | Accept-Encoding | -",
};
for (const [m, p, hd, body] of ROWS) {
  const key = `${m} ${p}${hd?.RSC ? ' (RSC)' : ''}`;
  const got = summary(await http(m, p, hd, body));
  if (RECORD) console.log(`  ${JSON.stringify(key)}: ${JSON.stringify(got)},`);
  else check(`disposition ${key}`, EXPECTED[key] === got, EXPECTED[key] === got ? undefined : got);
}

// ---- Custom session dashboards (design section 10.3, J6). The mode is the router container's own
// ROUTER_CUSTOM_DASHBOARDS; the rows are recorded per mode with --record. `off` is recorded on a
// stack built from main (before J6) and must pass unchanged on the job's stack; `on` is recorded
// on the job's stack with both settings on.
const DASH_ON = ROUTER_MODE === 'on';
const RUNTIME = RT_HOST || 'runtime.parity.invalid'; // only a Host header; no DNS involved
const DASH_PATHS = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server', '/oauth/authorize', '/oauth/authorize/resume', '/mcp'];
const RT_PATHS = ['/runtime/v1/frame.html', '/runtime/v1/assets/x.js', '/api/profile']; // not '/': the shell body varies per request
const DASH_ROWS = [];
for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
  for (const p of DASH_PATHS) DASH_ROWS.push([m, p, false]);
  for (const p of RT_PATHS) DASH_ROWS.push([m, p, true]);
}
// status | cookie | compared headers | sha256 of the body (first 16 hex; `-` for an empty body)
const bodyHash = (b) => (b.length ? createHash('sha256').update(b, 'latin1').digest('hex').slice(0, 16) : '-');
const dashSummary = (r) => `${summary(r)} | ${bodyHash(r.body)}`;
const DASH_EXPECTED = {
  off: {
// Recorded with --record on a split-topology stack built from main (commit 67f771b1, the `web` and
// `api` targets of docker/Dockerfile; the api image is API-only), router with the setting unset,
// before J6. The job's own stack must pass this table unchanged. The same `web` image served
// both stacks, so Next's not-found body hash is comparable.
    "GET /.well-known/oauth-protected-resource": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | 60978693dda410ee",
    "GET /.well-known/oauth-protected-resource/mcp": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | 6fdec64753a98355",
    "GET /.well-known/oauth-authorization-server": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | 1addac9b4e6d64a7",
    "GET /oauth/authorize": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | b559c45755b208ef",
    "GET /oauth/authorize/resume": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | 1243e2fbe19213c8",
    "GET /mcp": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | c343073f7c6dcc36",
    "GET [runtime host] /runtime/v1/frame.html": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | b0a9481f6dae78be",
    "GET [runtime host] /runtime/v1/assets/x.js": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | 6b6c7ef60ed11fe1",
    "GET [runtime host] /api/profile": "200 | - | - | - | application/json | - | Accept-Encoding | - | 8dc89bf93caf8d20",
    "HEAD /.well-known/oauth-protected-resource": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | -",
    "HEAD /.well-known/oauth-protected-resource/mcp": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | -",
    "HEAD /.well-known/oauth-authorization-server": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | -",
    "HEAD /oauth/authorize": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | -",
    "HEAD /oauth/authorize/resume": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | -",
    "HEAD /mcp": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | -",
    "HEAD [runtime host] /runtime/v1/frame.html": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | -",
    "HEAD [runtime host] /runtime/v1/assets/x.js": "404 | - | - | - | text/html; charset=utf-8 | - | rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding | private, no-cache, no-store, max-age=0, must-revalidate | -",
    "HEAD [runtime host] /api/profile": "200 | - | - | - | application/json | - | Accept-Encoding | - | -",
    "POST /.well-known/oauth-protected-resource": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST /.well-known/oauth-protected-resource/mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST /.well-known/oauth-authorization-server": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST /oauth/authorize": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST /oauth/authorize/resume": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST /mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST [runtime host] /runtime/v1/frame.html": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST [runtime host] /runtime/v1/assets/x.js": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST [runtime host] /api/profile": "401 | - | - | - | application/json | - | - | - | 7355b61d35e034bc",
    "PUT /.well-known/oauth-protected-resource": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT /.well-known/oauth-protected-resource/mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT /.well-known/oauth-authorization-server": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT /oauth/authorize": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT /oauth/authorize/resume": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT /mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT [runtime host] /runtime/v1/frame.html": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT [runtime host] /runtime/v1/assets/x.js": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT [runtime host] /api/profile": "401 | - | - | - | application/json | - | - | - | 7355b61d35e034bc",
    "DELETE /.well-known/oauth-protected-resource": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE /.well-known/oauth-protected-resource/mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE /.well-known/oauth-authorization-server": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE /oauth/authorize": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE /oauth/authorize/resume": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE /mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE [runtime host] /runtime/v1/frame.html": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE [runtime host] /runtime/v1/assets/x.js": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE [runtime host] /api/profile": "401 | - | - | - | application/json | - | - | - | 7355b61d35e034bc",
  },
  on: {
// Recorded with --record on the job's stack (same web image, api image built from the J6 commit)
// with ROUTER_CUSTOM_DASHBOARDS=on, the runtime host set, and the api's flag on. The routes behind
// the new paths are whatever the api has mounted at that commit; re-record when a later job (J5, J8)
// changes an answer, and say so in that job.
    "GET /.well-known/oauth-protected-resource": "200 | - | - | - | application/json | - | - | - | 83079eff7bf393e0",
    "GET /.well-known/oauth-protected-resource/mcp": "200 | - | - | - | application/json | - | - | - | 83079eff7bf393e0",
    "GET /.well-known/oauth-authorization-server": "200 | - | - | - | application/json | - | - | - | 1ae7f7c20e6effbc",
    "GET /oauth/authorize": "400 | - | - | - | text/html; charset=UTF-8 | - | - | no-store | 80ddb0ba713e499f",
    "GET /oauth/authorize/resume": "400 | - | - | - | text/html; charset=UTF-8 | - | - | no-store | 1176e7f682f20652",
    "GET /mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "GET [runtime host] /runtime/v1/frame.html": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "GET [runtime host] /runtime/v1/assets/x.js": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "GET [runtime host] /api/profile": "200 | - | - | - | application/json | - | Accept-Encoding | - | 8dc89bf93caf8d20",
    "HEAD /.well-known/oauth-protected-resource": "200 | - | - | - | application/json | - | - | - | -",
    "HEAD /.well-known/oauth-protected-resource/mcp": "200 | - | - | - | application/json | - | - | - | -",
    "HEAD /.well-known/oauth-authorization-server": "200 | - | - | - | application/json | - | - | - | -",
    "HEAD /oauth/authorize": "400 | - | - | - | text/html; charset=UTF-8 | - | - | no-store | -",
    "HEAD /oauth/authorize/resume": "400 | - | - | - | text/html; charset=UTF-8 | - | - | no-store | -",
    "HEAD /mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | -",
    "HEAD [runtime host] /runtime/v1/frame.html": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | -",
    "HEAD [runtime host] /runtime/v1/assets/x.js": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | -",
    "HEAD [runtime host] /api/profile": "200 | - | - | - | application/json | - | Accept-Encoding | - | -",
    "POST /.well-known/oauth-protected-resource": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST /.well-known/oauth-protected-resource/mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST /.well-known/oauth-authorization-server": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST /oauth/authorize": "400 | - | - | - | text/html; charset=UTF-8 | - | - | no-store | 4909666fb2d534cd",
    "POST /oauth/authorize/resume": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST /mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST [runtime host] /runtime/v1/frame.html": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST [runtime host] /runtime/v1/assets/x.js": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "POST [runtime host] /api/profile": "401 | - | - | - | application/json | - | - | - | 7355b61d35e034bc",
    "PUT /.well-known/oauth-protected-resource": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT /.well-known/oauth-protected-resource/mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT /.well-known/oauth-authorization-server": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT /oauth/authorize": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT /oauth/authorize/resume": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT /mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT [runtime host] /runtime/v1/frame.html": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT [runtime host] /runtime/v1/assets/x.js": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "PUT [runtime host] /api/profile": "401 | - | - | - | application/json | - | - | - | 7355b61d35e034bc",
    "DELETE /.well-known/oauth-protected-resource": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE /.well-known/oauth-protected-resource/mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE /.well-known/oauth-authorization-server": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE /oauth/authorize": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE /oauth/authorize/resume": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE /mcp": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE [runtime host] /runtime/v1/frame.html": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE [runtime host] /runtime/v1/assets/x.js": "404 | - | - | - | text/plain; charset=UTF-8 | - | - | - | 7d04f7431bbfa41a",
    "DELETE [runtime host] /api/profile": "401 | - | - | - | application/json | - | - | - | 7355b61d35e034bc",
  },
};
const dashKey = (m, p, rt) => `${m} ${rt ? '[runtime host] ' : ''}${p}`;
const dashGot = {};
for (const [m, p, rt] of DASH_ROWS) {
  const hd = m === 'POST' || m === 'PUT' ? { 'Content-Type': 'application/json' } : {};
  const r = await http(m, p, hd, m === 'POST' || m === 'PUT' ? '{}' : '', rt ? RUNTIME : undefined);
  dashGot[dashKey(m, p, rt)] = { sum: dashSummary(r), r };
}
if (RECORD) {
  console.log(`  // dashboards mode ${DASH_ON ? 'on' : 'off'} (paste into DASH_EXPECTED.${DASH_ON ? 'on' : 'off'})`);
  for (const [k, v] of Object.entries(dashGot)) console.log(`    ${JSON.stringify(k)}: ${JSON.stringify(v.sum)},`);
} else {
  const want = DASH_EXPECTED[DASH_ON ? 'on' : 'off'];
  for (const [k, v] of Object.entries(dashGot)) {
    check(`dashboards (${DASH_ON ? 'on' : 'off'}) ${k}`, want[k] === v.sum, want[k] === v.sum ? undefined : v.sum);
  }
}
if (RECORD) process.exit(0);
const shell = (await http('GET', '/teams')).body;
const chunk = shell.match(/\/_next\/static\/[^"'\s\\]+\.js/)?.[0];
const c = chunk ? await http('GET', chunk) : { status: 0, h: {} };
check('GET /_next/static/<chunk> from the shell -> 200 immutable', c.status === 200 && /immutable/.test(c.h['cache-control'] ?? ''), `${c.status} ${c.h['cache-control'] ?? '-'}`);

// ---- Custom dashboards: which upstream answered, and the frame-src policy
// Next's answers (the shell and its not-found page) are HTML with a `Vary: rsc, ...` header; the
// API-only api image answers plain text (or JSON) and never sets it.
const fromWeb = (r) => (r.h['content-type'] ?? '').includes('text/html') && /(^|,\s*)rsc(,|$)/.test(r.h.vary ?? '');
const csp = (r) => r.h['content-security-policy'];
const FRAME_SRC = `frame-src https://${RT_HOST}/runtime/v1/frame.html`;
for (const p of DASH_PATHS) {
  const r = dashGot[dashKey('GET', p, false)].r;
  if (DASH_ON) check(`dashboards on: GET ${p} reaches the api, not web:3000`, !fromWeb(r), `${r.status} ${r.h['content-type'] ?? '-'}`);
  else check(`dashboards off: GET ${p} is still Next's HTML not-found page from web:3000, not the api's plain-text 404`, fromWeb(r) && r.status === 404 && !/^Not Found$/.test(r.body), `${r.status} ${r.h['content-type'] ?? '-'}`);
}
if (DASH_ON) {
  const rt = dashGot[dashKey('GET', '/runtime/v1/frame.html', true)].r;
  check('dashboards on: GET https://<runtime host>/runtime/v1/frame.html reaches the api, not web:3000', RT_HOST !== '' && !fromWeb(rt), `${rt.status} ${rt.h['content-type'] ?? '-'}`);
  for (const p of ['/', '/teams', '/nope', '/sessions/abc']) {
    const r = await http('GET', p);
    check(`dashboards on: web document GET ${p} carries exactly the frame-src policy`, csp(r) === FRAME_SRC, csp(r) ?? 'none');
  }
  const h = await http('HEAD', '/teams');
  check('dashboards on: HEAD /teams carries exactly the frame-src policy', csp(h) === FRAME_SRC, csp(h) ?? 'none');
  // The api's own policy (the OAuth pages) is kept, not replaced or doubled: compare with the api's answer.
  const direct = execFileSync('docker', ['exec', API, 'node', '-e',
    "fetch('http://127.0.0.1:8787/oauth/authorize').then((r)=>process.stdout.write(r.headers.get('content-security-policy')??''))"], { encoding: 'utf8' });
  const oa = await http('GET', '/oauth/authorize');
  check('dashboards on: a response that already has a Content-Security-Policy keeps it unchanged', direct !== '' && csp(oa) === direct && csp(oa) !== FRAME_SRC, csp(oa) ?? 'none');
  const rtAny = await http('GET', '/runtime/v1/frame.html', {}, '', RT_HOST);
  check('dashboards on: a runtime-host response does not get the app policy', csp(rtAny) !== FRAME_SRC, csp(rtAny) ?? 'none');
  const rtOther = await http('GET', '/anything', {}, '', RT_HOST.toUpperCase());
  check('dashboards on: the runtime host matches case-insensitively and gets no app policy', csp(rtOther) !== FRAME_SRC && !fromWeb(rtOther), `${rtOther.status}`);
  const look = await http('GET', '/mcpx');
  check('dashboards on: look-alike GET /mcpx still goes to web', fromWeb(look), `${look.status}`);
  const enc = await http('GET', '/%6Dcp');
  check('dashboards on: percent-encoded GET /%6Dcp does not match the new rule (web)', fromWeb(enc), `${enc.status}`);
} else {
  for (const [p, host] of [['/', undefined], ['/teams', undefined], ['/nope', undefined], ['/mcp', undefined], ['/oauth/authorize', undefined], ['/api/profile', undefined], ['/runtime/v1/frame.html', RUNTIME]]) {
    const r = await http('GET', p, {}, '', host);
    check(`dashboards off: GET ${p}${host ? ' (runtime host)' : ''} gains no Content-Security-Policy`, csp(r) === undefined, csp(r) ?? 'none');
  }
}

// ---- Stray upgrades write nothing; the session WebSocket path is still proxied
const upgrade = (path, extra = {}, proto = 'websocket') => [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', `Upgrade: ${proto}`,
  'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');
for (const [p, proto] of [['/teams'], ['/teams', 'h2c'], ['/'], ['/auth/x'], ['/%61pi/sessions/x/ws']]) {
  const r = await raw(upgrade(p, {}, proto ?? 'websocket'));
  check(`stray Upgrade (${proto ?? 'websocket'}) on ${p} -> closed, 0 bytes`, r.bytes === 0 && r.closed, `${r.bytes} bytes`);
}
const ctl = await raw(upgrade('/api/sessions/x/ws?role=browser'));
check('control: Upgrade on /api/sessions/x/ws gets a status line', /^HTTP\/1\.1 \d{3}/.test(ctl.raw), ctl.raw.slice(0, 12));
const variants = [
  ['Connection: Upgrade + Upgrade', ['Connection: Upgrade', 'Upgrade: h2c'], true],
  ['Connection: keep-alive, Upgrade', ['Connection: keep-alive, Upgrade', 'Upgrade: h2c'], true],
  ['lowercase names, value UPGRADE', ['connection: UPGRADE', 'upgrade: h2c'], true],
  ['token padded by spaces', ['Connection: keep-alive ,  upgrade ', 'Upgrade: h2c'], true],
  ['token split over two Connection headers', ['Connection: keep-alive', 'Connection: upgrade', 'Upgrade: h2c'], true],
  ['Upgrade without Connection', ['Upgrade: h2c'], false],
  ['Connection: upgrade without Upgrade', ['Connection: upgrade'], false],
  ['Connection: keep-alive + Upgrade', ['Connection: keep-alive', 'Upgrade: h2c'], false],
  ['empty Upgrade value', ['Connection: upgrade', 'Upgrade:'], false],
  ['near-miss token upgradex', ['Connection: upgradex', 'Upgrade: h2c'], false],
  ['near-miss token xupgrade', ['Connection: xupgrade', 'Upgrade: h2c'], false],
];
for (const [name, hs, isUp] of variants) {
  const r = await raw(['GET /teams HTTP/1.1', `Host: 127.0.0.1:${port}`, ...hs, '', ''].join('\r\n'), '127.0.0.1', 2500);
  const ok = isUp ? r.bytes === 0 : /^HTTP\/1\.1 200/.test(r.raw);
  check(`upgrade detection: ${name} -> ${isUp ? 'aborted' : 'answered 200'}`, ok, isUp ? `${r.bytes} bytes` : r.raw.slice(0, 12));
}

// ---- Traversal cannot reach a non-Companion route (with a valid device token)
const own = await http('GET', '/teams/');
check("the server's own 404 (GET /teams/)", own.status === 404, own.status);
for (const p of ['/api/companion/%2e%2e/sessions/x', '/api/companion/.%2E/admin/users', '/api/companion/state/..%2Fsessions', '/api/companion/%2e%2e/sessions',
  '/api/companion/%2E%2e/sessions', '/api/companion/../sessions', '/api/companion/./state', '/api//companion/state', '/api/sessions%2Fx',
  '/api/companion/state%5Cx', '/auth/google%2fstart']) {
  const r = await http('GET', p, bearer);
  check(`traversal GET ${p} with a device token -> the server's own 404`, r.status === 404 && r.body === own.body && r.h['content-type'] === own.h['content-type'], r.status);
}
const post = await http('POST', '/api/companion/%2e%2e/sessions', { ...bearer, 'Content-Type': 'application/json' }, '{}');
check('traversal POST /api/companion/%2e%2e/sessions -> 404', post.status === 404, post.status);
const [q, plain] = [await http('GET', '/api/profile?x=/../y'), await http('GET', '/api/profile')];
check('a query string cannot smuggle a dot-segment (?x=/../) -> same as /api/profile', q.status === plain.status && q.status !== 404, `${q.status}/${plain.status}`);

// ---- Device-token scope
const st = await http('GET', '/api/companion/state', bearer);
let shape = false;
try { shape = typeof JSON.parse(st.body) === 'object'; } catch {}
check('token: GET /api/companion/state -> 200 JSON', st.status === 200 && shape, st.status);
const ses = await http('GET', '/api/sessions', bearer);
check('token: GET /api/sessions -> 401 Login required.', ses.status === 401 && ses.body.includes('Login required.'), ses.status);
const [adm, anon] = [await http('GET', '/api/admin/users', bearer), await http('GET', '/api/admin/users')];
check('token: GET /api/admin/users handled exactly as anonymous', adm.status === anon.status && adm.body === anon.body, `${adm.status}/${anon.status}`);
const head = (r) => r.raw.split('\r\n\r\n')[0].split('\r\n').filter((l) => !/^date:/i.test(l)).join('\n');
const [wt, wa] = [await raw(upgrade('/api/sessions/x/ws?role=companion', bearer)), await raw(upgrade('/api/sessions/x/ws?role=companion'))];
check('token: WS role=companion refused exactly as unauthenticated (401)', /^HTTP\/1\.1 401/.test(head(wt)) && head(wt) === head(wa), head(wt).slice(0, 12));

// ---- Topology
let webToApi = 'unreachable';
try {
  execFileSync('docker', ['exec', WEB, 'node', '-e', "fetch('http://api:8787/api/profile',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0),()=>process.exit(1))"], { stdio: 'ignore' });
  webToApi = 'reachable';
} catch {}
check('web cannot open a connection to api', webToApi === 'unreachable', webToApi);
if (LAN) {
  const r = await raw(req('GET', '/'), LAN, 2000);
  check(`router port on the LAN address ${LAN} is not reachable`, r.bytes === 0, `${r.bytes} bytes`);
} else check('router port on a LAN address is not reachable', false, 'no LAN address found');

console.log(`test_router: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
EOF
