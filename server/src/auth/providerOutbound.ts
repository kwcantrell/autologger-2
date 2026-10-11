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

export type OutboundFailureKind = 'unreachable' | 'timeout';

/** A provider request that got no HTTP answer. Its message is fixed and never holds request data. */
export class OutboundFailure extends Error {
  constructor(readonly kind: OutboundFailureKind) {
    super(kind === 'timeout' ? 'provider request timed out' : 'provider unreachable');
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
