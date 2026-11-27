// Fetching a user-supplied URL without letting it reach internal addresses.
// The host is resolved first and every address must be public; redirects are
// followed by hand (max 5 hops) with the same check on every hop, all under one
// overall deadline. Unit tested with an injected resolver and fetch.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BlockedUrlError extends Error {}

export const MAX_HOPS = 5;
export const OVERALL_MS = 8000;

function v4Blocked(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;          // unspecified/this-net, private, loopback
  if (a === 169 && b === 254) return true;                    // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;          // private
  if (a === 192 && b === 168) return true;                    // private
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true;           // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
  if (a >= 224) return true;                                  // multicast, reserved, broadcast
  return false;
}

function parseV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf('%'); if (pct >= 0) s = s.slice(0, pct);
  // trailing dotted quad -> two hextets
  const m = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [x, y, z, w] = m.slice(2).map(Number);
    if ([x, y, z, w].some(n => n > 255)) return null;
    s = `${m[1]}${((x << 8) | y).toString(16)}:${((z << 8) | w).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  const out = all.map(h => parseInt(h, 16));
  return out.length === 8 && out.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null;
}

/** True for any address that is not a normal public unicast address. Unparseable input is blocked. */
export function isBlockedIp(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, '');
  const kind = isIP(host);
  if (kind === 4) {
    const [a, b, c] = host.split('.').map(Number);
    return v4Blocked(a, b, c);
  }
  if (kind === 6) {
    const h = parseV6(host);
    if (!h) return true;
    if (h.every(n => n === 0)) return true;                                   // ::
    if (h.slice(0, 7).every(n => n === 0) && h[7] === 1) return true;         // ::1
    if ((h[0] & 0xfe00) === 0xfc00) return true;                              // fc00::/7 unique local
    if ((h[0] & 0xffc0) === 0xfe80) return true;                              // fe80::/10 link-local
    if ((h[0] & 0xff00) === 0xff00) return true;                              // multicast
    const embedded = h.slice(0, 5).every(n => n === 0) && (h[5] === 0xffff || h[5] === 0)
      || (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every(n => n === 0)); // v4-mapped, v4-compatible, NAT64
    if (embedded) return v4Blocked(h[6] >> 8, h[6] & 255, h[7] >> 8);
    return false;
  }
  return true;
}

export type Resolver = (host: string) => Promise<string[]>;

export const dnsResolver: Resolver = async host => (await lookup(host, { all: true, verbatim: true })).map(a => a.address);

/** Throws BlockedUrlError unless the URL is http(s) and its host is, or resolves only to, public addresses. */
export async function assertPublicUrl(raw: string, resolve: Resolver = dnsResolver): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new BlockedUrlError('invalid url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError('scheme not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw new BlockedUrlError('host not allowed');
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new BlockedUrlError('address not allowed');
    return u;
  }
  let addrs: string[];
  try { addrs = await resolve(host); } catch { throw new BlockedUrlError('host did not resolve'); }
  if (addrs.length === 0 || addrs.some(isBlockedIp)) throw new BlockedUrlError('address not allowed');
  return u;
}

export type FetchLike = (url: string, init: { method: string; redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

/**
 * GET with manual redirects. Every hop's host is checked before it is requested.
 * Returns the URL of the last response that was not a redirect. Throws
 * BlockedUrlError on a blocked hop or too many hops.
 */
export async function fetchFinalUrl(raw: string, opts: {
  resolve?: Resolver; fetchImpl?: FetchLike; maxHops?: number; timeoutMs?: number; userAgent?: string;
} = {}): Promise<string> {
  const { resolve = dnsResolver, maxHops = MAX_HOPS, timeoutMs = OVERALL_MS } = opts;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const signal = AbortSignal.timeout(timeoutMs); // one deadline for the whole chain
  let current = raw;
  for (let hop = 0; hop <= maxHops; hop++) {
    const u = await assertPublicUrl(current, resolve);
    const res = await fetchImpl(u.toString(), {
      method: 'GET', redirect: 'manual', signal,
      headers: { 'User-Agent': opts.userAgent ?? 'Mozilla/5.0 (compatible; link-resolver/1.0)' },
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      try { current = new URL(loc, u).toString(); } catch { throw new BlockedUrlError('bad redirect'); }
      continue;
    }
    return u.toString();
  }
  throw new BlockedUrlError('too many redirects');
}
