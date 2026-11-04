import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { dealItemsFor, BfmrNotConfiguredError } from '@/lib/bfmrDeals';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return new Response('Missing slug', { status: 400 });

  const userId = await getSessionUserId();
  try {
    return Response.json(await dealItemsFor(userId ?? null, slug));
  } catch (e) {
    if (e instanceof BfmrNotConfiguredError) return new Response(e.message, { status: 400 });
    return new Response(String(e), { status: 502 });
  }
}
