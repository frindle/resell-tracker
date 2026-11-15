import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { ordersForTracking } from '@/lib/bigskyCommitments';
import type { BigSkyFulfillment } from '@/lib/bigskyCommitments';

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

function fulfillmentsOf(json: string): BigSkyFulfillment[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// The user's synced BigSky commitments, each fulfillment with the tracker
// orders that carry its tracking number.
export async function GET() {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const rows = await prisma.bigSkyCommitment.findMany({
    where: { userId: uid },
    orderBy: [{ dealExpiration: 'desc' }, { id: 'asc' }],
  });

  // Only orders placed from 60 days before the oldest commitment can have
  // filled one; this keeps the tracking comparison small.
  const starts = rows.map(r => (r.creationDate ?? r.dealCreated)?.getTime()).filter((t): t is number => t != null);
  const since = starts.length ? new Date(Math.min(...starts) - 60 * DAY_MS) : null;
  const orders = rows.length === 0 ? [] : await prisma.order.findMany({
    where: { userId: uid, trackingNumbers: { not: null }, ...(since ? { orderDate: { gte: since } } : {}) },
    select: { id: true, orderNumber: true, platform: true, orderDate: true, trackingNumbers: true, cost: true, itemDescription: true },
    orderBy: { orderDate: 'asc' },
  });

  const commitments = rows.map(r => {
    const fulfillments = fulfillmentsOf(r.fulfillments).map(f => ({
      id: f.id,
      quantity: f.quantity,
      date: f.date,
      trackingNumbers: f.trackingNumbers ?? [],
      orders: ordersForTracking(orders, f.trackingNumbers ?? []).map(o => ({
        id: o.id,
        orderNumber: o.orderNumber,
        platform: o.platform,
        orderDate: o.orderDate.toISOString(),
        cost: o.cost,
        itemDescription: o.itemDescription,
      })),
    }));
    return {
      id: r.id,
      commitmentId: r.commitmentId,
      dealId: r.dealId,
      itemName: r.itemName,
      itemUpc: r.itemUpc,
      dealPrice: r.dealPrice,
      commitmentAmount: r.commitmentAmount,
      fulfilled: r.fulfilled,
      commitmentsRemaining: r.commitmentsRemaining,
      status: r.status,
      dealExpiration: r.dealExpiration?.toISOString() ?? null,
      creationDate: r.creationDate?.toISOString() ?? null,
      fulfillmentDate: r.fulfillmentDate?.toISOString() ?? null,
      lastSyncedAt: r.lastSyncedAt.toISOString(),
      fulfillments,
      unmatchedUnits: fulfillments.filter(f => f.orders.length === 0).reduce((s, f) => s + f.quantity, 0),
    };
  });

  return Response.json({ commitments });
}
