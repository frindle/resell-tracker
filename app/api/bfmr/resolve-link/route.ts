import { NextRequest } from 'next/server';
import { isHttpUrl } from '@/lib/linkClean';
import { resolveDealLink } from '@/lib/linkResolve';

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('url');
  if (!raw) return new Response('Missing url param', { status: 400 });

  try { new URL(raw); } catch { return new Response('Invalid URL', { status: 400 }); }
  if (!isHttpUrl(raw)) return new Response('Only http/https URLs allowed', { status: 400 });

  return Response.json({ url: await resolveDealLink(raw) });
}
