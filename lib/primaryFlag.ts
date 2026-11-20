// Which side is primary during a Move Mode disaster-recovery move: "home" or "cloud".
//
// The flag is the DNS TXT record _dr-primary.penndalton.com, value "home" or "cloud", optionally "home;since=<epoch>".
// Only the instance whose role (env DR_INSTANCE=home|cloud, default home) matches the flag runs background work that
// pulls from or writes to the outside world: email import, payment/BFMR syncs, watchers, reminders, invoice pulls.
// The other side stays up for people to use but does not run those jobs, so two copies never pull the same inbox
// or sell the same card.
//
// Rules:
//  - Two DNS-over-HTTPS resolvers, short timeout. If they disagree the higher since= wins; a tie reads as unknown.
//  - Unknown (no answer, no record, a tie) uses the last value read. Never read at all means "home".
//  - Only background jobs call this (gated()). A person's click in the UI never does, so it is never blocked.
//  - It never throws. Logs name the job, the flag and the role, nothing else.
//
// No imports: the unit tests run this file directly under node.

export type Flag = 'home' | 'cloud';
export type Role = Flag;
export type FlagRead = { value: Flag | 'unknown' };
export type Decision = { run: boolean; flag: Flag; source: 'live' | 'cached' | 'assumed'; role: Role };

export interface Deps {
  fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  now: () => number;
  resolvers: string[];
  name: string;
  timeoutMs: number;
  ttlMs: number;
  role: Role;
  log: (line: string) => void;
}

export const DEFAULT_NAME = '_dr-primary.penndalton.com';
export const DEFAULT_RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.quad9.net:5053/dns-query'];
const LOG_EVERY_MS = 30 * 60 * 1000;

export function parseRole(v: string | undefined): Role {
  return v === 'cloud' ? 'cloud' : 'home';
}

// "home", "\"cloud;since=123\"", or several quoted chunks of one TXT record -> { value, since }. Anything else -> null.
export function parseTxt(data: string): { value: Flag; since: number } | null {
  const joined = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).join('') || data;
  const parts = joined.trim().split(';').map(s => s.trim());
  const value = parts[0].toLowerCase();
  if (value !== 'home' && value !== 'cloud') return null;
  let since = 0;
  for (const p of parts.slice(1)) {
    const m = /^since=(\d{1,12})$/.exec(p);
    if (m) since = Number(m[1]);
  }
  return { value, since };
}

type One = { value: Flag; since: number } | null;

async function askOne(url: string, d: Deps): Promise<One> {
  try {
    const signal = AbortSignal.timeout(d.timeoutMs);
    const res = await d.fetch(`${url}?name=${encodeURIComponent(d.name)}&type=TXT`, { headers: { accept: 'application/dns-json' }, signal });
    if (!res.ok) return null;
    const body = await res.json() as { Status?: number; Answer?: { type?: number; data?: string }[] };
    if (body.Status !== 0 || !Array.isArray(body.Answer)) return null;
    let best: One = null;
    for (const a of body.Answer) {
      if (a.type !== 16 || typeof a.data !== 'string') continue;
      const p = parseTxt(a.data);
      if (p && (!best || p.since > best.since)) best = p;
    }
    return best;
  } catch {
    return null;
  }
}

// The flag as the resolvers say it right now: home, cloud, or unknown.
export async function readFlag(d: Deps): Promise<FlagRead> {
  const got = (await Promise.all(d.resolvers.map(r => askOne(r, d)))).filter((x): x is NonNullable<One> => x !== null);
  if (!got.length) return { value: 'unknown' };
  if (got.every(g => g.value === got[0].value)) return { value: got[0].value };
  const top = Math.max(...got.map(g => g.since));
  const winners = got.filter(g => g.since === top);
  return winners.every(w => w.value === winners[0].value) && top > 0 ? { value: winners[0].value } : { value: 'unknown' };
}

export function createGate(d: Deps) {
  let last: { flag: Flag; at: number } | null = null;   // last value actually read
  let inflight: Promise<FlagRead> | null = null;
  const lastLogged = new Map<string, number>();

  async function current(): Promise<{ flag: Flag; source: Decision['source'] }> {
    if (last && d.now() - last.at < d.ttlMs) return { flag: last.flag, source: 'live' };
    inflight ??= readFlag(d).finally(() => { inflight = null; });
    let r: FlagRead;
    try { r = await inflight; } catch { r = { value: 'unknown' }; }
    if (r.value !== 'unknown') { last = { flag: r.value, at: d.now() }; return { flag: r.value, source: 'live' }; }
    return last ? { flag: last.flag, source: 'cached' } : { flag: 'home', source: 'assumed' };
  }

  async function decide(job: string): Promise<Decision> {
    const { flag, source } = await current();
    const run = flag === d.role;
    if (!run) {
      const t = d.now();
      const prev = lastLogged.get(job);
      if (prev === undefined || t - prev >= LOG_EVERY_MS) {
        lastLogged.set(job, t);
        d.log(`[primary] skip ${job}: flag=${flag} (${source}), this instance=${d.role}`);
      }
    }
    return { run, flag, source, role: d.role };
  }

  // Wrap a background job. The job runs only when the flag names this instance.
  function gated<A extends unknown[]>(job: string, fn: (...a: A) => unknown): (...a: A) => Promise<void> {
    return async (...a: A) => {
      let go = true;
      try { go = (await decide(job)).run; } catch { go = d.role === 'home'; }
      if (go) await fn(...a);
    };
  }

  return { decide, gated };
}

function envDeps(): Deps {
  const env = typeof process !== 'undefined' ? process.env : {} as Record<string, string | undefined>;
  const urls = (env.DR_DOH_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    resolvers: urls.length ? urls : DEFAULT_RESOLVERS,
    name: env.DR_FLAG_NAME || DEFAULT_NAME,
    timeoutMs: Number(env.DR_FLAG_TIMEOUT_MS) || 3000,
    ttlMs: Number(env.DR_FLAG_TTL_MS) || 60_000,
    role: parseRole(env.DR_INSTANCE),
    log: line => console.log(line),
  };
}

let shared: ReturnType<typeof createGate> | null = null;
function gate() { return (shared ??= createGate(envDeps())); }

/** Wrap a scheduled job so it runs only on the primary side. Never wrap code a person triggers from the UI. */
export function gated<A extends unknown[]>(job: string, fn: (...a: A) => unknown): (...a: A) => Promise<void> {
  return gate().gated(job, fn);
}
export function shouldRunBackground(job: string): Promise<Decision> {
  return gate().decide(job);
}
