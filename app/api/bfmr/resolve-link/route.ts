import { NextRequest } from 'next/server';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'tag', 'linkCode', 'camp', 'creative', 'creativeASIN', 'ascsubtag', 'linkId',
  'wmlspartner', 'affp', 'veh', 'sourceid', 'adid',
  'WT.mc_id', 'icmpid', 'cid',
  'ranMID', 'ranEAID', 'ranSiteID', 'AID', 'PID', 'u1',
  'ref', 'aff_id', 'affiliate_id', 'clickid', 'click_id', 'sid', 'vsid',
  'cmpid', 'cmp', 'LSNSUBSITE', 'LSNPUBID',
]);

const RETAIL_DOMAINS = new Set([
  'amazon.com', 'walmart.com', 'bestbuy.com', 'target.com',
  'dell.com', 'costco.com', 'bhphotovideo.com', 'homedepot.com',
  'lowes.com', 'staples.com', 'samsclub.com', 'bedbathandbeyond.com',
]);

// Common param names that cashback/affiliate redirectors use to encode the real destination
const DEST_PARAMS = ['url', 'dest', 'destination', 'u', 'r', 'redirect', 'to', 'target', 'link', 'goto', 'out'];

function extractDestParam(u: URL): string | null {
  for (const p of DEST_PARAMS) {
    const v = u.searchParams.get(p);
    if (v && (v.startsWith('https://') || v.startsWith('http://'))) return v;
  }
  return null;
}

function cleanUrl(raw: string): string {
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

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('url');
  if (!raw) return new Response('Missing url param', { status: 400 });

  let originalUrl: URL;
  try { originalUrl = new URL(raw); } catch { return new Response('Invalid URL', { status: 400 }); }
  if (originalUrl.protocol !== 'https:' && originalUrl.protocol !== 'http:') {
    return new Response('Only http/https URLs allowed', { status: 400 });
  }

  const rawHost = originalUrl.hostname.replace(/^www\./, '');

  // Already a retail domain — clean and return immediately
  if (RETAIL_DOMAINS.has(rawHost)) {
    return Response.json({ url: cleanUrl(raw) });
  }

  // Check if the original URL itself encodes the real destination in a param
  // (handles ftc.cash, snaptheprice.com, fatcoupon.com, and any future redirectors)
  const destFromOriginal = extractDestParam(originalUrl);
  if (destFromOriginal) {
    return Response.json({ url: cleanUrl(destFromOriginal) });
  }

  // Follow the redirect chain
  try {
    const res = await fetch(raw, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; link-resolver/1.0)' },
    });

    const finalUrl = res.url;
    let finalParsed: URL;
    try { finalParsed = new URL(finalUrl); } catch { return Response.json({ url: cleanUrl(raw) }); }

    const finalHost = finalParsed.hostname.replace(/^www\./, '');

    // Landed on a retail page — clean and return
    if (RETAIL_DOMAINS.has(finalHost)) {
      return Response.json({ url: cleanUrl(finalUrl) });
    }

    // Final URL encodes the real destination in a param
    const destFromFinal = extractDestParam(finalParsed);
    if (destFromFinal) {
      return Response.json({ url: cleanUrl(destFromFinal) });
    }

    return Response.json({ url: cleanUrl(finalUrl) });
  } catch {
    return Response.json({ url: cleanUrl(raw) });
  }
}
