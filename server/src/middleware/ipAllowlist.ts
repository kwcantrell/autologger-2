// IP allowlist — ports the CSV/CIDR parse + match from web/deps.py + app.py.
// On Node the trusted client IP is the socket address, unless TRUST_PROXY
// explicitly delegates to the first X-Forwarded-For hop. Empty IP_ALLOWLIST ⇒ disabled.

import type { Context, MiddlewareHandler } from 'hono';
import { trustProxyEnabled } from '../env';
import type { AppEnv } from '../types';

interface Net {
  version: 4 | 6;
  base: bigint;
  bits: number;
}

const CIDR_RE = /^(.+)\/(\d{1,3})$/;

/** Strip URL-style [ipv6], zone id (%en0), and shell quotes. */
function normalizeEntry(partIn: string): string {
  let part = partIn.trim();
  if (
    part.length >= 2 &&
    part[0] === part[part.length - 1] &&
    (part[0] === '"' || part[0] === "'")
  ) {
    part = part.slice(1, -1).trim();
  }
  const m = CIDR_RE.exec(part);
  let addr = m ? m[1].trim() : part;
  const bits = m ? m[2] : null;
  if (addr.length >= 2 && addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  if (addr.includes('%')) addr = addr.split('%', 1)[0];
  addr = addr.trim();
  return bits !== null ? `${addr}/${bits}` : addr;
}

/** Strip a leading IPv4-mapped IPv6 prefix (::ffff:) from an incoming client address so
 * Node sockets reporting loopback as ::ffff:127.0.0.1 match a plain v4 allowlist entry.
 * Address-side only — allowlist entries keep their literal parsed version (see
 * `normalizeEntry`), so an operator-written ::ffff:10.0.0.0/24 stays a v6 network. */
function unmapV4(addrIn: string): string {
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addrIn.trim());
  return m ? m[1] : addrIn;
}

function ipv4ToBigInt(addr: string): bigint | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function ipv6ToBigInt(addrIn: string): bigint | null {
  let addr = addrIn;
  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) → convert the dotted quad to two hextets.
  const v4m = /(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (v4m) {
    const v4 = ipv4ToBigInt(v4m[2]);
    if (v4 === null) return null;
    const hi = (v4 >> 16n) & 0xffffn;
    const lo = v4 & 0xffffn;
    addr = `${v4m[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const dbl = addr.split('::');
  if (dbl.length > 2) return null;
  const splitGroups = (s: string): string[] => (s === '' ? [] : s.split(':'));
  let groups: string[];
  if (dbl.length === 2) {
    const head = splitGroups(dbl[0]);
    const tail = splitGroups(dbl[1]);
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = splitGroups(addr);
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function parseAddr(addr: string): { version: 4 | 6; value: bigint } | null {
  if (addr.includes(':')) {
    const v = ipv6ToBigInt(addr);
    return v === null ? null : { version: 6, value: v };
  }
  const v = ipv4ToBigInt(addr);
  return v === null ? null : { version: 4, value: v };
}

function maskValue(value: bigint, version: 4 | 6, bits: number): bigint {
  const total = version === 4 ? 32 : 128;
  if (bits >= total) return value;
  const shift = BigInt(total - bits);
  return value >> shift;
}

/** Parse IP_ALLOWLIST CSV into networks; null ⇒ disabled. Throws on a bad entry. */
export function parseIpAllowlist(raw: string): Net[] | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const out: Net[] = [];
  for (const partRaw of s.split(',')) {
    if (!partRaw.trim()) continue;
    const original = partRaw.trim();
    const part = normalizeEntry(partRaw);
    if (!part) continue;
    const slash = part.lastIndexOf('/');
    let addrStr = part;
    let bits: number | null = null;
    if (slash >= 0) {
      addrStr = part.slice(0, slash);
      bits = Number(part.slice(slash + 1));
    }
    const parsed = parseAddr(addrStr);
    if (parsed === null) {
      throw new Error(
        `Invalid IP_ALLOWLIST entry (after cleanup): ${part} (original: ${original})`,
      );
    }
    const total = parsed.version === 4 ? 32 : 128;
    const finalBits = bits === null ? total : bits;
    if (finalBits < 0 || finalBits > total) {
      throw new Error(`Invalid IP_ALLOWLIST prefix length in ${part} (original: ${original})`);
    }
    out.push({
      version: parsed.version,
      base: maskValue(parsed.value, parsed.version, finalBits),
      bits: finalBits,
    });
  }
  return out.length ? out : null;
}

export function ipInAllowlist(addr: string, nets: Net[]): boolean {
  const parsed = parseAddr(unmapV4(normalizeEntry(addr)));
  if (parsed === null) return false;
  return nets.some(
    (net) =>
      net.version === parsed.version &&
      maskValue(parsed.value, parsed.version, net.bits) === net.base,
  );
}

/** Client IP on Node: the socket address, unless TRUST_PROXY explicitly
 * delegates to the first X-Forwarded-For hop. CF header trust is gone. */
function effectiveClientIp(c: Context<AppEnv>): string {
  if (trustProxyEnabled(c.env.config)) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
  }
  return c.env.incoming?.socket?.remoteAddress ?? '';
}

// Parse once per distinct IP_ALLOWLIST string (env is injected per-request, so we
// can't parse at module load like the Python startup hook does).
let cache: { raw: string; nets: Net[] | null } | null = null;

function netsForEnv(raw: string): Net[] | null {
  if (cache && cache.raw === raw) return cache.nets;
  const nets = parseIpAllowlist(raw); // throws on bad config → 500 via onError
  cache = { raw, nets };
  return nets;
}

/** Hono middleware; registered first so it runs outermost. */
export const ipAllowlistMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const nets = netsForEnv(c.env.config.IP_ALLOWLIST ?? '');
  if (nets === null) return next();
  const addr = effectiveClientIp(c);
  if (ipInAllowlist(addr, nets)) return next();
  let detail =
    `Forbidden — client IP '${addr}' is not in IP_ALLOWLIST.\n` +
    'Add this IP (or your LAN CIDR) to the list, then restart the server.\n';
  if (addr.includes(':')) {
    detail +=
      'IPv6 tip: a home /64 is a:b:c:d::/64 (four groups). If the fourth group keeps' +
      ' changing, try a shorter prefix for the stable part, e.g. a:b:c::/48.\n';
  }
  return c.text(detail, 403);
};
