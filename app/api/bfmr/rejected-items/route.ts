import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

// Returns map of orderNumber → rejected items for orders with bfmrRejectedItems set
export async function GET() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const orders = await prisma.order.findMany({
    where: {
      ...(uid ? { userId: uid } : { userId: null }),
      bfmrRejectedItems: { not: null },
      orderNumber: { not: null },
    },
    select: { orderNumber: true, bfmrRejectedItems: true },
  });

  const result: Record<string, { name: string; reason: string }[]> = {};
  for (const o of orders) {
    if (!o.orderNumber || !o.bfmrRejectedItems) continue;
    try {
      result[o.orderNumber] = JSON.parse(o.bfmrRejectedItems);
    } catch { /* skip malformed */ }
  }
  return Response.json(result);
}
