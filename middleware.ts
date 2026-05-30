import { NextRequest, NextResponse } from 'next/server';

const PUBLIC = ['/login', '/api/auth', '/api/users'];

export default function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

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
