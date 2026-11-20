// Who may open the Bloom pages and /api/bloom/*.
//   - Opened on the LAN by IP: no login of any kind.
//   - Opened through the public domain: Cloudflare Access is the gate. Its JWT (Cf-Access-Jwt-Assertion) is verified here
//     against the team's published keys, issuer and audience, the same checks plex-automation's app_auth.py makes.
// How a request is told apart: everything that arrives through Cloudflare carries Cloudflare's own headers (Cf-Ray,
// Cf-Connecting-Ip, Cf-Visitor, Cf-Access-Jwt-Assertion, ...). Cloudflare always adds them and a visitor on the internet cannot
// remove them, so any one of them means "came in through the domain". A request with none of them reached the app directly,
// which only the LAN can do. The TCP peer is not used: the tunnel connector sits on the LAN too.
// Settings: CF_ACCESS_TEAM_DOMAIN (e.g. team.cloudflareaccess.com) and CF_ACCESS_AUDS (comma-separated application AUDs).
// Not configured => a request through the domain is refused (fails closed). Web APIs only, so it runs in proxy and routes.

export type Env = { CF_ACCESS_TEAM_DOMAIN?: string; CF_ACCESS_AUDS?: string };
export type AccessResult = { ok: true; via: 'lan' | 'access' } | { ok: false; reason: string };

const CF_HEADERS = ['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'cf-ipcountry', 'cf-access-jwt-assertion', 'cf-access-authenticated-user-email', 'cf-connecting-ipv6'];
const LEEWAY_S = 60;
const KEYS_TTL_MS = 10 * 60_000;
const KEYS_MIN_REFETCH_MS = 30_000;

export function viaDomain(headers: Headers): boolean {
  return CF_HEADERS.some(h => headers.has(h));
}

const b64d = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const text = (s: string) => new TextDecoder().decode(b64d(s));

type KeyCache = { byKid: Map<string, CryptoKey>; at: number; domain: string };
let cache: KeyCache = { byKid: new Map(), at: 0, domain: '' };
export function resetKeyCache() { cache = { byKid: new Map(), at: 0, domain: '' }; }

async function fetchKeys(domain: string, f: typeof fetch): Promise<Map<string, CryptoKey>> {
  const res = await f(`https://${domain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`certs HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const out = new Map<string, CryptoKey>();
  for (const k of body.keys ?? []) {
    if (k.kty !== 'RSA' || !k.kid) continue;
    try {
      out.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    } catch { /* skip a key we cannot import */ }
  }
  return out;
}

async function keyFor(kid: string, domain: string, f: typeof fetch): Promise<CryptoKey | null> {
  const now = Date.now();
  const same = cache.domain === domain;
  if (same && now - cache.at < KEYS_TTL_MS && cache.byKid.has(kid)) return cache.byKid.get(kid)!;
  if (same && now - cache.at < KEYS_MIN_REFETCH_MS) return cache.byKid.get(kid) ?? null;
  try {
    cache = { byKid: await fetchKeys(domain, f), at: now, domain };
  } catch {
    return same ? cache.byKid.get(kid) ?? null : null;   // keep serving the last good set for a known key id
  }
  return cache.byKid.get(kid) ?? null;
}

function teamDomain(env: Env): string {
  return (env.CF_ACCESS_TEAM_DOMAIN ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** Valid Access token for this team and one of the configured audiences, else the reason it was refused. */
export async function verifyAccessJwt(token: string, env: Env, f: typeof fetch = fetch, nowMs = Date.now()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const domain = teamDomain(env);
  const auds = (env.CF_ACCESS_AUDS ?? '').split(',').map(a => a.trim()).filter(Boolean);
  if (!domain || !auds.length) return { ok: false, reason: 'access not configured' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'jwt malformed' };
  let header: Record<string, unknown>, claims: Record<string, unknown>, sig: Uint8Array;
  try {
    header = JSON.parse(text(parts[0])); claims = JSON.parse(text(parts[1])); sig = b64d(parts[2]);
  } catch { return { ok: false, reason: 'jwt malformed' }; }
  if (!header || !claims || typeof header !== 'object' || typeof claims !== 'object') return { ok: false, reason: 'jwt malformed' };
  if (header.alg !== 'RS256') return { ok: false, reason: 'jwt alg' };
  const key = await keyFor(typeof header.kid === 'string' ? header.kid : '', domain, f);
  if (!key) return { ok: false, reason: 'jwt unknown key' };
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let valid = false;
  try { valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig as BufferSource, signed); } catch { /* invalid */ }
  if (!valid) return { ok: false, reason: 'jwt bad signature' };
  const now = nowMs / 1000;
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'jwt exp missing' };
  if (exp < now - LEEWAY_S) return { ok: false, reason: 'jwt expired' };
  if (claims.nbf !== undefined && Number(claims.nbf) > now + LEEWAY_S) return { ok: false, reason: 'jwt not yet valid' };
  if (claims.iss !== `https://${domain}`) return { ok: false, reason: 'jwt issuer' };
  const aud = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? (claims.aud as unknown[]) : [];
  if (!aud.some(a => typeof a === 'string' && auds.includes(a))) return { ok: false, reason: 'jwt audience' };
  return { ok: true };
}

export async function bloomAccess(headers: Headers, env: Env = process.env, f: typeof fetch = fetch): Promise<AccessResult> {
  if (!viaDomain(headers)) return { ok: true, via: 'lan' };
  const token = headers.get('cf-access-jwt-assertion');
  if (!token) return { ok: false, reason: 'no Access token' };
  const v = await verifyAccessJwt(token, env, f);
  return v.ok ? { ok: true, via: 'access' } : v;
}

export const isBloomPath = (p: string) => p === '/bloom' || p.startsWith('/bloom/') || p === '/api/bloom' || p.startsWith('/api/bloom/');
