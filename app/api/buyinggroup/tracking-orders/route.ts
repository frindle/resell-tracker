import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

// Returns map of normalized tracking → [{id, itemDescription, salePrice, bgExpectedPayout}]
// for orders assigned to BuyingGroup or BFMR buyers
export async function GET() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const orders = await prisma.order.findMany({
    where: {
      ...(uid ? { userId: uid } : { userId: null }),
      trackingNumbers: { not: null },
      buyer: { OR: [{ name: { contains: 'BuyingGroup' } }, { name: { contains: 'BFMR' } }] },
    },
    select: { id: true, orderNumber: true, itemDescription: true, salePrice: true, bgExpectedPayout: true, trackingNumbers: true },
  });

  const result: Record<string, { id: number; orderNumber: string | null; itemDescription: string | null; salePrice: number | null; bgExpectedPayout: number | null }[]> = {};
  for (const o of orders) {
    if (!o.trackingNumbers) continue;
    for (const t of o.trackingNumbers.split(',').map(s => s.trim().replace(/\D/g, '')).filter(Boolean)) {
      if (!result[t]) result[t] = [];
      result[t].push({ id: o.id, orderNumber: o.orderNumber, itemDescription: o.itemDescription, salePrice: o.salePrice, bgExpectedPayout: o.bgExpectedPayout });
    }
  }
  return Response.json(result);
}
