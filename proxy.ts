import { NextRequest, NextResponse } from 'next/server';

const PUBLIC = ['/login', '/api/auth', '/api/users'];
const EXTENSION_ALLOWED = [
  '/api/import',
  '/api/users',
  '/api/extension',  // command queue polling (GET) + status PATCH
  '/api/orders',     // backfill GET + per-order PATCH for backfilled fields
  '/api/bg',         // host-side one-shot backfill (e.g. curl from Unraid)
  '/api/cardcenter', // host-side sync-payments invocation
];

function withCors(res: NextResponse, origin: string) {
  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Extension-User-Id');
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

  // Extension requests to allowed routes pass through with CORS headers
  if (isExtension && isExtensionRoute) {
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
