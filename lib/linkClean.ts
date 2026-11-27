// Scrubbing deal links: unwrap redirectors, strip affiliate/tracking params.
// Pure (no imports), unit tested. Moved out of app/api/bfmr/resolve-link.

export const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'tag', 'linkCode', 'camp', 'creative', 'creativeASIN', 'ascsubtag', 'linkId',
  'wmlspartner', 'affp', 'veh', 'sourceid', 'adid',
  'WT.mc_id', 'icmpid', 'cid',
  'ranMID', 'ranEAID', 'ranSiteID', 'AID', 'PID', 'u1',
  'ref', 'aff_id', 'affiliate_id', 'clickid', 'click_id', 'sid', 'vsid',
  'cmpid', 'cmp', 'LSNSUBSITE', 'LSNPUBID',
]);

export const RETAIL_DOMAINS = new Set([
  'amazon.com', 'walmart.com', 'bestbuy.com', 'target.com',
  'dell.com', 'costco.com', 'bhphotovideo.com', 'homedepot.com',
  'lowes.com', 'staples.com', 'samsclub.com', 'bedbathandbeyond.com',
]);

// Common param names that cashback/affiliate redirectors use to encode the real destination
export const DEST_PARAMS = ['url', 'dest', 'destination', 'u', 'r', 'redirect', 'to', 'target', 'link', 'goto', 'out'];

export function extractDestParam(u: URL): string | null {
  for (const p of DEST_PARAMS) {
    const v = u.searchParams.get(p);
    if (v && (v.startsWith('https://') || v.startsWith('http://'))) return v;
  }
  return null;
}

export function cleanUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }

  const host = u.hostname.replace(/^www\./, '');

  if (host === 'amazon.com' || host.endsWith('.amazon.com')) {
    const m = u.pathname.match(/\/dp\/([A-Z0-9]{10})/i);
    if (m) return `https://www.amazon.com/dp/${m[1]}`;
  }
  if (host === 'walmart.com') return `https://www.walmart.com${u.pathname}`;
  if (host === 'bestbuy.com') return `https://www.bestbuy.com${u.pathname}`;
  if (host === 'target.com') return `https://www.target.com${u.pathname}`;
  if (host === 'dell.com' || host.endsWith('.dell.com')) return `https://www.dell.com${u.pathname}`;

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || key.toLowerCase().startsWith('utm_')) {
      u.searchParams.delete(key);
    }
  }
  return u.toString();
}

export const hostOf = (url: string): string | null => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
};

/** http(s) only: the page never opens javascript: or data: links. */
export function isHttpUrl(s: string): boolean {
  try { const p = new URL(s).protocol; return p === 'https:' || p === 'http:'; } catch { return false; }
}

/**
 * The clean URL when it can be decided without a network hop: a retail domain,
 * or a redirector that carries the real destination in a param. Null when the
 * redirect chain has to be followed.
 */
export function resolveOffline(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (RETAIL_DOMAINS.has(u.hostname.replace(/^www\./, ''))) return cleanUrl(raw);
  const dest = extractDestParam(u);
  return dest ? cleanUrl(dest) : null;
}

/** The clean URL once the redirect chain landed on `finalUrl`. */
export function resolveLanded(finalUrl: string): string {
  let p: URL;
  try { p = new URL(finalUrl); } catch { return cleanUrl(finalUrl); }
  if (RETAIL_DOMAINS.has(p.hostname.replace(/^www\./, ''))) return cleanUrl(finalUrl);
  const dest = extractDestParam(p);
  return cleanUrl(dest ?? finalUrl);
}
