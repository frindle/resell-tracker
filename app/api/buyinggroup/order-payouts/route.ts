import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

// Returns map of normalized tracking number → salePrice for all BuyingGroup orders
export async function GET() {
  try {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const orders = await prisma.order.findMany({
    where: {
      ...(uid ? { userId: uid } : { userId: null }),
      trackingNumbers: { not: null },
      salePrice: { not: null },
      buyer: { OR: [{ name: { contains: 'BuyingGroup' } }, { name: { contains: 'BFMR' } }] },
    },
    select: { trackingNumbers: true, salePrice: true, bgExpectedPayout: true },
  });

  // Map normalized tracking → salePrice for the whole order
  // The page sums BG receipt totals across all trackings on an order and compares to salePrice
  const result: Record<string, number> = {};
  for (const o of orders) {
    const payout = o.bgExpectedPayout ?? o.salePrice;
    if (!o.trackingNumbers || payout == null) continue;
    for (const t of o.trackingNumbers.split(',').map(s => s.trim().replace(/\D/g, '')).filter(Boolean)) {
      result[t] = (result[t] ?? 0) + payout;
    }
  }
  return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
