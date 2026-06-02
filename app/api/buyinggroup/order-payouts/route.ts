import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

// Returns map of normalized tracking number → salePrice for all BuyingGroup orders
export async function GET() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const orders = await prisma.order.findMany({
    where: {
      ...(uid ? { userId: uid } : { userId: null }),
      trackingNumbers: { not: null },
      salePrice: { not: null },
      buyer: { name: { contains: 'BuyingGroup' } },
    },
    select: { trackingNumbers: true, salePrice: true },
  });

  // Map normalized tracking → salePrice for the whole order
  // The page sums BG receipt totals across all trackings on an order and compares to salePrice
  const result: Record<string, number> = {};
  for (const o of orders) {
    if (!o.trackingNumbers || o.salePrice == null) continue;
    for (const t of o.trackingNumbers.split(',').map(s => s.trim().replace(/\D/g, '')).filter(Boolean)) {
      result[t] = (result[t] ?? 0) + o.salePrice;
    }
  }
  return Response.json(result);
}
