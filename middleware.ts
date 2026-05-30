import { NextRequest, NextResponse } from 'next/server';

const PUBLIC = ['/login', '/api/auth', '/api/users'];
// API routes the extension can call with X-Extension-User-Id header (no session required)
const EXTENSION_ALLOWED = ['/api/import', '/api/users'];

function withCors(res: NextResponse, origin: string) {
  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Extension-User-Id');
  return res;
}

export default function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const origin = req.headers.get('origin') ?? '';
  const isExtension = origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');

  // Handle CORS preflight from extension
  if (req.method === 'OPTIONS' && isExtension) {
    return withCors(new NextResponse(null, { status: 204 }), origin);
  }

  // Extension requests to allowed routes pass through with CORS headers
  if (isExtension && EXTENSION_ALLOWED.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    const res = NextResponse.next();
    return withCors(res, origin);
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
