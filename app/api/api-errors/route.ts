import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

    const url = new URL(req.url);
    const group = url.searchParams.get('group');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '200'), 1000);

    const errors = await prisma.apiError.findMany({
      where: { userId, ...(group ? { group } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return Response.json({ errors });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// Bulk-clear (handy when you've fixed something and want to start fresh)
export async function DELETE(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
    const url = new URL(req.url);
    const group = url.searchParams.get('group');
    const { count } = await prisma.apiError.deleteMany({
      where: { userId, ...(group ? { group } : {}) },
    });
    return Response.json({ cleared: count });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
