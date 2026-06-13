import { NextRequest } from 'next/server';

// Params that exist solely for tracking/affiliate attribution — never needed to reach the product
const TRACKING_PARAMS = new Set([
  // UTM (any utm_* is matched below by prefix check)
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  // Amazon affiliate
  'tag', 'linkCode', 'camp', 'creative', 'creativeASIN', 'ascsubtag', 'linkId',
  // Walmart affiliate
  'wmlspartner', 'affp', 'veh', 'sourceid', 'adid',
  // Dell / HP
  'WT.mc_id', 'icmpid', 'cid',
  // Rakuten / CJ affiliate networks
  'ranMID', 'ranEAID', 'ranSiteID', 'AID', 'PID', 'u1',
  // Generic affiliate/click tracking
  'ref', 'aff_id', 'affiliate_id', 'clickid', 'click_id', 'sid', 'vsid',
  'cmpid', 'cmp', 'LSNSUBSITE', 'LSNPUBID',
]);

function cleanUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }

  const host = u.hostname.replace(/^www\./, '');

  // Amazon: reconstruct as bare /dp/ASIN — all query params are noise
  if (host === 'amazon.com' || host.endsWith('.amazon.com')) {
    const m = u.pathname.match(/\/dp\/([A-Z0-9]{10})/i);
    if (m) return `https://www.amazon.com/dp/${m[1]}`;
  }

  // Walmart: item lives in the path (/ip/name/itemId), no params needed
  if (host === 'walmart.com') {
    return `https://www.walmart.com${u.pathname}`;
  }

  // Best Buy: SKU in path, no params needed
  if (host === 'bestbuy.com') {
    return `https://www.bestbuy.com${u.pathname}`;
  }

  // Target: product in path
  if (host === 'target.com') {
    return `https://www.target.com${u.pathname}`;
  }

  // Dell: product in path
  if (host === 'dell.com' || host.endsWith('.dell.com')) {
    return `https://www.dell.com${u.pathname}`;
  }

  // Default: strip known tracking params and any utm_* prefix
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || key.toLowerCase().startsWith('utm_')) {
      u.searchParams.delete(key);
    }
  }

  return u.toString();
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('url');
  if (!raw) return new Response('Missing url param', { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return new Response('Only http/https URLs allowed', { status: 400 });
  }

  try {
    const res = await fetch(raw, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; link-resolver/1.0)' },
    });
    const finalUrl = cleanUrl(res.url);
    return Response.json({ url: finalUrl });
  } catch {
    // HEAD failed (some servers don't support it) — return cleaned original
    return Response.json({ url: cleanUrl(raw) });
  }
}
