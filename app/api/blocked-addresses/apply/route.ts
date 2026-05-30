import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

export async function POST() {
  const userId = await getSessionUserId();

  const [blockedPatterns, orders] = await Promise.all([
    prisma.blockedAddress.findMany({ select: { pattern: true } }),
    prisma.order.findMany({
      where: {
        ...(userId ? { userId } : { userId: null }),
        platform: { in: ['Walmart', 'Amazon'] },
        skipAddressBlock: false,
        ignoredByRule: false,
      },
      select: { id: true, shippingAddress: true },
    }),
  ]);

  if (!blockedPatterns.length) return Response.json({ flagged: 0 });

  const toFlag = orders
    .filter(o => {
      if (!o.shippingAddress) return false;
      const lower = o.shippingAddress.toLowerCase();
      return blockedPatterns.some(b => lower.includes(b.pattern.toLowerCase()));
    })
    .map(o => o.id);

  if (toFlag.length) {
    await prisma.order.updateMany({
      where: { id: { in: toFlag } },
      data: { ignoredByRule: true },
    });
  }

  return Response.json({ flagged: toFlag.length });
}
