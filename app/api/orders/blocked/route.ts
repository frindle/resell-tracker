import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Lists orders that were quarantined at import time because their shipping
// address matched a BlockedAddress pattern. Surfaces the matching pattern
// so the user can decide whether to allow or delete.
export async function GET() {
  const uid = await getSessionUserId();
  const orders = await prisma.order.findMany({
    where: { userId: uid ?? null, blockedAddressPattern: { not: null } },
    include: { buyer: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return Response.json(orders);
}

// POST { ids: number[], action: 'allow' | 'delete' }
// allow:  clears blockedAddressPattern + ignoredByRule so the order joins
//         the regular /orders list
// delete: removes the orders entirely
export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const { ids, action } = await req.json() as { ids?: number[]; action?: 'allow' | 'delete' };
  if (!Array.isArray(ids) || ids.length === 0) {
    return Response.json({ error: 'ids required' }, { status: 400 });
  }
  if (action !== 'allow' && action !== 'delete') {
    return Response.json({ error: 'action must be allow or delete' }, { status: 400 });
  }

  if (action === 'allow') {
    const { count } = await prisma.order.updateMany({
      where: { id: { in: ids }, userId: uid, blockedAddressPattern: { not: null } },
      data: { blockedAddressPattern: null, ignoredByRule: false },
    });
    return Response.json({ allowed: count });
  }

  const { count } = await prisma.order.deleteMany({
    where: { id: { in: ids }, userId: uid, blockedAddressPattern: { not: null } },
  });
  return Response.json({ deleted: count });
}
