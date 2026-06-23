import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Returns recent sync events (newest first) with per-order change details.
// Query params:
//   limit:    number of events (default 50, max 200)
//   platform: optional filter ('Amazon', 'Walmart', etc.)
//   event:    specific event id — returns just that one (with detail)
export async function GET(req: NextRequest) {
  const uid = await getSessionUserId();

  const url = new URL(req.url);
  const eventParam = url.searchParams.get('event');
  const platform = url.searchParams.get('platform');
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50')));

  if (eventParam) {
    const id = parseInt(eventParam);
    if (isNaN(id)) return Response.json({ error: 'invalid event id' }, { status: 400 });
    const event = await prisma.syncEvent.findFirst({
      where: { id, userId: uid ?? null },
      include: { orderChanges: { orderBy: { id: 'asc' } } },
    });
    if (!event) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(event);
  }

  const events = await prisma.syncEvent.findMany({
    where: { userId: uid ?? null, ...(platform ? { platform } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { orderChanges: { orderBy: { id: 'asc' } } },
  });
  return Response.json(events);
}
