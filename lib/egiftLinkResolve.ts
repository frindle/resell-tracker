// Following a Costco eGift click-tracking link (https://link.memberedelivery.com/ls/click?upn=...)
// to the delivery link it redirects to. Some delivery emails carry only tracked links, so without
// this their orders never get a link. Each hop is a plain GET with redirects handled here, so every
// hop's host is checked: only memberedelivery.com tracking hosts and SendGrid are followed, and the
// answer must be a valid www.memberedelivery.com/?login= link. Following a link counts as a click,
// so lib/egiftIngest.ts calls this only when the order has no link yet. The links are secrets:
// nothing here logs them, and errors are swallowed (their text could carry the url).
import { parseCostcoDeliveryLink } from './egiftLinkParse.ts';
import { findDeliveryLink, isTrackingHost } from './egiftDelivery.ts';

export type ResolveOpts = { maxHops?: number; timeoutMs?: number; maxLinks?: number };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function trackingUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || !isTrackingHost(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

async function resolveOne(start: URL, fetchFn: typeof fetch, maxHops: number, timeoutMs: number): Promise<string | null> {
  let cur = start;
  for (let hop = 0; hop < maxHops; hop++) {
    const res = await fetchFn(cur.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!loc) return null;
      let next: URL;
      try { next = new URL(loc, cur); } catch { return null; }
      const direct = parseCostcoDeliveryLink(next.toString());
      if (direct.ok) return direct.normalized;
      const hopUrl = trackingUrl(next.toString());
      if (!hopUrl) return null; // somewhere else: stop
      cur = hopUrl;
      continue;
    }
    if (res.ok) {
      // A tracking page that redirects in html (meta refresh or a link) instead of a 3xx.
      const body = (await res.text()).slice(0, 200_000);
      return findDeliveryLink(body, '');
    }
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  return null;
}

/** The delivery link the first resolvable tracked link leads to, or null. Never throws. */
export async function resolveTrackedDeliveryLink(
  urls: readonly string[],
  fetchFn: typeof fetch = fetch,
  opts: ResolveOpts = {},
): Promise<string | null> {
  const { maxHops = 5, timeoutMs = 10_000, maxLinks = 3 } = opts;
  const seen = new Set<string>();
  for (const raw of urls) {
    if (seen.size >= maxLinks) break;
    const start = trackingUrl(raw);
    if (!start || seen.has(start.toString())) continue;
    seen.add(start.toString());
    try {
      const link = await resolveOne(start, fetchFn, maxHops, timeoutMs);
      if (link) return link;
    } catch {
      // timeout, network error: try the next link
    }
  }
  return null;
}
