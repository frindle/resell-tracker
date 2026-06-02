import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

export async function GET() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const orders = await prisma.order.findMany({
    where: {
      ...(uid ? { userId: uid } : { userId: null }),
      salePriceSynced: false,
      trackingNumbers: { not: null },
      buyer: { name: { contains: 'BuyingGroup' } },
    },
    select: {
      id: true,
      orderNumber: true,
      itemDescription: true,
      trackingNumbers: true,
      orderDate: true,
      cost: true,
    },
    orderBy: { orderDate: 'desc' },
  });

  return Response.json(orders);
}
