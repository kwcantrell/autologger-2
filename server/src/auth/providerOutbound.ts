// Outbound requests to user-chosen provider hosts (byo-ai-providers design D5; provider-credentials
// "LLM base URLs are restricted in production mode", "The connection test reports without
// leaking"). Node's own http/https client with a pinned `lookup`, so no dependency is added:
// - the host is resolved once, inside the caller's time budget; in production mode any address in
//   the blocked ranges (IPv4, IPv6, IPv4-mapped and NAT64 forms) refuses the request;
// - the connection goes to that vetted address, so a DNS answer cannot change between the check and
//   the request; `Host` and TLS SNI stay the original host name;
// - redirects are never followed; the body read is capped at 1 MB;
// - every failure becomes an OutboundFailure of a fixed kind. The underlying error, which can hold
//   request headers (and so the key), is never logged, kept, rethrown or used as a cause.
//
// `providerRequest` is the connection test's request (1 MB body cap, one timeout for the whole
// request). `guardedFetch` (ai-sdk-agent-harness design D4) is the AI SDK turn's streaming `fetch`:
// destination and path checks, the same address rules per connection, no redirects, a header-only
// timeout, per-turn caps, and a body streamed through unbuffered.

import { promises as dns } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const BODY_CAP = 1024 * 1024;

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4?.[1]) {
    const o = v4[1].split('.').map(Number);
    s = `${s.slice(0, -v4[1].length)}${(((o[0] ?? 0) << 8) | (o[1] ?? 0)).toString(16)}:${(((o[2] ?? 0) << 8) | (o[3] ?? 0)).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array(Math.max(fill, 0)).fill('0'), ...t].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** The IPv4 address embedded in an IPv4-mapped (::ffff:0:0/96) or NAT64 (64:ff9b::/96) address. */
function embeddedIpv4(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g) return null;
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  if (!mapped && !nat64) return null;
  const a = g[6] ?? 0;
  const b = g[7] ?? 0;
  return `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
}

/** True when `ip` is loopback, private, link-local, CGNAT, multicast, unspecified or reserved. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family !== 6) return true;
  const v4 = embeddedIpv4(ip);
  if (v4 !== null) return blocked.check(v4, 'ipv4');
  return blocked.check(ip, 'ipv6');
}

/** The normalized origin: lowercase scheme and host, the default port dropped. */
export function normalizeOrigin(url: string): string {
  return new URL(url.trim()).origin;
}

/** The base URL as stored: normalized origin plus path, with no trailing slash. */
export function normalizeBaseUrl(url: string): string {
  const u = new URL(url.trim());
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

/** `refused`: a destination the guarded fetch does not allow; `cap`: a per-turn cap was passed. */
export type OutboundFailureKind = 'unreachable' | 'timeout' | 'refused' | 'cap';

const OUTBOUND_FAILURE_MESSAGE: Record<OutboundFailureKind, string> = {
  unreachable: 'provider unreachable',
  timeout: 'provider request timed out',
  refused: 'provider request refused',
  cap: 'provider request cap reached',
};

/** A provider request that got no HTTP answer. Its message is fixed and never holds request data. */
export class OutboundFailure extends Error {
  constructor(readonly kind: OutboundFailureKind) {
    super(OUTBOUND_FAILURE_MESSAGE[kind]);
    this.name = 'OutboundFailure';
  }
}

export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

const systemLookup: LookupFn = (host) => dns.lookup(host, { all: true, verbatim: true });

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new OutboundFailure('timeout'));
    signal.addEventListener('abort', () => reject(new OutboundFailure('timeout')), { once: true });
  });
}

export interface ProviderRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Uint8Array;
  /** Production mode (provider-credentials "Development mode is explicit"). */
  production: boolean;
  /** Bounds the whole request, name resolution included. */
  signal: AbortSignal;
  lookup?: LookupFn;
}

/** One request with no redirects. Resolves with any HTTP answer; rejects only with OutboundFailure. */
export async function providerRequest(
  req: ProviderRequest,
): Promise<{ status: number; body: string }> {
  const aborted = abortPromise(req.signal);
  aborted.catch(() => {});
  let target: { address: string; family: number };
  let url: URL;
  try {
    url = new URL(req.url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await Promise.race([(req.lookup ?? systemLookup)(host), aborted]);
    if (addresses.length === 0) throw new OutboundFailure('unreachable');
    if (req.production && addresses.some((a) => isBlockedAddress(a.address))) {
      throw new OutboundFailure('unreachable');
    }
    target = addresses[0] as { address: string; family: number };
  } catch (e) {
    throw e instanceof OutboundFailure && e.kind === 'timeout'
      ? e
      : new OutboundFailure(req.signal.aborted ? 'timeout' : 'unreachable');
  }

  const pinned = (
    _host: string,
    opts: { all?: boolean } | undefined,
    cb: (err: null, address: unknown, family?: number) => void,
  ) => {
    if (opts?.all) cb(null, [{ address: target.address, family: target.family }]);
    else cb(null, target.address, target.family);
  };

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const attempt = new Promise<{ status: number; body: string }>((resolve, reject) => {
    let r: ReturnType<typeof send>;
    try {
      r = send({
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: req.method ?? 'GET',
        headers: { ...req.headers, host: url.host },
        lookup: pinned as never,
        servername: isIP(hostname) ? undefined : hostname,
        signal: req.signal,
      });
    } catch {
      // An invalid header value throws here, with the value in some runtimes' messages.
      reject(new OutboundFailure('unreachable'));
      return;
    }
    r.on('error', () =>
      reject(new OutboundFailure(req.signal.aborted ? 'timeout' : 'unreachable')),
    );
    r.on('response', (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        if (size >= BODY_CAP) return;
        const take = c.subarray(0, BODY_CAP - size);
        chunks.push(take);
        size += take.length;
        if (size >= BODY_CAP) res.destroy();
      });
      const done = () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      res.on('end', done);
      res.on('close', done);
      res.on('error', () =>
        reject(new OutboundFailure(req.signal.aborted ? 'timeout' : 'unreachable')),
      );
    });
    try {
      r.end(req.body ? Buffer.from(req.body) : undefined);
    } catch {
      reject(new OutboundFailure('unreachable'));
    }
  });
  return Promise.race([attempt, aborted]);
}

// ── The guarded model-request fetch (ai-sdk-agent-harness design D4) ───────────────────────────

export interface ProviderHosts {
  readonly openai: string;
  readonly anthropic: string;
  readonly google: string;
  readonly deepgram: string;
}

/** The fixed API hosts. Constants: no environment, configuration or request changes them. */
export const PROVIDER_HOSTS: ProviderHosts = Object.freeze({
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
  deepgram: 'https://api.deepgram.com',
});

const MB = 1024 * 1024;

/** The per-turn bounds (D4 step 3; derivation A11) and the header timeout (D4 step 2). */
export const GUARDED_FETCH_CAPS = Object.freeze({
  requests: 60,
  requestBodyBytes: 4 * MB,
  requestBodyTotalBytes: 48 * MB,
  responseTotalBytes: 64 * MB,
  headerTimeoutMs: 120_000,
});

export type GuardedFetchBreach = 'requests' | 'request-body' | 'request-total' | 'response-total';

export interface GuardedFetchOptions {
  /** `anthropic`, `openai`, `google` or `openai-compatible`; anything else is refused. */
  provider: string;
  model: string;
  /** The saved base URL (`openai-compatible` only), normalized as stored. */
  baseUrl: string | null;
  baseOrigin: string | null;
  /** Production mode: blocked addresses are refused per connection. */
  production: boolean;
  lookup?: LookupFn;
  /** Tests only: the fixed hosts. Production always uses `PROVIDER_HOSTS`. */
  hosts?: ProviderHosts;
  /** Tests only: the header timeout. */
  headerTimeoutMs?: number;
  /** Tests only: the blocked-address rule (default `isBlockedAddress`). */
  isBlocked?: (ip: string) => boolean;
}

export interface GuardedFetch {
  /** Called by the AI SDK provider factories as `(url, init)`. Resolves with any HTTP answer (a 3xx
   * unfollowed); rejects with an OutboundFailure, or the signal's abort error. */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Request and response body bytes per request, in order, for the token-budget estimate (D3). */
  byteLog: () => ReadonlyArray<{ requestBytes: number; responseBytes: number }>;
  /** The cap this turn passed, or null. */
  breach: () => GuardedFetchBreach | null;
}

const FIXED_PATHS: Record<string, (model: string) => { path: string; queries: string[] }> = {
  anthropic: () => ({ path: '/v1/messages', queries: [''] }),
  openai: () => ({ path: '/v1/responses', queries: [''] }),
  google: (model) => ({
    path: `/v1beta/models/${model}:streamGenerateContent`,
    queries: ['', '?alt=sse'],
  }),
};

/** The raw path and query of an absolute URL string, before any normalization; null if absent. */
function rawPathAndQuery(raw: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(raw);
  return m ? (m[1] ?? '') : null;
}

/** Whether `raw` is exactly an allowed destination for this turn (D4 step 1). */
function destinationAllowed(raw: string, o: GuardedFetchOptions, hosts: ProviderHosts): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash || raw.includes('#')) return null;
  const rest = rawPathAndQuery(raw);
  if (rest === null) return null;
  const qAt = rest.indexOf('?');
  const path = qAt < 0 ? rest : rest.slice(0, qAt);
  const query = qAt < 0 ? '' : rest.slice(qAt);
  if (/%2f|%5c|%2e|\\/i.test(path) || path.includes('//')) return null;
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  // The model is one path segment where a path names it, and is never allowed to carry one.
  if (o.model.includes('/') || o.model.includes('..') || o.model.includes('%')) return null;

  let origin: string;
  let wantPath: string;
  let queries: string[];
  if (o.provider === 'openai-compatible') {
    if (o.baseUrl === null || o.baseOrigin === null) return null;
    let base: URL;
    try {
      base = new URL(o.baseUrl);
    } catch {
      return null;
    }
    if (base.origin !== o.baseOrigin) return null;
    origin = o.baseOrigin;
    wantPath = `${base.pathname.replace(/\/+$/, '')}/chat/completions`;
    queries = [''];
  } else {
    const fixed = FIXED_PATHS[o.provider];
    const host = (hosts as unknown as Record<string, string | undefined>)[o.provider];
    if (!fixed || !host) return null;
    origin = new URL(host).origin;
    ({ path: wantPath, queries } = fixed(o.model));
  }
  if (url.origin !== origin || path !== wantPath || !queries.includes(query)) return null;
  return url;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

function bodyBytes(body: RequestInit['body']): Buffer | null {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return null;
}

/** A `fetch` for one AI SDK turn on one credential (D4). Nothing from a request or response is
 * logged; every failure is an OutboundFailure of a fixed kind or the caller's abort. */
export function guardedFetch(o: GuardedFetchOptions): GuardedFetch {
  const hosts = o.hosts ?? PROVIDER_HOSTS;
  const headerTimeoutMs = o.headerTimeoutMs ?? GUARDED_FETCH_CAPS.headerTimeoutMs;
  const isBlocked = o.isBlocked ?? isBlockedAddress;
  const log: Array<{ requestBytes: number; responseBytes: number }> = [];
  let requests = 0;
  let requestTotal = 0;
  let responseTotal = 0;
  let breach: GuardedFetchBreach | null = null;
  const capped = (b: GuardedFetchBreach): never => {
    breach ??= b;
    throw new OutboundFailure('cap');
  };

  const run = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    if (typeof input !== 'string' && !(input instanceof URL)) throw new OutboundFailure('refused');
    const raw = typeof input === 'string' ? input : input.href;
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortError(signal);
    if ((init.method ?? 'GET').toUpperCase() !== 'POST') throw new OutboundFailure('refused');
    const url = destinationAllowed(raw, o, hosts);
    if (url === null) throw new OutboundFailure('refused');
    const body = bodyBytes(init.body);
    if (body === null) throw new OutboundFailure('refused');

    // Caps, before any connection (D4 step 3).
    if (breach !== null) throw new OutboundFailure('cap');
    if (requests >= GUARDED_FETCH_CAPS.requests) capped('requests');
    if (body.length > GUARDED_FETCH_CAPS.requestBodyBytes) capped('request-body');
    if (requestTotal + body.length > GUARDED_FETCH_CAPS.requestBodyTotalBytes) capped('request-total');
    requests += 1;
    requestTotal += body.length;
    const entry = { requestBytes: body.length, responseBytes: 0 };
    log.push(entry);

    // Resolve and check the address for this connection (D4 step 2).
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let target: { address: string; family: number };
    try {
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await (o.lookup ?? systemLookup)(hostname);
      if (addresses.length === 0) throw new OutboundFailure('unreachable');
      if (o.production && addresses.some((a) => isBlocked(a.address))) {
        throw new OutboundFailure('unreachable');
      }
      target = addresses[0] as { address: string; family: number };
    } catch {
      throw new OutboundFailure('unreachable');
    }
    if (signal?.aborted) throw abortError(signal);
    const pinned = (
      _host: string,
      opts: { all?: boolean } | undefined,
      cb: (err: null, address: unknown, family?: number) => void,
    ) => {
      if (opts?.all) cb(null, [{ address: target.address, family: target.family }]);
      else cb(null, target.address, target.family);
    };

    const headers: Record<string, string> = {};
    try {
      new Headers(init.headers).forEach((v, k) => {
        if (k !== 'host' && k !== 'content-length' && k !== 'connection') headers[k] = v;
      });
    } catch {
      throw new OutboundFailure('refused');
    }
    headers.host = url.host;
    headers['content-length'] = String(body.length);

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      };
      let r: ReturnType<typeof send>;
      const timer = setTimeout(() => {
        fail(new OutboundFailure('timeout'));
        r?.destroy();
      }, headerTimeoutMs);
      const onAbort = () => {
        fail(abortError(signal as AbortSignal));
        r?.destroy();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        r = send({
          protocol: url.protocol,
          hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers,
          lookup: pinned as never,
          servername: isIP(hostname) ? undefined : hostname,
          agent: false,
        });
      } catch {
        fail(new OutboundFailure('unreachable'));
        return;
      }
      r.on('error', () => fail(new OutboundFailure('unreachable')));
      r.on('response', (res: IncomingMessage) => {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const status = res.statusCode ?? 0;
        const out = new Headers();
        const rawHeaders = res.rawHeaders;
        for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
          try {
            out.append(rawHeaders[i] as string, rawHeaders[i + 1] as string);
          } catch {
            // A header the WHATWG Headers type refuses is dropped.
          }
        }
        let finished = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const stop = (e: unknown) => {
              if (finished) return;
              finished = true;
              signal?.removeEventListener('abort', onStreamAbort);
              controller.error(e);
              res.destroy();
              r.destroy();
            };
            const onStreamAbort = () => stop(abortError(signal as AbortSignal));
            signal?.addEventListener('abort', onStreamAbort, { once: true });
            res.on('data', (c: Buffer) => {
              if (finished) return;
              responseTotal += c.length;
              entry.responseBytes += c.length;
              if (responseTotal > GUARDED_FETCH_CAPS.responseTotalBytes) {
                breach ??= 'response-total';
                stop(new OutboundFailure('cap'));
                return;
              }
              controller.enqueue(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
              if ((controller.desiredSize ?? 1) <= 0) res.pause();
            });
            res.on('end', () => {
              if (finished) return;
              finished = true;
              signal?.removeEventListener('abort', onStreamAbort);
              controller.close();
            });
            res.on('error', () => stop(new OutboundFailure('unreachable')));
            res.on('aborted', () => stop(new OutboundFailure('unreachable')));
            res.on('close', () => {
              if (!finished) stop(new OutboundFailure('unreachable'));
            });
          },
          pull() {
            res.resume();
          },
          cancel() {
            finished = true;
            res.destroy();
            r.destroy();
          },
        });
        const nullBody = status === 204 || status === 205 || status === 304 || status < 200;
        try {
          if (nullBody) {
            void stream.cancel().catch(() => {});
            resolve(new Response(null, { status, headers: out }));
          } else {
            resolve(new Response(stream, { status, headers: out }));
          }
        } catch {
          res.destroy();
          reject(new OutboundFailure('unreachable'));
        }
      });
      r.end(body);
    });
  };

  return {
    fetch: run,
    byteLog: () => log.map((e) => ({ ...e })),
    breach: () => breach,
  };
}
