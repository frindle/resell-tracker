import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// List the user's synced commitments. Includes linked orders + assigned
// quantities so the page can show "assigned / committed" at a glance.
export async function GET() {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const rows = await prisma.buyingGroupCommitment.findMany({
    where: { userId: uid },
    orderBy: [{ status: 'asc' }, { expiryDay: 'asc' }],
    include: {
      orderLinks: {
        include: {
          order: { select: { id: true, orderNumber: true, platform: true, orderDate: true, trackingNumbers: true, cost: true } },
        },
      },
    },
  });

  const commitments = rows.map(c => {
    const assigned = c.orderLinks.reduce((s, l) => s + l.quantity, 0);
    const remaining = Math.max(0, c.count - c.fulfilled - assigned);
    const isShort = c.status === 'ACTIVE' && remaining > 0 && !!c.expiryDay && c.expiryDay.getTime() > Date.now();
    return {
      id: c.id,
      commitmentId: c.commitmentId,
      dealId: c.dealId,
      dealTitle: c.dealTitle,
      itemImage: c.itemImage,
      count: c.count,
      fulfilled: c.fulfilled,
      assigned,
      remaining,
      isShort,
      expiryDay: c.expiryDay?.toISOString() ?? null,
      price: c.price,
      commission: c.commission,
      total: c.total,
      status: c.status,
      lastSyncedAt: c.lastSyncedAt.toISOString(),
      orderLinks: c.orderLinks.map(l => ({
        id: l.id,
        quantity: l.quantity,
        order: l.order,
      })),
    };
  });

  return Response.json({ commitments });
}
