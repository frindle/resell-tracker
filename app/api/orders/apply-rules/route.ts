import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

export async function POST() {
  try {
  const userId = await getSessionUserId();
  const userFilter = userId ? { userId } : { userId: null };

  const [orders, rules] = await Promise.all([
    prisma.order.findMany({
      where: { ...userFilter, buyerId: null, shippingAddress: { not: null } },
      select: { id: true, shippingAddress: true },
    }),
    prisma.shippingRule.findMany({
      where: { ...userFilter, buyerId: { not: null } },
      select: { pattern: true, buyerId: true },
    }),
  ]);

  let updated = 0;
  for (const order of orders) {
    const addr = order.shippingAddress!.toLowerCase();
    const match = rules.find(r => addr.includes(r.pattern.toLowerCase()));
    if (match?.buyerId) {
      await prisma.order.update({ where: { id: order.id }, data: { buyerId: match.buyerId } });
      updated++;
    }
  }

  return Response.json({ updated, scanned: orders.length });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
