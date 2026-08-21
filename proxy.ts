import { NextRequest, NextResponse } from 'next/server';

// /api/sidecar is public here because its own route handlers each enforce
// their own X-Sidecar-Secret check internally (see
// app/api/sidecar/vnc-passwords/route.ts) -- distinct scheme from the
// extension's X-Extension-Secret below, so it doesn't fit EXTENSION_ALLOWED.
// Confirmed broken without this: proxy blocked it before the route's own
// (correctly-implemented) secret check ever ran, returning an identical
// 401 regardless of whether the right secret was sent.
const PUBLIC = ['/login', '/api/auth', '/api/users', '/api/sidecar'];
const EXTENSION_ALLOWED = [
  '/api/import',
  '/api/users',
  '/api/extension',  // command queue polling (GET) + status PATCH
  '/api/orders',     // backfill GET + per-order PATCH for backfilled fields
  '/api/bg',           // host-side one-shot backfill (e.g. curl from Unraid)
  '/api/buyinggroup',  // extension API Spy fires sync-commitments after edit_commitment
  '/api/cardcenter',   // host-side sync-payments invocation
  '/api/bfmr',         // server-side auto-sync + extension sync
  '/api/bigsky',       // server-side auto-sync + extension tracking submit
  '/api/api-errors',   // extension API Spy POSTs ingested CC/etc errors here
  '/api/settings',     // sidecar's getSettings/setSettings (last-sync tracking,
                        // vnc_password) -- sends X-Extension-User-Id same as
                        // every other sidecar call, was missing from this list
                        // entirely so every sidecar settings call 401'd too.
];

function withCors(res: NextResponse, origin: string) {
  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Extension-User-Id, X-Extension-Secret, X-Extension-Browser');
  return res;
}

export default function middleware(req: NextRequest) {
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

  if (PUBLIC.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const uid = req.cookies.get('resell_uid')?.value;
  if (!uid) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
