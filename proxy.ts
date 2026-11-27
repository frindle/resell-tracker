import { NextRequest, NextResponse } from 'next/server';
import { bloomAccess, isBloomPath } from './lib/bloomAccess.ts';

// /api/sidecar is public here because its own route handlers each enforce
// their own X-Sidecar-Secret check internally (see
// app/api/sidecar/vnc-passwords/route.ts) -- distinct scheme from the
// extension's X-Extension-Secret below, so it doesn't fit EXTENSION_ALLOWED.
// Confirmed broken without this: proxy blocked it before the route's own
// (correctly-implemented) secret check ever ran, returning an identical
// 401 regardless of whether the right secret was sent.
// /api/upload (phone photo upload) checks its own per-user upload token; see
// app/api/upload/photo/route.ts. It accepts nothing without one.
const PUBLIC = ['/login', '/api/auth', '/api/users', '/api/sidecar', '/api/upload'];
const EXTENSION_ALLOWED = [
  '/api/import',
  '/api/users',
  '/api/extension',  // command queue polling (GET) + status PATCH
  '/api/orders',     // backfill GET + per-order PATCH for backfilled fields
  '/api/bg',           // host-side one-shot backfill (e.g. curl from Unraid)
  '/api/buyinggroup',  // extension API Spy fires sync-commitments after edit_commitment
  '/api/cardcenter',   // host-side sync-payments invocation
  '/api/bfmr',         // server-side auto-sync + extension sync
  '/api/giftcard-ocr', // giftcard-ocr extension API (ingest route)
  '/api/bigsky',       // server-side auto-sync + extension tracking submit
  '/api/api-errors',   // extension API Spy POSTs ingested CC/etc errors here
  '/api/settings',     // sidecar's getSettings/setSettings (last-sync tracking,
                        // vnc_password) -- sends X-Extension-User-Id same as
                        // every other sidecar call, was missing from this list
                        // entirely so every sidecar settings call 401'd too.
];
// The extension calls these before it holds the secret, so they skip the secret check. They only
// create or redeem a pairing that a signed-in user approves (see lib/extensionPairing.ts).
const PAIRING_OPEN = ['/api/extension/pair', '/api/extension/pair/claim'];

function withCors(res: NextResponse, origin: string) {
  res.headers.set('Access-Control-Allow-Origin', origin);
  // PATCH is how the extension claims a command (/api/extension/commands/[id]).
  // Without it the browser blocks that call whenever the extension lacks host
  // access to the tracker, so the command stays pending and the sync never claims.
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Extension-User-Id, X-Extension-Secret, X-Extension-Browser, If-None-Match');
  // Lets the extension read the scrape config version off the commands poll.
  res.headers.set('Access-Control-Expose-Headers', 'X-Scrape-Config-Version, ETag');
  return res;
}

export function isExtensionAllowedPath(pathname: string): boolean {
  return EXTENSION_ALLOWED.some(p => pathname === p || pathname.startsWith(p + "/"));
}

export default function middleware(req: NextRequest): NextResponse | Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const origin = req.headers.get('origin') ?? '';
  const hasExtensionHeader = req.headers.has('X-Extension-User-Id');

  // Extension content scripts run in the context of amazon.com / walmart.com,
  // so origin is those sites — detect by the custom header instead.
  const isExtension =
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    hasExtensionHeader;

  const isExtensionRoute = EXTENSION_ALLOWED.some(p => pathname === p || pathname.startsWith(p + '/'));

  // Handle CORS preflight
  if (req.method === 'OPTIONS' && isExtensionRoute) {
    return withCors(new NextResponse(null, { status: 204 }), origin || '*');
  }

  if (PAIRING_OPEN.includes(pathname)) {
    return withCors(NextResponse.next(), origin || '*');
  }

  // Extension requests to allowed routes pass through with CORS headers,
  // but only after the shared-secret check (when configured). Without the
  // secret, any LAN host that knows X-Extension-User-Id could write orders
  // / submit tracking for an arbitrary user.
  if (isExtension && isExtensionRoute) {
    const required = process.env.EXTENSION_SHARED_SECRET;
    if (required) {
      const provided = req.headers.get('X-Extension-Secret') ?? '';
      if (provided !== required) {
        return withCors(
          NextResponse.json({ error: 'extension secret missing or invalid' }, { status: 401 }),
          origin || '*',
        );
      }
    }
    return withCors(NextResponse.next(), origin || '*');
  }

  // Bloom (pages and /api/bloom/*) has its own gate instead of the sign-in cookie: open on the LAN, Cloudflare Access
  // (a verified JWT) through the domain. See lib/bloomAccess.ts.
  if (isBloomPath(pathname)) {
    return bloomAccess(req.headers).then(a => {
      if (a.ok) return NextResponse.next();
      if (pathname.startsWith('/api/')) return NextResponse.json({ error: `Cloudflare Access required (${a.reason})` }, { status: 403 });
      return new NextResponse('Cloudflare Access required', { status: 403 });
    });
  }

  if (PUBLIC.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const uid = req.cookies.get('resell_uid')?.value;
  if (!uid) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    // Back to the page after sign-in (the login page only follows same-site paths).
    const back = pathname + (req.nextUrl.search ?? '');
    url.pathname = '/login';
    url.search = back === '/' ? '' : `?next=${encodeURIComponent(back)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
