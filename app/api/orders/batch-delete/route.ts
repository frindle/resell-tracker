import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const { ids } = await req.json() as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) return new Response('ids required', { status: 400 });
  const { count } = await prisma.order.deleteMany({
    where: { id: { in: ids }, ...(userId ? { userId } : { userId: null }) },
  });
  return Response.json({ deleted: count });
}
