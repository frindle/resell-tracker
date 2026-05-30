import { NextRequest, NextResponse } from 'next/server';

const PUBLIC = ['/login', '/api/auth'];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isPublic = PUBLIC.some(p => pathname === p || pathname.startsWith(p + '/'));
  if (isPublic) return NextResponse.next();

  const uid = req.cookies.get('resell_uid')?.value;
  if (!uid) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
