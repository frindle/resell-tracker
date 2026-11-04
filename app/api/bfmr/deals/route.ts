import { getSessionUserId } from '@/lib/auth';
import { dealsFor, BfmrNotConfiguredError } from '@/lib/bfmrDeals';

export const dynamic = 'force-dynamic';

export async function GET() {
  const userId = await getSessionUserId();
  try {
    return Response.json(await dealsFor(userId ?? null));
  } catch (e) {
    if (e instanceof BfmrNotConfiguredError) return new Response(e.message, { status: 400 });
    return new Response(String(e), { status: 502 });
  }
}
