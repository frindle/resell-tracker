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

  // Map normalized tracking → { salePrice split evenly across all trackings on that order }
  const result: Record<string, number> = {};
  for (const o of orders) {
    if (!o.trackingNumbers || o.salePrice == null) continue;
    const trackings = o.trackingNumbers.split(',').map(s => s.trim().replace(/\D/g, '')).filter(Boolean);
    const perTracking = o.salePrice / trackings.length;
    for (const t of trackings) {
      result[t] = perTracking;
    }
  }
  return Response.json(result);
}
